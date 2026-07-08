const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 生成门店"到店码"（小程序码，scene = s=<storeId>）。
// 扫码冷启动落到 page，目标页 onLoad(options) 解析 decodeURIComponent(options.scene)。
// 需：1) 已发布/体验版小程序；2) 云函数有 wxacode 调用权限。devtools 模拟器可能失败属正常。
exports.main = async (event) => {
  const { storeId, tableId, tableName, page } = event || {};
  if (!storeId) return { ok: false, msg: '缺少 storeId' };
  try {
    const sceneParts = ['s=' + storeId];
    if (tableId) sceneParts.push('t=' + tableId);
    if (tableName) sceneParts.push('tn=' + encodeURIComponent(tableName));
    const res = await cloud.openapi.wxacode.getUnlimited({
      scene: sceneParts.join('&'),
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
