const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const ACCOUNT_RE = /^[A-Za-z][A-Za-z0-9_]{3,19}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;
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

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function emailBindingId(email) {
  return sha256(`email:${normalizeEmail(email)}`);
}

function emailCodeId(purpose, email) {
  return sha256(`email-code:${purpose}:${normalizeEmail(email)}`);
}

function hashEmailCode(challengeId, code) {
  const secret = process.env.CUETRACE_EMAIL_CODE_SECRET || '';
  if (!secret) throw authError('EMAIL_NOT_CONFIGURED');
  return crypto.createHmac('sha256', secret).update(`${challengeId}:${code}`).digest('hex');
}

function maskEmail(email) {
  const parts = normalizeEmail(email).split('@');
  const local = parts[0] || '';
  return `${local.slice(0, Math.min(2, local.length))}${'*'.repeat(Math.max(2, local.length - 2))}@${parts[1] || ''}`;
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

function withoutDocumentId(document) {
  const data = Object.assign({}, document || {});
  delete data._id;
  return data;
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
  const currentRole = roles.indexOf(user.currentRole) !== -1
    ? user.currentRole
    : (roles.indexOf(user.role) !== -1 ? user.role : roles[0]);
  return {
    ok: true,
    account: account.account,
    roles,
    currentRole,
    wechatBound: true
  };
}

function isAccountIdentity(account, accountDocId) {
  return !!account &&
    account._id === accountDocId &&
    account.accountNormalized === normalizeAccount(account.account) &&
    accountId(account.account) === accountDocId;
}

function isBindingIdentity(binding, bindingDocId, openid, account) {
  return !!binding &&
    binding._id === bindingDocId &&
    binding._openid === openid &&
    binding.accountId === account._id &&
    binding.account === account.account;
}

function isUserIdentity(user, bindingDocId, openid) {
  return !!user && user._id === bindingDocId && user._openid === openid;
}

function isEmailBindingIdentity(binding, bindingDocId, account, email) {
  const normalized = normalizeEmail(email);
  return !!binding &&
    binding._id === bindingDocId &&
    emailBindingId(normalized) === bindingDocId &&
    binding._openid === account._openid &&
    binding.accountId === account._id &&
    binding.account === account.account &&
    binding.email === normalized &&
    binding.emailNormalized === normalized;
}

function validateRecoveryInput(email, code) {
  if (!EMAIL_RE.test(normalizeEmail(email))) return fail('EMAIL_INVALID', messageFor('EMAIL_INVALID'));
  if (!CODE_RE.test(String(code || ''))) return fail('EMAIL_CODE_INVALID', messageFor('EMAIL_CODE_INVALID'));
  return null;
}

function hashesMatch(actual, expected) {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/i.test(actual)) return false;
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

async function validateEmailChallenge(challengeRef, challenge, expected, expectedCodeHash) {
  if (!challenge ||
    challenge._id !== expected._id ||
    challenge.purpose !== expected.purpose ||
    challenge.accountId !== expected.accountId ||
    challenge.emailBindingId !== expected.emailBindingId
  ) {
    return fail('EMAIL_CODE_INVALID', messageFor('EMAIL_CODE_INVALID'));
  }
  if (challenge.status === 'locked' || challenge.attemptsLeft <= 0) {
    return fail('EMAIL_CODE_LOCKED', messageFor('EMAIL_CODE_LOCKED'));
  }
  if (challenge.status !== 'active' ||
    !Number.isInteger(challenge.attemptsLeft) ||
    challenge.attemptsLeft > 5
  ) {
    return fail('EMAIL_CODE_INVALID', messageFor('EMAIL_CODE_INVALID'));
  }
  const expiresAt = Number(challenge.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return fail('EMAIL_CODE_INVALID', messageFor('EMAIL_CODE_INVALID'));
  }
  if (expiresAt <= Date.now()) {
    return fail('EMAIL_CODE_EXPIRED', messageFor('EMAIL_CODE_EXPIRED'));
  }
  if (!hashesMatch(challenge.codeHash, expectedCodeHash)) {
    const attemptsLeft = challenge.attemptsLeft - 1;
    const locked = attemptsLeft <= 0;
    await challengeRef.update({ data: {
      attemptsLeft,
      status: locked ? 'locked' : 'active',
      updatedAt: db.serverDate()
    } });
    const code = locked ? 'EMAIL_CODE_LOCKED' : 'EMAIL_CODE_INVALID';
    return fail(code, messageFor(code));
  }
  return null;
}

function messageFor(code) {
  const messages = {
    INVALID_INPUT: '账号或密码格式不正确',
    ACCOUNT_EXISTS: '账号已存在，请直接登录',
    ACCOUNT_NOT_FOUND: '账号未注册',
    INVALID_PASSWORD: '账号密码错误',
    WECHAT_NOT_BOUND: '当前微信尚未绑定账号',
    ACCOUNT_NOT_BOUND: '账号绑定信息不完整，请重新登录',
    WECHAT_ALREADY_BOUND: '当前微信已绑定其他账号',
    ACCOUNT_ALREADY_BOUND: '该账号已绑定其他微信',
    ACCOUNT_DISABLED: '账号已停用',
    ACCOUNT_DELETION_IN_PROGRESS: '账号注销处理中，请稍后重试',
    EMAIL_INVALID: '邮箱格式不正确',
    EMAIL_NOT_BOUND: '邮箱未绑定该账号',
    EMAIL_ALREADY_BOUND: '该邮箱已绑定其他账号',
    EMAIL_CODE_INVALID: '验证码错误',
    EMAIL_CODE_EXPIRED: '验证码已过期，请重新获取',
    EMAIL_CODE_LOCKED: '尝试次数过多，请重新获取',
    EMAIL_NOT_CONFIGURED: '邮件服务尚未配置'
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
    const existingUser = await getOptional(userRef);
    if (existingAccount) throw authError('ACCOUNT_EXISTS');
    if (existingBinding) throw authError('WECHAT_ALREADY_BOUND');
    if (existingUser) throw authError('ACCOUNT_NOT_BOUND');

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

    await accountRef.set({ data: withoutDocumentId(accountData) });
    await bindingRef.set({ data: withoutDocumentId(bindingData) });
    await userRef.set({ data: withoutDocumentId(defaultMemberData) });
    return authResult(accountData, defaultMemberData);
  });
}

async function resolveWechatAccount(openid) {
  const bindingDocId = bindingId(openid);
  const binding = await getOptional(db.collection('wechat_bindings').doc(bindingDocId));
  if (!binding) throw authError('WECHAT_NOT_BOUND');
  if (
    binding._id !== bindingDocId ||
    !binding.accountId ||
    !binding.account ||
    binding._openid !== openid ||
    accountId(binding.account) !== binding.accountId
  ) {
    throw authError('ACCOUNT_NOT_BOUND');
  }

  const account = await getOptional(db.collection('accounts').doc(binding.accountId));
  if (
    !isAccountIdentity(account, binding.accountId) ||
    account._openid !== openid ||
    !isBindingIdentity(binding, bindingDocId, openid, account)
  ) {
    throw authError('ACCOUNT_NOT_BOUND');
  }
  if (account.status !== 'active') throw authError('ACCOUNT_DISABLED');

  const user = await getOptional(db.collection('users').doc(bindingDocId));
  if (!isUserIdentity(user, bindingDocId, openid)) throw authError('ACCOUNT_NOT_BOUND');
  return { account, user };
}

async function passwordLogin(event, context) {
  const normalized = normalizeAccount(event.account);
  const accountDocId = accountId(normalized);
  const account = await getOptional(db.collection('accounts').doc(accountDocId));
  if (!account) throw authError('ACCOUNT_NOT_FOUND');
  if (!isAccountIdentity(account, accountDocId)) throw authError('ACCOUNT_NOT_BOUND');
  if (typeof event.password !== 'string' || !verifyPassword(event.password, account)) {
    throw authError('INVALID_PASSWORD');
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
    if (
      !isBindingIdentity(binding, bindingDocId, OPENID, account) ||
      !isUserIdentity(user, bindingDocId, OPENID)
    ) {
      throw authError('ACCOUNT_NOT_BOUND');
    }
    return authResult(account, user);
  }
  if (account._openid || binding) throw authError('ACCOUNT_NOT_BOUND');

  return db.runTransaction(async (transaction) => {
    const accountRef = transaction.collection('accounts').doc(accountDocId);
    const bindingRef = transaction.collection('wechat_bindings').doc(bindingDocId);
    const userRef = transaction.collection('users').doc(bindingDocId);
    const currentAccount = await getOptional(accountRef);
    const currentBinding = await getOptional(bindingRef);
    const currentUser = await getOptional(userRef);
    if (!currentAccount) throw authError('ACCOUNT_NOT_FOUND');
    if (!isAccountIdentity(currentAccount, accountDocId)) throw authError('ACCOUNT_NOT_BOUND');
    if (typeof event.password !== 'string' || !verifyPassword(event.password, currentAccount)) {
      throw authError('INVALID_PASSWORD');
    }
    if (currentAccount.status !== 'active') throw authError('ACCOUNT_DISABLED');
    if (currentAccount._openid && currentAccount._openid !== OPENID) {
      throw authError('ACCOUNT_ALREADY_BOUND');
    }
    if (currentBinding && currentBinding.accountId !== accountDocId) {
      throw authError('WECHAT_ALREADY_BOUND');
    }
    if (currentUser) throw authError('ACCOUNT_NOT_BOUND');
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
    await bindingRef.set({ data: withoutDocumentId(bindingData) });
    await userRef.set({ data: withoutDocumentId(userData) });
    return authResult(updatedAccount, userData);
  });
}

async function wechatLogin(event, context) {
  const resolved = await resolveWechatAccount(context.OPENID);
  return authResult(resolved.account, resolved.user);
}

async function resetPasswordByWechat(event, context) {
  if (typeof event.password !== 'string' || event.password.length < 6) {
    return fail('INVALID_INPUT', messageFor('INVALID_INPUT'));
  }

  const resolved = await resolveWechatAccount(context.OPENID);
  const accountDocId = resolved.account._id;
  const bindingDocId = bindingId(context.OPENID);
  return db.runTransaction(async (transaction) => {
    const accountRef = transaction.collection('accounts').doc(accountDocId);
    const bindingRef = transaction.collection('wechat_bindings').doc(bindingDocId);
    const userRef = transaction.collection('users').doc(bindingDocId);
    const account = await getOptional(accountRef);
    const binding = await getOptional(bindingRef);
    const user = await getOptional(userRef);
    if (!isAccountIdentity(account, accountDocId) ||
      account._openid !== context.OPENID ||
      !isBindingIdentity(binding, bindingDocId, context.OPENID, account) ||
      !isUserIdentity(user, bindingDocId, context.OPENID)
    ) {
      throw authError('ACCOUNT_NOT_BOUND');
    }
    if (account.status !== 'active') throw authError('ACCOUNT_DISABLED');

    const salt = crypto.randomBytes(16).toString('hex');
    await accountRef.update({ data: {
      passwordAlgorithm: 'scrypt-v1',
      passwordSalt: salt,
      passwordHash: hashPassword(event.password, salt),
      updatedAt: db.serverDate()
    } });
    return { ok: true, account: account.account };
  });
}

async function bindEmail(event, context) {
  const normalizedEmail = normalizeEmail(event.email);
  const invalid = validateRecoveryInput(normalizedEmail, event.code);
  if (invalid) return invalid;

  const newBindingDocId = emailBindingId(normalizedEmail);
  const challengeDocId = emailCodeId('bind', normalizedEmail);
  const expectedCodeHash = hashEmailCode(challengeDocId, event.code);
  const resolved = await resolveWechatAccount(context.OPENID);
  const accountDocId = resolved.account._id;
  const wechatBindingDocId = bindingId(context.OPENID);

  return db.runTransaction(async (transaction) => {
    const accountRef = transaction.collection('accounts').doc(accountDocId);
    const wechatBindingRef = transaction.collection('wechat_bindings').doc(wechatBindingDocId);
    const userRef = transaction.collection('users').doc(wechatBindingDocId);
    const challengeRef = transaction.collection('email_codes').doc(challengeDocId);
    const newBindingRef = transaction.collection('email_bindings').doc(newBindingDocId);
    const account = await getOptional(accountRef);
    const wechatBinding = await getOptional(wechatBindingRef);
    const user = await getOptional(userRef);
    const challenge = await getOptional(challengeRef);
    const existingNewBinding = await getOptional(newBindingRef);

    if (!isAccountIdentity(account, accountDocId) ||
      account._openid !== context.OPENID ||
      !isBindingIdentity(wechatBinding, wechatBindingDocId, context.OPENID, account) ||
      !isUserIdentity(user, wechatBindingDocId, context.OPENID)
    ) {
      throw authError('ACCOUNT_NOT_BOUND');
    }
    if (account.status !== 'active') throw authError('ACCOUNT_DISABLED');
    if (user.deletionStatus === 'purging') {
      throw authError('ACCOUNT_DELETION_IN_PROGRESS');
    }

    const challengeFailure = await validateEmailChallenge(challengeRef, challenge, {
      _id: challengeDocId,
      purpose: 'bind',
      accountId: accountDocId,
      emailBindingId: newBindingDocId
    }, expectedCodeHash);
    if (challengeFailure) return challengeFailure;

    if (existingNewBinding &&
      existingNewBinding.status === 'active' &&
      existingNewBinding.accountId !== accountDocId
    ) {
      throw authError('EMAIL_ALREADY_BOUND');
    }

    const now = db.serverDate();
    if (account.emailBindingId && account.emailBindingId !== newBindingDocId) {
      const oldBindingRef = transaction.collection('email_bindings').doc(account.emailBindingId);
      const oldBinding = await getOptional(oldBindingRef);
      if (!isEmailBindingIdentity(oldBinding, account.emailBindingId, account, oldBinding && oldBinding.email) ||
        oldBinding.status !== 'active'
      ) {
        throw authError('ACCOUNT_NOT_BOUND');
      }
      await oldBindingRef.update({ data: {
        status: 'revoked',
        revokedAt: now,
        updatedAt: now
      } });
    }

    const bindingData = {
      _id: newBindingDocId,
      _openid: context.OPENID,
      accountId: accountDocId,
      account: account.account,
      email: normalizedEmail,
      emailNormalized: normalizedEmail,
      status: 'active',
      boundAt: now,
      updatedAt: now,
      revokedAt: ''
    };
    await newBindingRef.set({ data: withoutDocumentId(bindingData) });
    await accountRef.update({ data: {
      emailBindingId: newBindingDocId,
      emailVerifiedAt: now,
      updatedAt: now
    } });
    await challengeRef.update({ data: {
      status: 'used',
      usedAt: now,
      updatedAt: now
    } });
    return { ok: true };
  });
}

async function resetPasswordByEmail(event) {
  const normalizedEmail = normalizeEmail(event.email);
  const invalid = validateRecoveryInput(normalizedEmail, event.code);
  if (invalid) return invalid;
  if (typeof event.password !== 'string' || event.password.length < 6) {
    return fail('INVALID_INPUT', messageFor('INVALID_INPUT'));
  }

  const accountDocId = accountId(event.account);
  const emailBindingDocId = emailBindingId(normalizedEmail);
  const challengeDocId = emailCodeId('reset', normalizedEmail);
  const expectedCodeHash = hashEmailCode(challengeDocId, event.code);

  return db.runTransaction(async (transaction) => {
    const accountRef = transaction.collection('accounts').doc(accountDocId);
    const emailBindingRef = transaction.collection('email_bindings').doc(emailBindingDocId);
    const challengeRef = transaction.collection('email_codes').doc(challengeDocId);
    const account = await getOptional(accountRef);
    const emailBinding = await getOptional(emailBindingRef);
    const challenge = await getOptional(challengeRef);
    if (!account) throw authError('ACCOUNT_NOT_FOUND');
    if (!isAccountIdentity(account, accountDocId) || !account._openid) {
      throw authError('ACCOUNT_NOT_BOUND');
    }
    if (account.status !== 'active') throw authError('ACCOUNT_DISABLED');

    const wechatBindingDocId = bindingId(account._openid);
    const wechatBinding = await getOptional(
      transaction.collection('wechat_bindings').doc(wechatBindingDocId)
    );
    const user = await getOptional(transaction.collection('users').doc(wechatBindingDocId));
    if (!isBindingIdentity(wechatBinding, wechatBindingDocId, account._openid, account) ||
      !isUserIdentity(user, wechatBindingDocId, account._openid)
    ) {
      throw authError('ACCOUNT_NOT_BOUND');
    }
    if (account.emailBindingId !== emailBindingDocId ||
      !isEmailBindingIdentity(emailBinding, emailBindingDocId, account, normalizedEmail) ||
      emailBinding.status !== 'active'
    ) {
      throw authError('EMAIL_NOT_BOUND');
    }

    const challengeFailure = await validateEmailChallenge(challengeRef, challenge, {
      _id: challengeDocId,
      purpose: 'reset',
      accountId: accountDocId,
      emailBindingId: emailBindingDocId
    }, expectedCodeHash);
    if (challengeFailure) return challengeFailure;

    const salt = crypto.randomBytes(16).toString('hex');
    await accountRef.update({ data: {
      passwordAlgorithm: 'scrypt-v1',
      passwordSalt: salt,
      passwordHash: hashPassword(event.password, salt),
      updatedAt: db.serverDate()
    } });
    await challengeRef.update({ data: {
      status: 'used',
      usedAt: db.serverDate(),
      updatedAt: db.serverDate()
    } });
    return { ok: true, account: account.account };
  });
}

async function status(event, context) {
  const resolved = await resolveWechatAccount(context.OPENID);
  let emailBound = false;
  let emailMasked = '';
  if (resolved.account.emailBindingId) {
    const emailBinding = await getOptional(
      db.collection('email_bindings').doc(resolved.account.emailBindingId)
    );
    if (isEmailBindingIdentity(
      emailBinding,
      resolved.account.emailBindingId,
      resolved.account,
      emailBinding && emailBinding.email
    ) && emailBinding.status === 'active') {
      emailBound = true;
      emailMasked = maskEmail(emailBinding.email);
    }
  }
  return Object.assign(authResult(resolved.account, resolved.user), {
    passwordSet: true,
    phone: resolved.user.phoneVerifiedAt ? (resolved.user.phone || '') : '',
    emailBound,
    emailMasked
  });
}

const handlers = {
  probe: async () => ({ ok: true, cloudReady: true }),
  register,
  passwordLogin,
  wechatLogin,
  resetPasswordByWechat,
  bindEmail,
  resetPasswordByEmail,
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
