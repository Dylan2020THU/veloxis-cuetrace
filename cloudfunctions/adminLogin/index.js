const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function fail(code, msg) {
  return { ok: false, code, msg };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeAccount(value) {
  return String(value || '').trim().toLowerCase();
}

function readConfig() {
  const account = String(process.env.CUETRACE_ADMIN_ACCOUNT || '').trim();
  const saltHex = String(process.env.CUETRACE_ADMIN_PASSWORD_SALT || '').trim();
  const hashHex = String(process.env.CUETRACE_ADMIN_PASSWORD_HASH || '').trim().toLowerCase();
  const bootstrapValue = String(process.env.CUETRACE_ADMIN_BOOTSTRAP_OPENIDS || '').trim();
  const validSalt = /^(?:[0-9a-fA-F]{2})+$/.test(saltHex);
  const validHash = /^[0-9a-f]{128}$/.test(hashHex);
  const bootstrapOpenids = bootstrapValue.split(',').map((item) => item.trim()).filter(Boolean);
  if (!account || !validSalt || !validHash || !bootstrapOpenids.length) return null;
  return {
    account,
    accountNormalized: normalizeAccount(account),
    salt: Buffer.from(saltHex, 'hex'),
    hash: Buffer.from(hashHex, 'hex'),
    bootstrapOpenids
  };
}

function matchesPassword(password, config) {
  const actual = crypto.scryptSync(String(password || ''), config.salt, 64);
  return actual.length === config.hash.length && crypto.timingSafeEqual(actual, config.hash);
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
  const config = readConfig();
  if (!config) return fail('CONFIG_MISSING', '管理员认证配置缺失');
  const normalized = normalizeAccount(event.account);
  if (
    !OPENID ||
    normalized !== config.accountNormalized ||
    !matchesPassword(event.password, config)
  ) return fail('INVALID_ADMIN', '管理员账号或密码错误');

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
        (
          existingAdmin._id !== adminDocId ||
          existingAdmin._openid !== OPENID ||
          normalizeAccount(existingAdmin.account) !== normalized
        )
      ) {
        throw authError('WECHAT_ALREADY_BOUND');
      }
      if (
        existingAccountLock &&
        (existingAccountLock._openid !== OPENID || normalizeAccount(existingAccountLock.account) !== normalized)
      ) {
        throw authError('ACCOUNT_ALREADY_BOUND');
      }

      if (!!existingAdmin !== !!existingAccountLock) {
        throw authError('BINDING_INCONSISTENT');
      }
      if (existingAdmin && existingAdmin.status !== 'active') {
        throw authError('ADMIN_INACTIVE');
      }
      if (existingAdmin) return;
      if (config.bootstrapOpenids.indexOf(OPENID) === -1) {
        throw authError('OPENID_NOT_ALLOWED');
      }

      const now = db.serverDate();
      await adminRef.set({
        data: {
          _id: adminDocId,
          _openid: OPENID,
          account: config.account,
          accountNormalized: normalized,
          status: 'active',
          createdAt: now,
          updatedAt: now
        }
      });
      await accountLockRef.set({
        data: {
          _id: accountLockId,
          _openid: OPENID,
          account: config.account,
          accountNormalized: normalized,
          createdAt: now,
          updatedAt: now
        }
      });
    });
  } catch (error) {
    if (error && error.authCode === 'ACCOUNT_ALREADY_BOUND') return fail(error.authCode, '管理员账号已绑定其他微信');
    if (error && error.authCode === 'WECHAT_ALREADY_BOUND') return fail(error.authCode, '当前微信已绑定其他管理员账号');
    if (error && error.authCode === 'OPENID_NOT_ALLOWED') return fail(error.authCode, '当前微信不在首次绑定白名单');
    if (error && error.authCode === 'BINDING_INCONSISTENT') return fail(error.authCode, '管理员绑定数据不完整');
    if (error && error.authCode === 'ADMIN_INACTIVE') return fail(error.authCode, '管理员账号已停用');
    throw error;
  }
  return { ok: true, isAdmin: true, account: config.account };
};
