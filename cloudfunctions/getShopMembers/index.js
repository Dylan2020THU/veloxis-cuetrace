const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 统计本店（按店铺所属台球厅）会员的训练打卡天数与训练时长
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();

  const shopRes = await db.collection('shops').where({ _openid: OPENID }).get();
  if (!shopRes.data.length) return { members: [], shop: null };
  const shop = shopRes.data[0];
  const targetStoreId = event.storeId || shop.storeId || shop.hallId || '';
  if (!targetStoreId) return { members: [], shop };

  // 拉取本店台球厅的全部训练记录
  let all = [];
  const pageSize = 1000;
  let skip = 0;
  while (true) {
    const res = await db
      .collection('training_sessions')
      .where({ hallId: targetStoreId })
      .field({ _openid: true, date: true, durationMinutes: true })
      .skip(skip)
      .limit(pageSize)
      .get();
    all = all.concat(res.data);
    if (res.data.length < pageSize) break;
    skip += pageSize;
  }

  // 按会员聚合：打卡天数（去重日期）、训练总时长
  const agg = {};
  all.forEach((s) => {
    if (!agg[s._openid]) agg[s._openid] = { totalMinutes: 0, days: {} };
    agg[s._openid].totalMinutes += s.durationMinutes || 0;
    agg[s._openid].days[s.date] = true;
  });

  const openids = Object.keys(agg);
  let users = [];
  if (openids.length) {
    try {
      const userRes = await db
        .collection('users')
        .where({ _openid: _.in(openids) })
        .get();
      users = userRes.data;
    } catch (err) {
      console.error('load users failed', err);
    }
  }
  const userMap = {};
  users.forEach((u) => {
    userMap[u._openid] = u;
  });

  const members = openids
    .map((openid) => ({
      openid,
      nickname: (userMap[openid] && userMap[openid].nickname) || '会员',
      avatar: (userMap[openid] && userMap[openid].avatar) || '',
      checkinDays: Object.keys(agg[openid].days).length,
      totalMinutes: agg[openid].totalMinutes
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes);

  return { members, shop };
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
