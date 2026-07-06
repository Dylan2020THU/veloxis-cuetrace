const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function unique(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

function put(map, openid, data) {
  if (!openid) return;
  const old = map[openid] || {};
  map[openid] = Object.assign({}, old, data, {
    openid,
    nickname: data.nickname || old.nickname || '',
    avatar: data.avatar || old.avatar || ''
  });
}

// Returns member/coach display profiles visible to the current shop.
// Used by shop hall-status cards to resolve session memberOpenid/coachOpenid
// into nickname/avatar, while preserving legacy members collection entries.
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const visible = {};

  try {
    const legacy = await db.collection('members').where({ _openid: OPENID }).get();
    (legacy.data || []).forEach((m) => {
      const openid = m.openid || m.memberOpenid || m._openid;
      put(visible, openid, {
        role: 'member',
        nickname: m.nickname || '',
        avatar: m.avatar || '',
        level: m.level || ''
      });
    });
  } catch (err) {
    console.warn('getMembers legacy members unavailable', err && err.errCode);
  }

  let sessions = [];
  try {
    const sessionRes = await db
      .collection('sessions')
      .where({ _openid: OPENID, status: 'active' })
      .limit(1000)
      .get();
    sessions = sessionRes.data || [];
  } catch (err) {
    console.warn('getMembers sessions unavailable', err && err.errCode);
  }

  const memberOpenids = unique(sessions.map((s) => s.memberOpenid));
  const coachOpenids = unique(sessions.map((s) => s.coachOpenid));
  const actorOpenids = unique(memberOpenids.concat(coachOpenids));

  if (actorOpenids.length) {
    try {
      const userRes = await db
        .collection('users')
        .where({ _openid: _.in(actorOpenids) })
        .get();
      (userRes.data || []).forEach((u) => {
        put(visible, u._openid, {
          role: u.role || (coachOpenids.indexOf(u._openid) !== -1 ? 'coach' : 'member'),
          nickname: u.nickname || '',
          avatar: u.avatar || ''
        });
      });
    } catch (err) {
      console.warn('getMembers users unavailable', err && err.errCode);
    }
  }

  if (coachOpenids.length) {
    try {
      const coachRes = await db
        .collection('coaches')
        .where({ _openid: _.in(coachOpenids) })
        .get();
      (coachRes.data || []).forEach((c) => {
        put(visible, c._openid, {
          role: 'coach',
          nickname: c.nickname || '',
          avatar: c.avatar || ''
        });
      });
    } catch (err) {
      console.warn('getMembers coaches unavailable', err && err.errCode);
    }
  }

  return { members: Object.keys(visible).map((openid) => visible[openid]) };
};
