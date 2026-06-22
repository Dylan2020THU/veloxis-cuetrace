const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const SEED_BRAND = {
  _id: 'seed_brand_dachuan',
  _openid: 'ot_test_dachuan_official',
  name: '大川激流',
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
