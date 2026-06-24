const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 前台：确认 / 拒绝某条到店请求（action: 'confirm' | 'reject'）
exports.main = async (event) => {
  const { requestId, action } = event || {};
  if (!requestId) return { ok: false, msg: '缺少 requestId' };
  await db.collection('checkin_requests').doc(requestId).update({
    data: {
      status: action === 'reject' ? 'rejected' : 'confirmed',
      resolvedAt: Date.now()
    }
  });
  return { ok: true };
};
