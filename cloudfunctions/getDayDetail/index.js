const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 店家是否可查看某会员：本店管理的教练中，有人给该会员上过课即可
async function shopCanViewMember(shopOpenid, memberOpenid) {
  const shopCoaches = await db
    .collection('shop_coach_links')
    .where({ shopOpenid, status: 'active' })
    .get();
  const coachOpenids = shopCoaches.data.map((l) => l.coachOpenid);
  if (!coachOpenids.length) return false;
  const taught = await db
    .collection('coach_member_links')
    .where({ coachOpenid: _.in(coachOpenids), memberOpenid, status: 'active' })
    .get();
  return taught.data.length > 0;
}

// 校验：当 targetOpenid 与本人不同时，需满足以下任一授权：
// 1) 教练查看自己绑定的会员；2) 店家查看本店教练上过课的会员
async function resolveTargetOpenid(myOpenid, targetOpenid) {
  if (!targetOpenid || targetOpenid === myOpenid) return myOpenid;
  const link = await db
    .collection('coach_member_links')
    .where({ coachOpenid: myOpenid, memberOpenid: targetOpenid, status: 'active' })
    .get();
  if (link.data.length) return targetOpenid;
  if (await shopCanViewMember(myOpenid, targetOpenid)) return targetOpenid;
  throw new Error('无权查看该会员数据');
}

// 返回某一天的训练明细记录。默认本人；教练可传 targetOpenid 查看已绑定会员。
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { dateKey, targetOpenid } = event;

  const isSelf = !targetOpenid || targetOpenid === OPENID;
  const queryOpenid = await resolveTargetOpenid(OPENID, targetOpenid);

  const res = await db
    .collection('training_sessions')
    .where({ _openid: queryOpenid, date: dateKey })
    .orderBy('startTime', 'asc')
    .get();

  let sessions = (res.data || []).map((s) => Object.assign({ kind: 'personal' }, s));

  if (isSelf) {
    const lessonRes = await db
      .collection('coach_lessons')
      .where({ coachOpenid: OPENID, date: dateKey })
      .orderBy('startTime', 'asc')
      .get();
    const lessons = (lessonRes.data || []).map((l) => Object.assign({
      kind: 'coach',
      verified: l.verified !== false,
      hallName: l.hallName || '教学课时'
    }, l));
    sessions = sessions.concat(lessons);
  }

  sessions.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

  return { sessions };
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
