const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 官方样板数据：作为线上常驻的"大川激流·旗舰店"展示。
// 使用固定 test openid 与正式 openid 区分；真实店主建店时不会与本条冲突。
const SEED_BRAND = {
  _id: 'seed_brand_dachuan',
  _openid: 'ot_test_dachuan_official',
  name: '大川激流',
  logo: '',
  isSeed: true,
  createdAt: new Date('2025-01-01T00:00:00.000Z')
};

const SEED_STORE = {
  _id: 'seed_store_dachuan_flag',
  _openid: 'ot_test_dachuan_official',
  brandId: 'seed_brand_dachuan',
  name: '大川激流·旗舰店',
  address: '北京·朝阳区国贸 CBD 中心',
  cover: '',
  region: '北京',
  lat: 39.908,
  lng: 116.404,
  checkinEnabled: true,
  isSeed: true,
  tableTypes: [
    { name: '乔氏金腿', pricePerHour: 78, bgColor: '#067ef9' },
    { name: '乔氏银腿', pricePerHour: 68, bgColor: '#3b82f6' },
    { name: '美洲豹', pricePerHour: 58, bgColor: '#10b981' }
  ],
  createdAt: new Date('2025-01-01T00:00:00.000Z')
};

exports.main = async (event) => {
  const { brandId } = event || {};
  const query = db.collection('stores');
  const q = brandId ? query.where({ brandId }) : query;
  const res = await q.orderBy('createdAt', 'asc').limit(200).get();
  const stores = res.data || [];

  // 种子门店：与真实数据共存，过滤时按 brandId 一并返回
  if (!brandId || brandId === SEED_STORE.brandId) {
    stores.unshift(SEED_STORE);
  }
  // 决策3（待完善）：到店打卡列表应"仅已订阅且开启打卡"门店。
  // checkinEnabled 已随门店返回，由客户端 getBookableTables 过滤；
  // "已订阅"为店主维度，建议在此 join users 集合按 _openid 取 plan/planExpiresAt，
  // stamp s.subscribed = (plan!=='free' && planExpiresAt>Date.now())，再让客户端按 subscribed && checkinEnabled 过滤。
  return { ok: true, stores };
};

// 供 getBrands 共用的种子品牌
exports.SEED_BRAND = SEED_BRAND;
