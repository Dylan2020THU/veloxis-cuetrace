const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 返回当前教练已绑定的会员列表（附带基础资料）
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();

  const linkRes = await db
    .collection('coach_member_links')
    .where({ coachOpenid: OPENID, status: 'active' })
    .get();

  const memberOpenids = linkRes.data.map((l) => l.memberOpenid);
  if (!memberOpenids.length) return { members: [] };

  let users = [];
  try {
    const userRes = await db
      .collection('users')
      .where({ _openid: _.in(memberOpenids) })
      .get();
    users = userRes.data;
  } catch (err) {
    console.error('load member users failed', err);
  }

  const userMap = {};
  users.forEach((u) => {
    userMap[u._openid] = u;
  });

  const members = memberOpenids.map((openid) => ({
    openid,
    nickname: (userMap[openid] && userMap[openid].nickname) || '会员',
    avatar: (userMap[openid] && userMap[openid].avatar) || ''
  }));

  return { members };
};
