const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const VALID_ROLES = ['member', 'coach', 'shop'];

// 读取当前用户在某角色下的计费状态：{ firstLoginAt, plan, term, planExpiresAt }
// per_role 优先；缺省时回退到顶层字段（兼容老数据）
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const role = VALID_ROLES.indexOf(event.role) !== -1 ? event.role : '';
  console.log('[getUserBilling] event=', event, 'OPENID=', OPENID, 'role=', role);

  try {
    const res = await db.collection('users').where({ _openid: OPENID }).get();
    if (!res.data.length) {
      return {
        ok: true,
        billing: { firstLoginAt: 0, plan: 'free', term: 1, planExpiresAt: 0, role }
      };
    }
    const u = res.data[0];
    const perRole = (u.per_role && u.per_role[role]) || {};
    return {
      ok: true,
      billing: {
        firstLoginAt: u.firstLoginAt || 0,
        plan: perRole.plan || 'free',
        term: perRole.term || 1,
        period: perRole.period || 'year',
        paymentMode: perRole.paymentMode || 'one_time',
        planExpiresAt: perRole.planExpiresAt || 0,
        subscription: perRole.subscription || null,
        role
      }
    };
  } catch (err) {
    console.error('getUserBilling failed', err);
    return {
      ok: true,
      billing: { firstLoginAt: 0, plan: 'free', term: 1, planExpiresAt: 0, role }
    };
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
