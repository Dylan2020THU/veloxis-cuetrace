const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const ACCOUNT_RE = /^[A-Za-z][A-Za-z0-9_]{3,19}$/;
const RESERVED_ACCOUNTS = ['admin_zhx'];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeAccount(value) {
  return String(value || '').trim().toLowerCase();
}

function accountId(account) {
  return sha256(`account:${normalizeAccount(account)}`);
}

function bindingId(openid) {
  return sha256(`wechat:${openid}`);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex');
}

function verifyPassword(password, account) {
  const actual = Buffer.from(hashPassword(password, account.passwordSalt), 'hex');
  const expected = Buffer.from(account.passwordHash || '', 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function fail(code, msg) {
  return { ok: false, code, msg };
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

function normalizeServerRoles(user) {
  const source = Array.isArray(user && user.roles) ? user.roles : [];
  const roles = source.filter((role) => ['member', 'coach', 'shop'].indexOf(role) !== -1);
  return Array.from(new Set(roles.length ? roles : ['member']));
}

function validateRegistration(account, password) {
  const display = String(account || '').trim();
  const normalized = normalizeAccount(display);
  if (!ACCOUNT_RE.test(display) || RESERVED_ACCOUNTS.indexOf(normalized) !== -1) {
    return fail('INVALID_INPUT', '账号格式不正确或为保留账号');
  }
  if (typeof password !== 'string' || password.length < 6) {
    return fail('INVALID_INPUT', '密码至少 6 位');
  }
  return null;
}

function authResult(account, user) {
  const roles = normalizeServerRoles(user);
  return {
    ok: true,
    account: account.account,
    roles,
    currentRole: user.currentRole || user.role || roles[0],
    wechatBound: true
  };
}

function messageFor(code) {
  const messages = {
    INVALID_INPUT: '账号或密码格式不正确',
    ACCOUNT_EXISTS: '账号已存在，请直接登录',
    INVALID_CREDENTIALS: '账号或密码错误',
    WECHAT_NOT_BOUND: '当前微信尚未绑定账号',
    ACCOUNT_NOT_BOUND: '账号绑定信息不完整，请重新登录',
    WECHAT_ALREADY_BOUND: '当前微信已绑定其他账号',
    ACCOUNT_ALREADY_BOUND: '该账号已绑定其他微信',
    ACCOUNT_DISABLED: '账号已停用'
  };
  return messages[code] || '认证失败';
}

function defaultMember(bindingDocId, openid) {
  return {
    _id: bindingDocId,
    _openid: openid,
    roles: ['member'],
    currentRole: 'member',
    role: 'member',
    nickname: '',
    avatar: '',
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  };
}

async function register(event, context) {
  const invalid = validateRegistration(event.account, event.password);
  if (invalid) return invalid;

  const { OPENID, UNIONID } = context;
  const normalized = normalizeAccount(event.account);
  const displayAccount = String(event.account || '').trim();
  const accountDocId = accountId(normalized);
  const bindingDocId = bindingId(OPENID);

  return db.runTransaction(async (transaction) => {
    const accountRef = transaction.collection('accounts').doc(accountDocId);
    const bindingRef = transaction.collection('wechat_bindings').doc(bindingDocId);
    const userRef = transaction.collection('users').doc(bindingDocId);
    const existingAccount = await getOptional(accountRef);
    const existingBinding = await getOptional(bindingRef);
    if (existingAccount) throw authError('ACCOUNT_EXISTS');
    if (existingBinding) throw authError('WECHAT_ALREADY_BOUND');

    const salt = crypto.randomBytes(16).toString('hex');
    const accountData = {
      _id: accountDocId,
      _openid: OPENID,
      account: displayAccount,
      accountNormalized: normalized,
      passwordAlgorithm: 'scrypt-v1',
      passwordSalt: salt,
      passwordHash: hashPassword(event.password, salt),
      status: 'active',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
      boundAt: db.serverDate()
    };
    const bindingData = {
      _id: bindingDocId,
      _openid: OPENID,
      accountId: accountDocId,
      account: displayAccount,
      unionidHash: UNIONID ? sha256(`unionid:${UNIONID}`) : '',
      boundAt: db.serverDate(),
      updatedAt: db.serverDate()
    };
    const defaultMemberData = defaultMember(bindingDocId, OPENID);

    await accountRef.set({ data: accountData });
    await bindingRef.set({ data: bindingData });
    await userRef.set({ data: defaultMemberData });
    return authResult(accountData, defaultMemberData);
  });
}

async function resolveWechatAccount(openid) {
  const bindingDocId = bindingId(openid);
  const binding = await getOptional(db.collection('wechat_bindings').doc(bindingDocId));
  if (!binding) throw authError('WECHAT_NOT_BOUND');
  if (!binding.accountId || binding._openid !== openid) throw authError('ACCOUNT_NOT_BOUND');

  const account = await getOptional(db.collection('accounts').doc(binding.accountId));
  if (!account || account._openid !== openid) throw authError('ACCOUNT_NOT_BOUND');
  if (account.status !== 'active') throw authError('ACCOUNT_DISABLED');

  const user = await getOptional(db.collection('users').doc(bindingDocId));
  if (!user || user._openid !== openid) throw authError('ACCOUNT_NOT_BOUND');
  return { account, user };
}

async function passwordLogin(event, context) {
  const normalized = normalizeAccount(event.account);
  const accountDocId = accountId(normalized);
  const account = await getOptional(db.collection('accounts').doc(accountDocId));
  if (!account || typeof event.password !== 'string' || !verifyPassword(event.password, account)) {
    throw authError('INVALID_CREDENTIALS');
  }
  if (account.status !== 'active') throw authError('ACCOUNT_DISABLED');

  const { OPENID, UNIONID } = context;
  const bindingDocId = bindingId(OPENID);
  const binding = await getOptional(db.collection('wechat_bindings').doc(bindingDocId));
  if (account._openid && account._openid !== OPENID) throw authError('ACCOUNT_ALREADY_BOUND');
  if (binding && binding.accountId !== accountDocId) throw authError('WECHAT_ALREADY_BOUND');
  if (binding && binding._openid !== OPENID) throw authError('ACCOUNT_NOT_BOUND');

  if (account._openid === OPENID && binding && binding.accountId === accountDocId) {
    const user = await getOptional(db.collection('users').doc(bindingDocId));
    if (!user || user._openid !== OPENID) throw authError('ACCOUNT_NOT_BOUND');
    return authResult(account, user);
  }
  if (account._openid || binding) throw authError('ACCOUNT_NOT_BOUND');

  return db.runTransaction(async (transaction) => {
    const accountRef = transaction.collection('accounts').doc(accountDocId);
    const bindingRef = transaction.collection('wechat_bindings').doc(bindingDocId);
    const userRef = transaction.collection('users').doc(bindingDocId);
    const currentAccount = await getOptional(accountRef);
    const currentBinding = await getOptional(bindingRef);
    if (!currentAccount || !verifyPassword(event.password, currentAccount)) {
      throw authError('INVALID_CREDENTIALS');
    }
    if (currentAccount.status !== 'active') throw authError('ACCOUNT_DISABLED');
    if (currentAccount._openid && currentAccount._openid !== OPENID) {
      throw authError('ACCOUNT_ALREADY_BOUND');
    }
    if (currentBinding && currentBinding.accountId !== accountDocId) {
      throw authError('WECHAT_ALREADY_BOUND');
    }
    if (currentAccount._openid || currentBinding) throw authError('ACCOUNT_NOT_BOUND');

    const bindingData = {
      _id: bindingDocId,
      _openid: OPENID,
      accountId: accountDocId,
      account: currentAccount.account,
      unionidHash: UNIONID ? sha256(`unionid:${UNIONID}`) : '',
      boundAt: db.serverDate(),
      updatedAt: db.serverDate()
    };
    const userData = defaultMember(bindingDocId, OPENID);
    const updatedAccount = Object.assign({}, currentAccount, {
      _openid: OPENID,
      boundAt: db.serverDate(),
      updatedAt: db.serverDate()
    });
    await accountRef.update({ data: {
      _openid: OPENID,
      boundAt: updatedAccount.boundAt,
      updatedAt: updatedAccount.updatedAt
    } });
    await bindingRef.set({ data: bindingData });
    await userRef.set({ data: userData });
    return authResult(updatedAccount, userData);
  });
}

async function wechatLogin(event, context) {
  const resolved = await resolveWechatAccount(context.OPENID);
  return authResult(resolved.account, resolved.user);
}

async function status(event, context) {
  const resolved = await resolveWechatAccount(context.OPENID);
  return Object.assign(authResult(resolved.account, resolved.user), {
    passwordSet: true,
    phone: resolved.user.phone || ''
  });
}

const handlers = {
  probe: async () => ({ ok: true, cloudReady: true }),
  register,
  passwordLogin,
  wechatLogin,
  status
};

exports.main = async (event = {}) => {
  const action = event.action;
  if (!Object.prototype.hasOwnProperty.call(handlers, action)) {
    return fail('INVALID_INPUT', '不支持的认证操作');
  }

  try {
    const { OPENID, UNIONID } = cloud.getWXContext();
    if (!OPENID) throw new Error('Missing OPENID');
    return await handlers[action](event, { OPENID, UNIONID });
  } catch (error) {
    if (error && error.authCode) return fail(error.authCode, messageFor(error.authCode));
    console.error('accountAuth failed', error);
    return fail('AUTH_INTERNAL_ERROR', '认证服务异常，请稍后重试');
  }
};
