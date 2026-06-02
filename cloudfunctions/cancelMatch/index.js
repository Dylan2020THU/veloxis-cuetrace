const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 删除我发布的约球邀约（仅本人）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { id } = event;
  if (!id) return { ok: false, msg: '缺少邀约 ID' };

  await db
    .collection('matches')
    .where({ _id: id, _openid: OPENID })
    .remove();

  return { ok: true };
};
