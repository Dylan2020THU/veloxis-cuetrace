const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 教练绑定一名会员。memberOpenid 为会员的 openid（可由会员出示二维码/编码获得）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { memberOpenid } = event;

  if (!memberOpenid) return { ok: false, msg: '缺少 memberOpenid' };
  if (memberOpenid === OPENID) return { ok: false, msg: '不能绑定自己' };

  const links = db.collection('coach_member_links');
  const existing = await links
    .where({ coachOpenid: OPENID, memberOpenid })
    .get();

  if (existing.data.length) {
    return { ok: true, msg: '已绑定', id: existing.data[0]._id };
  }

  const res = await links.add({
    data: {
      coachOpenid: OPENID,
      memberOpenid,
      status: 'active',
      createdAt: db.serverDate()
    }
  });
  return { ok: true, id: res._id };
};
