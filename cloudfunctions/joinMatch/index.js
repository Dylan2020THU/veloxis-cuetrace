const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 报名加入一条约球邀约
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { matchId } = event;
  if (!matchId) return { ok: false, msg: '缺少邀约 ID' };

  // 去重：已报名则直接返回
  const exist = await db
    .collection('match_joins')
    .where({ _openid: OPENID, matchId })
    .count();
  if (exist.total > 0) {
    return { ok: true, already: true };
  }

  await db
    .collection('matches')
    .doc(matchId)
    .update({ data: { joinCount: _.inc(1) } });

  // 记录报名快照，便于「报名记录」展示
  const m = await db.collection('matches').doc(matchId).get();
  const d = (m && m.data) || {};
  await db.collection('match_joins').add({
    data: {
      _openid: OPENID,
      matchId,
      authorName: d.authorName || '',
      hallName: d.hallName || '',
      datetime: d.datetime || '',
      gameType: d.gameType || '',
      createdAt: db.serverDate()
    }
  });

  return { ok: true };
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
