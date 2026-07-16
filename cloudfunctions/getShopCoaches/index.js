const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 返回当前店家已管理的教练列表（附带教练资料）
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();

  const linkRes = await db
    .collection('shop_coach_links')
    .where({ shopOpenid: OPENID, status: 'active' })
    .get();

  const coachOpenids = linkRes.data.map((l) => l.coachOpenid);
  if (!coachOpenids.length) return { coaches: [] };

  const coachRes = await db
    .collection('coaches')
    .where({ _openid: _.in(coachOpenids) })
    .get();

  const map = {};
  coachRes.data.forEach((c) => {
    map[c._openid] = c;
  });

  const coaches = linkRes.data.map((link) =>
    Object.assign(
      {
        openid: link.coachOpenid,
        hallId: link.storeId || '',
        hallName: link.storeName || '',
        linkId: link._id
      },
      map[link.coachOpenid] || { nickname: '教练' },
      {
        hallId: link.storeId || (map[link.coachOpenid] && map[link.coachOpenid].hallId) || '',
        hallName: link.storeName || (map[link.coachOpenid] && map[link.coachOpenid].hallName) || ''
      }
    )
  );

  return { coaches };
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
