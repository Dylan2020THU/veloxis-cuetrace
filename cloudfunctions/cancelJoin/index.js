const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 取消报名（删除报名记录并将该球局报名数 -1）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { joinId, matchId } = event;
  if (!joinId) return { ok: false, msg: '缺少报名 ID' };

  await db
    .collection('match_joins')
    .where({ _id: joinId, _openid: OPENID })
    .remove();

  if (matchId) {
    try {
      await db
        .collection('matches')
        .doc(matchId)
        .update({ data: { joinCount: _.inc(-1) } });
    } catch (e) {}
  }

  return { ok: true };
};
