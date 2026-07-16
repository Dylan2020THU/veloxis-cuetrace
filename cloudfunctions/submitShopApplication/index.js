const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 店主提交 / 重新提交资质申请（营业执照 + 关键字段）。
// 每个 openid 维护一条申请记录（最新覆盖），提交后状态置为 pending（待审核），并清空上次驳回原因。
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const { ownerPhone, ownerWechat, ownerQQ, ownerEmail, licenseFileID } = event;

  if (!licenseFileID || !ownerPhone) {
    return { ok: false, msg: '请上传营业执照并填写店主联系电话' };
  }

  const patch = {
    ownerPhone: ownerPhone || '',
    ownerWechat: ownerWechat || '',
    ownerQQ: ownerQQ || '',
    ownerEmail: ownerEmail || '',
    licenseFileID: licenseFileID || '',
    status: 'pending',
    reason: '',
    updatedAt: db.serverDate()
  };

  const apps = db.collection('shop_applications');
  // 存在性查询单独容错：集合尚未创建时 .get() 会抛错，此处吞掉并按"无既有申请"继续，
  // 保证首次提交仍能走到 .add()（与 getShopApplicationStatus 的防御写法对齐）。
  let existing = { data: [] };
  try {
    existing = await apps.where({ _openid: OPENID }).get();
  } catch (e) {
    // 集合不存在等 → 视为无既有申请
  }
  try {
    if (existing.data.length) {
      await apps.doc(existing.data[0]._id).update({ data: patch });
      return { ok: true, status: 'pending', _id: existing.data[0]._id };
    }
    const added = await apps.add({
      data: Object.assign({ _openid: OPENID, createdAt: db.serverDate() }, patch)
    });
    return { ok: true, status: 'pending', _id: added._id };
  } catch (err) {
    console.error('submitShopApplication failed', err);
    return { ok: false, msg: '提交失败，请重试' };
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
