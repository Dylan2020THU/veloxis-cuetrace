'use strict';

const { TextDecoder } = require('util');
const {
  applyTerminalRefundNotification,
  applyVerifiedRefundNotification
} = require('./lib/table-refund/refund-transition');
const {
  exactNotificationRefund,
  officialTime,
  safeText
} = require('./lib/table-refund/table-refund');

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeJson(rawBody) {
  if (!Buffer.isBuffer(rawBody) && !(rawBody instanceof Uint8Array)) {
    throw new TypeError('verified notification body must be raw bytes');
  }
  let text;
  try {
    text = fatalUtf8.decode(Buffer.from(rawBody));
  } catch (_error) {
    throw new Error('notification body is not valid UTF-8');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    throw new Error('notification body is not valid JSON');
  }
  if (!isPlainObject(parsed)) throw new Error('notification body is malformed');
  return parsed;
}

function response(statusCode) {
  return { statusCode, body: '' };
}

function notificationStatus(envelope) {
  const keys = [
    'id',
    'create_time',
    'resource_type',
    'event_type',
    'summary',
    'resource'
  ];
  const statuses = {
    'REFUND.SUCCESS': 'SUCCESS',
    'REFUND.CLOSED': 'CLOSED',
    'REFUND.ABNORMAL': 'ABNORMAL'
  };
  if (
    !isPlainObject(envelope)
    || Object.keys(envelope).length !== keys.length
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(envelope, key))
    || !safeText(envelope.id, 36)
    || officialTime(envelope.create_time) === null
    || envelope.resource_type !== 'encrypt-resource'
    || !Object.prototype.hasOwnProperty.call(statuses, envelope.event_type)
    || !safeText(envelope.summary, 64)
    || !isPlainObject(envelope.resource)
    || envelope.resource.original_type !== 'refund'
  ) return null;
  return statuses[envelope.event_type];
}

function createNotifyHandler(dependencies) {
  const names = [
    'loadConfig',
    'extractWechatPayEvent',
    'verifyWechatPaySignature',
    'decryptResource',
    'nowSeconds'
  ];
  if (
    !isPlainObject(dependencies)
    || !dependencies.store
    || names.some((name) => typeof dependencies[name] !== 'function')
  ) {
    throw new TypeError('tableRefundNotifyV3 dependencies are invalid');
  }
  const {
    store,
    loadConfig,
    extractWechatPayEvent,
    verifyWechatPaySignature,
    decryptResource,
    nowSeconds
  } = dependencies;

  return async function tableRefundNotifyV3(event) {
    let config;
    let extracted;
    try {
      config = loadConfig();
      extracted = extractWechatPayEvent(event);
      const verified = verifyWechatPaySignature({
        securityHeaders: extracted.headers,
        rawBody: extracted.rawBody,
        platformCertificates: config.platformCertificates,
        nowSeconds: nowSeconds()
      });
      if (verified !== true) throw new Error('notification signature is invalid');
    } catch (_error) {
      return response(400);
    }

    let refund;
    let refundStatus;
    try {
      const envelope = decodeJson(extracted.rawBody);
      refundStatus = notificationStatus(envelope);
      if (!refundStatus) throw new Error('notification envelope is invalid');
      const plaintext = decryptResource({
        resource: envelope.resource,
        apiV3Key: config.apiV3Key
      });
      refund = decodeJson(plaintext);
      if (!exactNotificationRefund(refund, refundStatus)) {
        throw new Error('notification refund resource is invalid');
      }
    } catch (_error) {
      return response(400);
    }

    try {
      const outcome = refundStatus === 'SUCCESS'
        ? await applyVerifiedRefundNotification({ store, refund })
        : await applyTerminalRefundNotification({
            store,
            refund,
            status: refundStatus
          });
      if (
        outcome
        && ['success', 'duplicate', 'mismatch'].includes(outcome.status)
      ) {
        return response(204);
      }
      return response(503);
    } catch (_error) {
      return response(503);
    }
  };
}

let productionHandler = null;

function getProductionHandler() {
  if (productionHandler) return productionHandler;
  const cloud = require('wx-server-sdk');
  const {
    createCloudbaseRefundStore
  } = require('./lib/table-refund/cloudbase-refund-store');
  const { loadWechatPayConfig } = require('./lib/wechatpay-v3/config');
  const {
    decryptResource,
    verifyWechatPaySignature
  } = require('./lib/wechatpay-v3/client');
  const { extractWechatPayEvent } = require('./lib/wechatpay-v3/http-event');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  productionHandler = createNotifyHandler({
    store: createCloudbaseRefundStore(
      cloud.database({ throwOnNotFound: false })
    ),
    loadConfig: () => loadWechatPayConfig(),
    extractWechatPayEvent,
    verifyWechatPaySignature,
    decryptResource,
    nowSeconds: () => Math.floor(Date.now() / 1000)
  });
  return productionHandler;
}

exports.createNotifyHandler = createNotifyHandler;
exports.main = (event) => getProductionHandler()(event);
