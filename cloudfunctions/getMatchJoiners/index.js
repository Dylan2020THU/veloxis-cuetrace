const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event) => {
  const { matchId } = event;
  if (!matchId) return { ok: false, msg: '缺少 matchId' };
  const res = await db.collection('match_joins').where({ matchId }).get();
  return { ok: true, joiners: res.data || [] };
};
