'use strict';

const { TextDecoder } = require('util');

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

function createNotifyHandler(dependencies) {
  const names = [
    'loadConfig',
    'extractWechatPayEvent',
    'verifyWechatPaySignature',
    'decryptResource',
    'nowSeconds',
    'applyVerifiedTransaction'
  ];
  if (
    !isPlainObject(dependencies)
    || !dependencies.store
    || names.some((name) => typeof dependencies[name] !== 'function')
  ) {
    throw new TypeError('tablePayNotifyV3 dependencies are invalid');
  }
  const {
    store,
    loadConfig,
    extractWechatPayEvent,
    verifyWechatPaySignature,
    decryptResource,
    nowSeconds,
    applyVerifiedTransaction
  } = dependencies;

  return async function tablePayNotifyV3(event) {
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

    let transaction;
    try {
      const envelope = decodeJson(extracted.rawBody);
      if (
        envelope.event_type !== 'TRANSACTION.SUCCESS'
        || envelope.resource_type !== 'encrypt-resource'
        || !isPlainObject(envelope.resource)
        || envelope.resource.original_type !== 'transaction'
      ) {
        throw new Error('notification envelope is not a transaction success');
      }
      const plaintext = decryptResource({
        resource: envelope.resource,
        apiV3Key: config.apiV3Key
      });
      transaction = decodeJson(plaintext);
    } catch (_error) {
      return response(400);
    }

    try {
      const outcome = await applyVerifiedTransaction({ store, transaction });
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
  const { createCloudbasePaymentStore } = require('./lib/cloudbase-payment-store');
  const { loadWechatPayConfig } = require('./lib/wechatpay-v3/config');
  const {
    decryptResource,
    verifyWechatPaySignature
  } = require('./lib/wechatpay-v3/client');
  const { extractWechatPayEvent } = require('./lib/wechatpay-v3/http-event');
  const { applyVerifiedTransaction } = require('./lib/payment-transition');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  productionHandler = createNotifyHandler({
    store: createCloudbasePaymentStore(
      cloud.database({ throwOnNotFound: false })
    ),
    loadConfig: () => loadWechatPayConfig(),
    extractWechatPayEvent,
    verifyWechatPaySignature,
    decryptResource,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    applyVerifiedTransaction
  });
  return productionHandler;
}

exports.createNotifyHandler = createNotifyHandler;
exports.main = (event) => getProductionHandler()(event);
