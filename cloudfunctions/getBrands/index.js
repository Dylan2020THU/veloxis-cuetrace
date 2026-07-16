const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const SEED_BRAND = {
  _id: 'seed_brand_dachuan',
  _openid: 'ot_test_dachuan_official',
  name: '强化杆迹',
  logo: '',
  isSeed: true,
  createdAt: new Date('2025-01-01T00:00:00.000Z')
};

exports.main = async () => {
  const res = await db.collection('brands').orderBy('createdAt', 'asc').limit(100).get();
  const brands = res.data || [];
  // 种子品牌：常驻展示，不会与真实品牌冲突
  brands.unshift(SEED_BRAND);
  return { ok: true, brands };
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
