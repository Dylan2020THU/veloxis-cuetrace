const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ADMIN_CREDENTIALS = [
  { account: 'admin_zhx', password: '2612694' }
];

function fail(code, msg) {
  return { ok: false, code, msg };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeAccount(value) {
  return String(value || '').trim().toLowerCase();
}

function adminId(openid) {
  return sha256(`admin-openid:${openid}`);
}

function accountBindingId(account) {
  return sha256(`admin-account:${normalizeAccount(account)}`);
}

function authError(code) {
  const error = new Error(code);
  error.authCode = code;
  return error;
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const account = (event.account || '').trim();
  const password = event.password || '';
  const hit = ADMIN_CREDENTIALS.find((item) => item.account === account && item.password === password);
  if (!hit) return fail('INVALID_ADMIN', '管理员账号或密码错误');

  const normalized = normalizeAccount(account);
  try {
    await db.runTransaction(async (transaction) => {
      const adminDocId = adminId(OPENID);
      const accountLockId = accountBindingId(normalized);
      const adminRef = transaction.collection('admins').doc(adminDocId);
      const accountLockRef = transaction.collection('admin_account_bindings').doc(accountLockId);
      const existingAdmin = await getOptional(adminRef);
      const existingAccountLock = await getOptional(accountLockRef);

      if (
        existingAdmin &&
        (existingAdmin._openid !== OPENID || normalizeAccount(existingAdmin.account) !== normalized)
      ) {
        throw authError('WECHAT_ALREADY_BOUND');
      }
      if (
        existingAccountLock &&
        (existingAccountLock._openid !== OPENID || normalizeAccount(existingAccountLock.account) !== normalized)
      ) {
        throw authError('ACCOUNT_ALREADY_BOUND');
      }

      const now = db.serverDate();
      await adminRef.set({
        data: {
          _id: adminDocId,
          _openid: OPENID,
          account,
          accountNormalized: normalized,
          status: 'active',
          createdAt: existingAdmin && existingAdmin.createdAt ? existingAdmin.createdAt : now,
          updatedAt: now
        }
      });
      await accountLockRef.set({
        data: {
          _id: accountLockId,
          _openid: OPENID,
          account,
          accountNormalized: normalized,
          createdAt: existingAccountLock && existingAccountLock.createdAt ? existingAccountLock.createdAt : now,
          updatedAt: now
        }
      });
    });
  } catch (error) {
    if (error && error.authCode === 'ACCOUNT_ALREADY_BOUND') {
      return fail('ACCOUNT_ALREADY_BOUND', '管理员账号已绑定其他微信');
    }
    if (error && error.authCode === 'WECHAT_ALREADY_BOUND') {
      return fail('WECHAT_ALREADY_BOUND', '当前微信已绑定其他管理员账号');
    }
    throw error;
  }
  return { ok: true, isAdmin: true, account };
};
