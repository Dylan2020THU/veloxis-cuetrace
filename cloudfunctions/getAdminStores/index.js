const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ADMIN_ACCOUNTS = ['admin_zhx'];
const SEED_STORE = {
  _id: 'seed_store_dachuan_flag',
  _openid: 'ot_test_dachuan_official',
  brandId: 'seed_brand_dachuan',
  name: '强化杆迹·旗舰店',
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

async function isAdminOpenid(openid, loginName) {
  if (ADMIN_ACCOUNTS.indexOf(loginName) === -1) return false;
  const res = await db.collection('admins').where({ status: 'active' }).get().catch(() => ({ data: [] }));
  return (res.data || []).some((item) => item._openid === openid && item.account === loginName);
}

async function readCollection(name) {
  const res = await db.collection(name).limit(1000).get().catch(() => ({ data: [] }));
  return res.data || [];
}

function latestApplication(apps, openid) {
  return (apps || [])
    .filter((item) => item._openid === openid)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0] || null;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const loginName = (event.loginName || '').trim();
  if (!(await isAdminOpenid(OPENID, loginName))) {
    return { ok: false, code: 'FORBIDDEN', msg: '无管理员权限', summary: {}, stores: [] };
  }

  const stores = await readCollection('stores');
  const allStores = stores.some((item) => item._id === SEED_STORE._id) ? stores : [SEED_STORE].concat(stores);
  const shops = await readCollection('shops');
  const applications = await readCollection('shop_applications');
  const users = await readCollection('users');
  const shopMap = {};
  const userMap = {};
  shops.forEach((item) => { shopMap[item._openid] = item; });
  users.forEach((item) => { userMap[item._openid] = item; });

  const rows = allStores.map((store) => {
    const ownerOpenid = store._openid || '';
    const app = latestApplication(applications, ownerOpenid);
    const owner = userMap[ownerOpenid] || shopMap[ownerOpenid] || {};
    return {
      storeId: store._id || '',
      storeName: store.name || store.hallName || '未命名门店',
      ownerOpenid,
      ownerName: store.isSeed ? '系统官方' : (owner.nickname || owner.name || owner.loginName || '店主'),
      region: store.region || '',
      address: store.address || '',
      applicationStatus: store.isSeed ? 'approved' : ((app && app.status) || (shopMap[ownerOpenid] ? 'approved' : 'none')),
      checkinEnabled: !!store.checkinEnabled,
      createdAt: store.createdAt || ''
    };
  });

  return {
    ok: true,
    summary: {
      totalStores: rows.length,
      approvedStores: rows.filter((item) => item.applicationStatus === 'approved').length,
      pendingApplications: applications.filter((item) => (item.status || 'pending') === 'pending').length,
      rejectedApplications: applications.filter((item) => item.status === 'rejected').length,
      checkinEnabledStores: rows.filter((item) => item.checkinEnabled).length
    },
    stores: rows
  };
};
