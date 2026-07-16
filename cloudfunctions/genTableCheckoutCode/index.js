const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const {
  generateCheckoutToken,
  hashCheckoutToken
} = require('./lib/checkout-token');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const VALID_ROLES = ['member', 'coach', 'shop'];
const MAX_CODE_BYTES = 1024 * 1024;
const CODE_OPTIONS = Object.freeze({
  page: 'pages/table-checkout/index',
  width: 430,
  checkPath: false,
  envVersion: 'release'
});

function bindingId(openid) {
  return crypto.createHash('sha256').update('wechat:' + openid).digest('hex');
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

function notFound() {
  return fail('CHECKOUT_NOT_FOUND', 'Checkout order was not found');
}

function isDocumentId(value) {
  return typeof value === 'string'
    && /^[0-9A-Za-z_-]{1,64}$/.test(value)
    && !value.includes('__');
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

async function requireShopOwner(source, openid) {
  const userId = bindingId(openid);
  const binding = await getOptional(source.collection('wechat_bindings').doc(userId));
  if (
    !binding
    || binding._id !== userId
    || binding._openid !== openid
    || !binding.accountId
    || !binding.account
  ) {
    return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');
  }
  const account = await getOptional(source.collection('accounts').doc(binding.accountId));
  const user = await getOptional(source.collection('users').doc(userId));
  const roles = user && Array.isArray(user.roles)
    ? user.roles.filter((role) => VALID_ROLES.includes(role))
    : [];
  if (
    !account
    || account._id !== binding.accountId
    || account._openid !== openid
    || account.account !== binding.account
    || account.status !== 'active'
    || !user
    || user._id !== userId
    || user._openid !== openid
  ) {
    return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');
  }
  if (!roles.includes('shop')) {
    return fail('SHOP_ROLE_REQUIRED', 'An approved shop role is required');
  }
  return null;
}

function hasValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function hasPlatformPaymentAttempt(order) {
  return hasValue(order.paymentClaim)
    || hasValue(order.paymentAttemptId)
    || hasValue(order.paymentAttemptStatus)
    || hasValue(order.paymentProfileSnapshot)
    || hasValue(order.prepayId)
    || hasValue(order.prepayExpiresAt)
    || hasValue(order.paymentAttemptedAt)
    || hasValue(order.paymentUncertainAt);
}

function isAwaitingOwnedOrder(order, orderId, openid) {
  return !!order
    && order._id === orderId
    && order.orderId === orderId
    && order.schemaVersion === 2
    && order._openid === openid
    && order.shopId === openid
    && order.orderStatus === 'awaiting_payment'
    && order.paymentStatus === 'unpaid'
    && order.splitStatus === 'pending'
    && typeof order.checkoutTokenHash === 'string'
    && /^[0-9a-f]{64}$/.test(order.checkoutTokenHash);
}

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const keys = Object.keys(event).sort();
  if (!isDocumentId(event.orderId)) return null;
  if (keys.length === 2 && keys[0] === 'orderId' && keys[1] === 'token') {
    try {
      return { orderId: event.orderId, token: event.token, rotate: false,
        tokenHash: hashCheckoutToken(event.token) };
    } catch (_error) {
      return null;
    }
  }
  if (
    keys.length === 2
    && keys[0] === 'orderId'
    && keys[1] === 'rotate'
    && event.rotate === true
  ) {
    return { orderId: event.orderId, rotate: true };
  }
  return null;
}

async function renderCode(token) {
  try {
    const result = await cloud.openapi.wxacode.getUnlimited({
      scene: `t=${token}`,
      page: CODE_OPTIONS.page,
      width: CODE_OPTIONS.width,
      checkPath: CODE_OPTIONS.checkPath,
      envVersion: CODE_OPTIONS.envVersion
    });
    const bytes = result && (Buffer.isBuffer(result.buffer)
      || result.buffer instanceof Uint8Array)
      ? Buffer.from(result.buffer)
      : null;
    if (!bytes || bytes.length === 0 || bytes.length > MAX_CODE_BYTES) {
      return fail('CHECKOUT_CODE_FAILED', 'Checkout code could not be generated');
    }
    return {
      ok: true,
      imageBase64: bytes.toString('base64'),
      contentType: 'image/png'
    };
  } catch (_error) {
    return fail('CHECKOUT_CODE_FAILED', 'Checkout code could not be generated');
  }
}

exports.main = async (event = {}) => {
  const input = validateInput(event);
  if (!input) return notFound();
  const { OPENID } = cloud.getWXContext();

  try {
    if (!input.rotate) {
      const authorizationError = await requireShopOwner(db, OPENID);
      if (authorizationError) return authorizationError;
      const order = await getOptional(db.collection('shop_orders').doc(input.orderId));
      if (!order || order._openid !== OPENID || order.shopId !== OPENID) {
        return fail('ORDER_NOT_OWNED', 'Order is not owned by the current shop');
      }
      if (!isAwaitingOwnedOrder(order, input.orderId, OPENID)) return notFound();
      const matches = await db.collection('shop_orders')
        .where({ schemaVersion: 2, checkoutTokenHash: input.tokenHash })
        .limit(2)
        .get();
      if (
        order.checkoutTokenHash !== input.tokenHash
        || !matches
        || !Array.isArray(matches.data)
        || matches.data.length !== 1
        || matches.data[0]._id !== input.orderId
      ) {
        return notFound();
      }
      return renderCode(input.token);
    }

    let rotatedToken = null;
    const result = await db.runTransaction(async (transaction) => {
      const authorizationError = await requireShopOwner(transaction, OPENID);
      if (authorizationError) return authorizationError;
      const orderRef = transaction.collection('shop_orders').doc(input.orderId);
      const order = await getOptional(orderRef);
      if (!order || order._openid !== OPENID || order.shopId !== OPENID) {
        return fail('ORDER_NOT_OWNED', 'Order is not owned by the current shop');
      }
      if (
        !isAwaitingOwnedOrder(order, input.orderId, OPENID)
        || order.payerOpenid !== ''
        || hasPlatformPaymentAttempt(order)
      ) {
        return fail(
          'TOKEN_ROTATION_NOT_ALLOWED',
          'Checkout token cannot be rotated after payment claiming begins'
        );
      }
      if (rotatedToken === null) rotatedToken = generateCheckoutToken();
      await orderRef.update({
        data: {
          checkoutTokenHash: hashCheckoutToken(rotatedToken),
          checkoutTokenRotatedAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      return { ok: true };
    });
    if (!result.ok) return result;
    return renderCode(rotatedToken);
  } catch (_error) {
    return fail('CHECKOUT_CODE_FAILED', 'Checkout code could not be generated');
  }
};

const { guardClientRequest } = require('./lib/auth/protocol-guard');
const protocolGuardedMain = exports.main;

exports.main = async (event = {}, ...args) => {
  const gate = await guardClientRequest({
    db,
    event,
    supportedSchemaVersions: [1]
  });
  if (!gate.ok) return gate;
  let businessEvent = event;
  if (Object.prototype.hasOwnProperty.call(event, 'authProtocol')) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(businessEvent, ...args);
};
