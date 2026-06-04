const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 返回某位教练给哪些会员上过课（即该教练绑定的学员）。
// 仅当请求方（店家）确实在管理该教练时才允许查看。
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { coachOpenid } = event;
  if (!coachOpenid) return { students: [] };

  // 校验：当前店家是否管理该教练
  const manage = await db
    .collection('shop_coach_links')
    .where({ shopOpenid: OPENID, coachOpenid, status: 'active' })
    .get();
  if (!manage.data.length) {
    throw new Error('无权查看该教练学员');
  }

  // 该教练绑定（上过课）的学员
  const linkRes = await db
    .collection('coach_member_links')
    .where({ coachOpenid, status: 'active' })
    .get();

  const memberOpenids = linkRes.data.map((l) => l.memberOpenid);
  if (!memberOpenids.length) return { students: [] };

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

  const students = memberOpenids.map((openid) => ({
    openid,
    nickname: (userMap[openid] && userMap[openid].nickname) || '会员',
    avatar: (userMap[openid] && userMap[openid].avatar) || ''
  }));

  return { students };
};
