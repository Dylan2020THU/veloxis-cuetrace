const cloud = require('wx-server-sdk');
const { buildScene } = require('./scene');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 生成门店"到店码"（小程序码，scene = s=<storeId>）。
// 扫码冷启动落到 page，目标页 onLoad(options) 解析 decodeURIComponent(options.scene)。
// 需：1) 已发布/体验版小程序；2) 云函数有 wxacode 调用权限。devtools 模拟器可能失败属正常。
exports.main = async (event) => {
  const { storeId, tableId, page } = event || {};
  if (!storeId) return { ok: false, msg: '缺少 storeId' };
  try {
    const scene = tableId ? buildScene(storeId, tableId) : 's=' + storeId;
    const res = await cloud.openapi.wxacode.getUnlimited({
      scene,
      page: page || (tableId ? 'pages/table/checkin/index' : 'pages/match/index'),
      checkPath: false,
      envVersion: 'trial',
      width: 430
    });
    const upload = await cloud.uploadFile({
      cloudPath: `checkin-codes/${storeId}${tableId ? '-' + tableId : ''}-${Date.now()}.png`,
      fileContent: res.buffer
    });
    return { ok: true, fileID: upload.fileID };
  } catch (e) {
    return { ok: false, msg: (e && e.errMsg) || 'gen failed' };
  }
};

let protocolDatabase = null;

function getProtocolDatabase() {
  if (protocolDatabase) return protocolDatabase;
  protocolDatabase = cloud.database({ throwOnNotFound: false });
  return protocolDatabase;
}

const db = {
  collection(name) {
    return getProtocolDatabase().collection(name);
  }
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
