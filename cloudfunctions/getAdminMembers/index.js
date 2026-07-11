const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function adminId(openid) {
  return crypto.createHash('sha256').update(`admin-openid:${openid}`).digest('hex');
}

async function isAdminOpenid(openid, loginName) {
  const id = adminId(openid);
  const res = await db.collection('admins').doc(id).get();
  const admin = res && res.data;
  return !!(
    admin &&
    admin._id === id &&
    admin._openid === openid &&
    admin.account === loginName &&
    admin.status === 'active'
  );
}

async function readCollection(name) {
  const res = await db.collection(name).limit(1000).get().catch(() => ({ data: [] }));
  return res.data || [];
}

function toTime(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const loginName = (event.loginName || '').trim();
  if (!(await isAdminOpenid(OPENID, loginName))) {
    return { ok: false, code: 'FORBIDDEN', msg: '无管理员权限', summary: {}, members: [] };
  }

  const users = await readCollection('users');
  const legacyMembers = await readCollection('members');
  const trainings = await readCollection('training_sessions');
  const sessions = await readCollection('sessions');
  const stores = await readCollection('stores');
  const storeMap = {};
  stores.forEach((item) => { storeMap[item._id] = item; });

  const memberOpenids = Array.from(new Set(
    users
      .filter((item) => (item.roles || [item.role || 'member']).indexOf('member') !== -1)
      .map((item) => item._openid)
      .concat(legacyMembers.map((item) => item._openid || item.openid || item.memberOpenid))
      .filter(Boolean)
  ));

  const legacyMap = {};
  legacyMembers.forEach((item) => {
    const openid = item._openid || item.openid || item.memberOpenid;
    if (openid) legacyMap[openid] = item;
  });

  const rows = memberOpenids.map((openid) => {
    const user = users.find((item) => item._openid === openid) || {};
    const legacy = legacyMap[openid] || {};
    const myTrainings = trainings.filter((item) => item._openid === openid || item.memberOpenid === openid);
    const mySessions = sessions.filter((item) => item.memberOpenid === openid);
    const totalMinutes = myTrainings.reduce((sum, item) => sum + (item.durationMinutes || item.totalMinutes || 0), 0);
    const trainingDays = Array.from(new Set(myTrainings.map((item) => item.date).filter(Boolean))).length || legacy.checkinDays || 0;
    const lastTraining = myTrainings
      .slice()
      .sort((a, b) => toTime(b.endedAt || b.createdAt || b.date) - toTime(a.endedAt || a.createdAt || a.date))[0] || {};
    const lastSession = mySessions
      .slice()
      .sort((a, b) => toTime(b.endedAt || b.startedAt || b.createdAt) - toTime(a.endedAt || a.startedAt || a.createdAt))[0] || {};
    const lastStore = storeMap[lastTraining.hallId || lastTraining.storeId || lastSession.storeId] || {};
    return {
      memberOpenid: openid,
      memberName: user.nickname || legacy.nickname || '会员',
      avatar: user.avatar || legacy.avatar || '',
      accountName: user.loginName || user.account || '',
      totalTrainingHours: Number((totalMinutes / 60).toFixed(1)),
      trainingDays,
      lastTrainingAt: lastTraining.endedAt || lastTraining.createdAt || lastTraining.date || lastSession.endedAt || lastSession.startedAt || '',
      lastStoreName: lastStore.name || '',
      createdAt: user.createdAt || legacy.createdAt || ''
    };
  });
  const now = Date.now();
  const dayStart = new Date(new Date().toDateString()).getTime();
  const weekStart = now - 7 * 24 * 60 * 60 * 1000;

  return {
    ok: true,
    summary: {
      totalMembers: rows.length,
      newToday: rows.filter((item) => toTime(item.createdAt) >= dayStart).length,
      newThisWeek: rows.filter((item) => toTime(item.createdAt) >= weekStart).length,
      trainedMembers: rows.filter((item) => item.trainingDays > 0 || item.totalTrainingHours > 0).length,
      activeMembers: rows.filter((item) => toTime(item.lastTrainingAt) >= weekStart).length
    },
    members: rows
  };
};
