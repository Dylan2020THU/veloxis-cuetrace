const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const path = require('path');

const {
  findById,
  findAccount,
  getFakeDb,
  loadAccountAuth,
  makeState,
  sha256,
  snapshot
} = require('./accountWechatBinding.test');

const TEST_SECRET = 'email-recovery-test-secret';
const EMAIL_ENV_KEYS = [
  'CUETRACE_SES_SECRET_ID',
  'CUETRACE_SES_SECRET_KEY',
  'CUETRACE_SES_REGION',
  'CUETRACE_SES_FROM_EMAIL',
  'CUETRACE_SES_TEMPLATE_ID',
  'CUETRACE_SES_SUBJECT',
  'CUETRACE_SES_REPLY_TO',
  'CUETRACE_EMAIL_CODE_SECRET'
];
const PUBLIC_RESET_RESULT = {
  ok: true,
  accepted: true,
  msg: '若信息匹配，验证码将发送至绑定邮箱'
};
const sendEmailCodePath = path.resolve(
  __dirname,
  '..',
  'cloudfunctions',
  'sendEmailCode',
  'index.js'
);

function loadSendEmailCode(openid, state, options) {
  const config = options || {};
  const clientConfigs = [];
  const sendCalls = [];
  loadAccountAuth(openid, state);
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      return getFakeDb();
    },
    getWXContext() {
      return { OPENID: openid };
    }
  };
  const fakeSes = {
    ses: {
      v20201002: {
        Client: class FakeSesClient {
          constructor(clientConfig) {
            if (config.clientError) throw config.clientError;
            clientConfigs.push(clientConfig);
          }

          async SendEmail(params) {
            sendCalls.push(params);
            if (config.sendEmail) return config.sendEmail(params);
            return { RequestId: 'ses-request-id' };
          }
        }
      }
    }
  };
  const fakeCrypto = Object.assign({}, crypto, {
    randomInt(min, max) {
      assert.strictEqual(min, 0);
      assert.strictEqual(max, 1000000);
      return config.codeNumber === undefined ? 123456 : config.codeNumber;
    }
  });
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    if (request === 'tencentcloud-sdk-nodejs-ses') return fakeSes;
    if (request === 'crypto') return fakeCrypto;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[sendEmailCodePath];
    return {
      module: require(sendEmailCodePath),
      clientConfigs,
      sendCalls
    };
  } finally {
    Module._load = originalLoad;
  }
}

function configureEmail(overrides) {
  const values = Object.assign({
    CUETRACE_SES_SECRET_ID: 'test-secret-id',
    CUETRACE_SES_SECRET_KEY: 'test-secret-key',
    CUETRACE_SES_REGION: 'ap-guangzhou',
    CUETRACE_SES_FROM_EMAIL: '强化杆迹 <noreply@example.com>',
    CUETRACE_SES_TEMPLATE_ID: '12345',
    CUETRACE_SES_SUBJECT: '强化杆迹验证码',
    CUETRACE_SES_REPLY_TO: '',
    CUETRACE_EMAIL_CODE_SECRET: TEST_SECRET
  }, overrides || {});
  EMAIL_ENV_KEYS.forEach((key) => {
    process.env[key] = values[key] || '';
  });
}

async function withImmediateTimers(callback) {
  const originalSetTimeout = global.setTimeout;
  const originalDateNow = Date.now;
  const startedAt = originalDateNow();
  const delays = [];
  let now = startedAt;
  global.setTimeout = (handler, delay) => {
    delays.push(delay);
    now += delay;
    handler();
    return 1;
  };
  Date.now = () => now;
  try {
    const result = await callback({
      advance(milliseconds) {
        now += milliseconds;
      }
    });
    return { result, delays, elapsed: now - startedAt };
  } finally {
    global.setTimeout = originalSetTimeout;
    Date.now = originalDateNow;
  }
}

function assertPublicResetTiming(timed, expectedDelay) {
  assert.deepStrictEqual(timed.result, PUBLIC_RESET_RESULT);
  assert.deepStrictEqual(timed.delays, [expectedDelay]);
  assert.strictEqual(timed.elapsed, 9500);
}

function emailRateId(purpose, actor) {
  return sha256(`email-rate:${purpose}:${sha256(actor)}`);
}

function addActiveEmailBinding(state, account, email) {
  const normalized = normalizeEmail(email);
  const id = emailBindingId(normalized);
  state.email_bindings.push({
    _id: id,
    _openid: account._openid,
    accountId: account._id,
    account: account.account,
    email: normalized,
    emailNormalized: normalized,
    status: 'active',
    boundAt: Date.now(),
    updatedAt: Date.now()
  });
  account.emailBindingId = id;
  account.emailVerifiedAt = Date.now();
  return id;
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

function codeHash(challengeId, code) {
  return crypto.createHmac('sha256', TEST_SECRET).update(`${challengeId}:${code}`).digest('hex');
}

function putChallenge(state, options) {
  const id = emailCodeId(options.purpose, options.email);
  const bindingId = emailBindingId(options.email);
  const challenge = {
    _id: id,
    purpose: options.purpose,
    accountId: options.accountId,
    emailBindingId: bindingId,
    targetHash: bindingId,
    codeHash: codeHash(id, options.code || '123456'),
    requestId: `request-${id.slice(0, 8)}`,
    status: options.status || 'active',
    attemptsLeft: options.attemptsLeft === undefined ? 5 : options.attemptsLeft,
    expiresAt: options.expiresAt === undefined ? Date.now() + (10 * 60 * 1000) : options.expiresAt,
    nextSendAt: Date.now() + (60 * 1000),
    sentAt: Date.now(),
    updatedAt: Date.now()
  };
  const index = state.email_codes.findIndex((item) => item._id === id);
  if (index === -1) state.email_codes.push(challenge);
  else state.email_codes[index] = challenge;
  return challenge;
}

async function register(openid, state, account) {
  const main = loadAccountAuth(openid, state).main;
  const result = await main({ action: 'register', account, password: 'oldpass' });
  assert.strictEqual(result.ok, true);
  return main;
}

async function run() {
  const previousEmailEnv = {};
  EMAIL_ENV_KEYS.forEach((key) => {
    previousEmailEnv[key] = process.env[key];
  });
  process.env.CUETRACE_EMAIL_CODE_SECRET = TEST_SECRET;

  try {
    const state = makeState();
    const main = await register('wechat_email_a', state, 'MemberEmail');
    const account = findAccount(state, 'MemberEmail');

    const wechatResetResult = await main({
      action: 'resetPasswordByWechat', password: 'wechatpass'
    });
    assert.deepStrictEqual(wechatResetResult, { ok: true, account: 'MemberEmail' });

    const firstEmail = 'first@example.com';
    putChallenge(state, {
      purpose: 'bind', email: firstEmail, accountId: account._id
    });
    const firstBind = await main({
      action: 'bindEmail', email: ' First@Example.com ', code: '123456'
    });
    assert.strictEqual(firstBind.ok, true);
    const firstBinding = findById(state.email_bindings, emailBindingId(firstEmail));
    assert.strictEqual(firstBinding.status, 'active');
    assert.strictEqual(firstBinding.accountId, account._id);
    assert.strictEqual(firstBinding._openid, 'wechat_email_a');
    assert.strictEqual(firstBinding.email, firstEmail);
    assert.strictEqual(firstBinding.emailNormalized, firstEmail);
    assert.strictEqual(findAccount(state, 'MemberEmail').emailBindingId, firstBinding._id);
    assert.strictEqual(findAccount(state, 'MemberEmail').email, undefined);
    assert.strictEqual(findAccount(state, 'MemberEmail').emailMasked, undefined);
    assert.strictEqual(findById(state.email_codes, emailCodeId('bind', firstEmail)).status, 'used');

    const firstStatus = await main({ action: 'status' });
    assert.strictEqual(firstStatus.emailBound, true);
    assert.strictEqual(firstStatus.emailMasked, 'fi***@example.com');
    assert.strictEqual(firstStatus.email, undefined);

    const secondMain = await register('wechat_email_b', state, 'MemberOther');
    const secondAccount = findAccount(state, 'MemberOther');
    putChallenge(state, {
      purpose: 'bind', email: firstEmail, accountId: secondAccount._id
    });
    const duplicateBefore = snapshot(state);
    const duplicateBind = await secondMain({
      action: 'bindEmail', email: firstEmail, code: '123456'
    });
    assert.strictEqual(duplicateBind.code, 'EMAIL_ALREADY_BOUND');
    assert.deepStrictEqual(snapshot(state), duplicateBefore);

    const nextEmail = 'next@example.com';
    putChallenge(state, {
      purpose: 'bind', email: nextEmail, accountId: account._id
    });
    const rebound = await main({ action: 'bindEmail', email: nextEmail, code: '123456' });
    assert.strictEqual(rebound.ok, true);
    assert.strictEqual(findById(state.email_bindings, emailBindingId(firstEmail)).status, 'revoked');
    assert.strictEqual(findById(state.email_bindings, emailBindingId(nextEmail)).status, 'active');
    assert.strictEqual(findAccount(state, 'MemberEmail').emailBindingId, emailBindingId(nextEmail));
    assert.strictEqual((await main({ action: 'status' })).emailMasked, 'ne**@example.com');

    const inconsistentState = makeState(snapshot(state));
    findById(inconsistentState.email_bindings, emailBindingId(nextEmail)).accountId = secondAccount._id;
    const inconsistentStatus = await loadAccountAuth('wechat_email_a', inconsistentState).main({ action: 'status' });
    assert.strictEqual(inconsistentStatus.emailBound, false);
    assert.strictEqual(inconsistentStatus.emailMasked, '');

    const wrongEmailIdentityState = makeState(snapshot(state));
    const wrongEmailIdentity = findById(
      wrongEmailIdentityState.email_bindings,
      emailBindingId(nextEmail)
    );
    wrongEmailIdentity.email = 'tampered@example.com';
    wrongEmailIdentity.emailNormalized = 'tampered@example.com';
    const wrongEmailIdentityStatus = await loadAccountAuth(
      'wechat_email_a',
      wrongEmailIdentityState
    ).main({ action: 'status' });
    assert.strictEqual(wrongEmailIdentityStatus.emailBound, false);
    assert.strictEqual(wrongEmailIdentityStatus.emailMasked, '');

    const excessiveAttemptsEmail = 'attempts@example.com';
    putChallenge(state, {
      purpose: 'bind',
      email: excessiveAttemptsEmail,
      accountId: account._id,
      attemptsLeft: 6
    });
    const excessiveAttemptsBefore = snapshot(state);
    assert.strictEqual((await main({
      action: 'bindEmail', email: excessiveAttemptsEmail, code: '123456'
    })).code, 'EMAIL_CODE_INVALID');
    assert.deepStrictEqual(snapshot(state), excessiveAttemptsBefore);

    const wrongEmail = 'wrong@example.com';
    putChallenge(state, {
      purpose: 'bind', email: wrongEmail, accountId: account._id
    });
    const wrongCode = await main({ action: 'bindEmail', email: wrongEmail, code: '000000' });
    assert.strictEqual(wrongCode.code, 'EMAIL_CODE_INVALID');
    const wrongChallenge = findById(state.email_codes, emailCodeId('bind', wrongEmail));
    assert.strictEqual(wrongChallenge.attemptsLeft, 4);
    assert.strictEqual(wrongChallenge.status, 'active');
    assert.strictEqual(findById(state.email_bindings, emailBindingId(wrongEmail)), undefined);

    wrongChallenge.attemptsLeft = 1;
    const finalWrongCode = await main({ action: 'bindEmail', email: wrongEmail, code: '000000' });
    assert.strictEqual(finalWrongCode.code, 'EMAIL_CODE_LOCKED');
    const lockedChallenge = findById(state.email_codes, emailCodeId('bind', wrongEmail));
    assert.strictEqual(lockedChallenge.attemptsLeft, 0);
    assert.strictEqual(lockedChallenge.status, 'locked');
    const lockedBefore = snapshot(state);
    assert.strictEqual((await main({
      action: 'bindEmail', email: wrongEmail, code: '123456'
    })).code, 'EMAIL_CODE_LOCKED');
    assert.deepStrictEqual(snapshot(state), lockedBefore);

    const expiredEmail = 'expired@example.com';
    putChallenge(state, {
      purpose: 'bind', email: expiredEmail, accountId: account._id, expiresAt: Date.now() - 1
    });
    const expiredBefore = snapshot(state);
    assert.strictEqual((await main({
      action: 'bindEmail', email: expiredEmail, code: '123456'
    })).code, 'EMAIL_CODE_EXPIRED');
    assert.deepStrictEqual(snapshot(state), expiredBefore);

    const usedEmail = 'used@example.com';
    putChallenge(state, {
      purpose: 'bind', email: usedEmail, accountId: account._id, status: 'used'
    });
    const usedBefore = snapshot(state);
    assert.strictEqual((await main({
      action: 'bindEmail', email: usedEmail, code: '123456'
    })).code, 'EMAIL_CODE_INVALID');
    assert.deepStrictEqual(snapshot(state), usedBefore);

    const invalidBefore = snapshot(state);
    assert.strictEqual((await main({
      action: 'bindEmail', email: 'not-an-email', code: '123456'
    })).code, 'EMAIL_INVALID');
    assert.strictEqual((await main({
      action: 'bindEmail', email: 'valid@example.com', code: '12345'
    })).code, 'EMAIL_CODE_INVALID');
    assert.deepStrictEqual(snapshot(state), invalidBefore);

    const configuredEmail = 'configured@example.com';
    putChallenge(state, {
      purpose: 'bind', email: configuredEmail, accountId: account._id
    });
    const configuredBefore = snapshot(state);
    process.env.CUETRACE_EMAIL_CODE_SECRET = '';
    assert.strictEqual((await main({
      action: 'bindEmail', email: configuredEmail, code: '123456'
    })).code, 'EMAIL_NOT_CONFIGURED');
    assert.deepStrictEqual(snapshot(state), configuredBefore);
    process.env.CUETRACE_EMAIL_CODE_SECRET = TEST_SECRET;

    const tamperEmail = 'tamper@example.com';
    putChallenge(state, {
      purpose: 'bind', email: tamperEmail, accountId: account._id
    });
    const tamperMain = loadAccountAuth('wechat_email_a', state).main;
    getFakeDb().beforeTransaction = (workingState) => {
      findById(workingState.users, sha256('wechat:wechat_email_a'))._openid = 'tampered';
    };
    const tamperBefore = snapshot(state);
    assert.strictEqual((await tamperMain({
      action: 'bindEmail', email: tamperEmail, code: '123456'
    })).code, 'ACCOUNT_NOT_BOUND');
    assert.deepStrictEqual(snapshot(state), tamperBefore);

    putChallenge(state, {
      purpose: 'reset', email: nextEmail, accountId: account._id
    });
    const mismatchBefore = snapshot(state);
    const publicMain = loadAccountAuth('wechat_unbound_recovery', state).main;
    assert.strictEqual((await publicMain({
      action: 'resetPasswordByEmail',
      account: 'MemberOther',
      email: nextEmail,
      code: '123456',
      password: 'newpass1'
    })).code, 'EMAIL_NOT_BOUND');
    assert.deepStrictEqual(snapshot(state), mismatchBefore);

    const resetResult = await publicMain({
      action: 'resetPasswordByEmail',
      account: 'MemberEmail',
      email: ' NEXT@EXAMPLE.COM ',
      code: '123456',
      password: 'newpass1'
    });
    assert.deepStrictEqual(resetResult, { ok: true, account: 'MemberEmail' });
    assert.strictEqual(findById(state.email_codes, emailCodeId('reset', nextEmail)).status, 'used');
    assert.strictEqual((await main({
      action: 'passwordLogin', account: 'MemberEmail', password: 'oldpass'
    })).code, 'INVALID_PASSWORD');
    assert.strictEqual((await main({
      action: 'passwordLogin', account: 'MemberEmail', password: 'newpass1'
    })).ok, true);

    const reusedBefore = snapshot(state);
    assert.strictEqual((await publicMain({
      action: 'resetPasswordByEmail',
      account: 'MemberEmail',
      email: nextEmail,
      code: '123456',
      password: 'anotherpass'
    })).code, 'EMAIL_CODE_INVALID');
    assert.deepStrictEqual(snapshot(state), reusedBefore);

    configureEmail({
      CUETRACE_SES_SECRET_ID: '',
      CUETRACE_SES_SECRET_KEY: '',
      CUETRACE_SES_FROM_EMAIL: '',
      CUETRACE_SES_TEMPLATE_ID: '',
      CUETRACE_EMAIL_CODE_SECRET: ''
    });
    const missingState = makeState();
    const missingFixture = loadSendEmailCode('wechat_email_sender', missingState);
    getFakeDb().failNextRead = true;
    const notConfigured = await missingFixture.module.main({
      action: 'send', purpose: 'reset', account: 'MemberEmail', email: nextEmail
    });
    assert.strictEqual(notConfigured.ok, false);
    assert.strictEqual(notConfigured.code, 'EMAIL_NOT_CONFIGURED');
    assert.strictEqual(missingFixture.sendCalls.length, 0);
    assert.deepStrictEqual(snapshot(missingState), snapshot(makeState()));

    configureEmail();
    const invalidState = makeState();
    const invalidFixture = loadSendEmailCode('wechat_invalid_sender', invalidState);
    getFakeDb().failNextRead = true;
    const invalidSend = await invalidFixture.module.main({
      action: 'send', purpose: 'reset', account: 'MemberEmail', email: 'not-an-email'
    });
    assert.strictEqual(invalidSend.code, 'EMAIL_INVALID');
    assert.strictEqual(invalidFixture.sendCalls.length, 0);
    assert.deepStrictEqual(snapshot(invalidState), snapshot(makeState()));

    const invalidPurpose = await invalidFixture.module.main({
      action: 'send', purpose: 'login', email: 'member@example.com'
    });
    assert.strictEqual(invalidPurpose.code, 'INVALID_INPUT');
    assert.strictEqual(invalidFixture.sendCalls.length, 0);

    const unboundState = makeState();
    const unboundFixture = loadSendEmailCode('wechat_unbound_sender', unboundState);
    const unboundBind = await unboundFixture.module.main({
      purpose: 'bind', email: 'member@example.com'
    });
    assert.strictEqual(unboundBind.code, 'WECHAT_NOT_BOUND');
    assert.strictEqual(unboundFixture.sendCalls.length, 0);

    const conflictState = makeState();
    await register('wechat_conflict_sender', conflictState, 'ConflictSender');
    conflictState.email_bindings.push({
      _id: emailBindingId('conflict@example.com'),
      _openid: 'wechat_other_owner',
      accountId: sha256('account:otherowner'),
      account: 'OtherOwner',
      email: 'conflict@example.com',
      emailNormalized: 'conflict@example.com',
      status: 'active'
    });
    const conflictFixture = loadSendEmailCode('wechat_conflict_sender', conflictState);
    const conflictBind = await conflictFixture.module.main({
      action: 'send', purpose: 'bind', email: 'conflict@example.com'
    });
    assert.strictEqual(conflictBind.code, 'EMAIL_ALREADY_BOUND');
    assert.strictEqual(conflictFixture.sendCalls.length, 0);

    const targetCooldownState = makeState();
    await register('wechat_target_cooldown', targetCooldownState, 'TargetCooldown');
    const targetCooldownEmail = 'target-cooldown@example.com';
    targetCooldownState.email_codes.push({
      _id: emailCodeId('bind', targetCooldownEmail),
      purpose: 'bind',
      status: 'active',
      nextSendAt: Date.now() + 60000
    });
    const targetCooldownBefore = snapshot(targetCooldownState);
    const targetCooldownFixture = loadSendEmailCode(
      'wechat_target_cooldown',
      targetCooldownState
    );
    const targetCooldown = await targetCooldownFixture.module.main({
      purpose: 'bind', email: targetCooldownEmail
    });
    assert.strictEqual(targetCooldown.code, 'EMAIL_CODE_COOLDOWN');
    assert.strictEqual(targetCooldownFixture.sendCalls.length, 0);
    assert.deepStrictEqual(snapshot(targetCooldownState), targetCooldownBefore);

    const actorCooldownState = makeState();
    await register('wechat_actor_cooldown', actorCooldownState, 'ActorCooldown');
    actorCooldownState.email_codes.push({
      _id: emailRateId('bind', 'wechat_actor_cooldown'),
      purpose: 'bind',
      status: 'rate_limit',
      nextSendAt: Date.now() + 60000
    });
    const actorCooldownBefore = snapshot(actorCooldownState);
    const actorCooldownFixture = loadSendEmailCode(
      'wechat_actor_cooldown',
      actorCooldownState
    );
    const actorCooldown = await actorCooldownFixture.module.main({
      purpose: 'bind', email: 'actor-cooldown@example.com'
    });
    assert.strictEqual(actorCooldown.code, 'EMAIL_CODE_COOLDOWN');
    assert.strictEqual(actorCooldownFixture.sendCalls.length, 0);
    assert.deepStrictEqual(snapshot(actorCooldownState), actorCooldownBefore);

    const successState = makeState();
    await register('wechat_send_success', successState, 'SendSuccess');
    const successAccount = findAccount(successState, 'SendSuccess');
    const successEmail = 'member@example.com';
    const successFixture = loadSendEmailCode('wechat_send_success', successState);
    const startedAt = Date.now();
    const sent = await successFixture.module.main({
      action: 'send', purpose: 'bind', email: ' Member@Example.com '
    });
    const finishedAt = Date.now();
    assert.strictEqual(sent.ok, true);
    assert.strictEqual(sent.accepted, true);
    assert.strictEqual(successFixture.clientConfigs.length, 1);
    assert.deepStrictEqual(successFixture.clientConfigs[0].credential, {
      secretId: 'test-secret-id', secretKey: 'test-secret-key'
    });
    assert.strictEqual(successFixture.clientConfigs[0].region, 'ap-guangzhou');
    assert.strictEqual(successFixture.clientConfigs[0].profile.httpProfile.reqTimeout, 8);
    assert.deepStrictEqual(successFixture.sendCalls[0], {
      FromEmailAddress: '强化杆迹 <noreply@example.com>',
      Destination: [successEmail],
      Subject: '强化杆迹验证码',
      Template: {
        TemplateID: 12345,
        TemplateData: '{"code":"123456","minutes":"10"}'
      },
      TriggerType: 1
    });
    const successChallengeId = emailCodeId('bind', successEmail);
    const successChallenge = findById(successState.email_codes, successChallengeId);
    assert.strictEqual(successChallenge.purpose, 'bind');
    assert.strictEqual(successChallenge.accountId, successAccount._id);
    assert.strictEqual(successChallenge.emailBindingId, emailBindingId(successEmail));
    assert.strictEqual(successChallenge.targetHash, emailBindingId(successEmail));
    assert.strictEqual(successChallenge.codeHash, codeHash(successChallengeId, '123456'));
    assert.strictEqual(successChallenge.status, 'active');
    assert.strictEqual(successChallenge.attemptsLeft, 5);
    assert.ok(successChallenge.requestId);
    assert.ok(successChallenge.expiresAt >= startedAt + (10 * 60 * 1000));
    assert.ok(successChallenge.expiresAt <= finishedAt + (10 * 60 * 1000));
    assert.ok(successChallenge.nextSendAt >= startedAt + 60000);
    assert.ok(successChallenge.nextSendAt <= finishedAt + 60000);
    assert.ok(successChallenge.sentAt >= startedAt);
    assert.ok(successChallenge.sentAt <= finishedAt);
    assert.strictEqual(JSON.stringify(successChallenge).includes(successEmail), false);
    assert.strictEqual(JSON.stringify(successChallenge).includes('123456'), false);
    const successRate = findById(
      successState.email_codes,
      emailRateId('bind', 'wechat_send_success')
    );
    assert.ok(successRate);
    assert.ok(successRate.nextSendAt >= startedAt + 60000);
    assert.strictEqual(JSON.stringify(successRate).includes(successEmail), false);
    assert.strictEqual(JSON.stringify(successRate).includes('wechat_send_success'), false);

    const failedState = makeState();
    await register('wechat_send_failed', failedState, 'SendFailed');
    const failedEmail = 'send-failed@example.com';
    const failedFixture = loadSendEmailCode('wechat_send_failed', failedState, {
      sendEmail() {
        const error = new Error(
          `SES failed for ${failedEmail}, SendFailed, 123456, ${TEST_SECRET}`
        );
        error.code = 'InternalError';
        error.requestId = 'remote-request-id';
        throw error;
      }
    });
    const errorLogs = [];
    const originalConsoleError = console.error;
    console.error = (...args) => errorLogs.push(args);
    let failedSend;
    try {
      failedSend = await failedFixture.module.main({
        purpose: 'bind', email: failedEmail
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.strictEqual(failedSend.code, 'EMAIL_SEND_FAILED');
    const failedChallenge = findById(
      failedState.email_codes,
      emailCodeId('bind', failedEmail)
    );
    assert.strictEqual(failedChallenge.status, 'failed');
    assert.strictEqual(failedChallenge.codeHash, undefined);
    const serializedLogs = JSON.stringify(errorLogs);
    [failedEmail, 'SendFailed', '123456', TEST_SECRET].forEach((secret) => {
      assert.strictEqual(serializedLogs.includes(secret), false);
    });

    async function makeResetState(ownerOpenid, accountName, email) {
      const resetState = makeState();
      await register(ownerOpenid, resetState, accountName);
      const resetAccount = findAccount(resetState, accountName);
      addActiveEmailBinding(resetState, resetAccount, email);
      return { resetState, resetAccount };
    }

    const clientErrorFixture = loadSendEmailCode(
      'wechat_public_client_error',
      makeState(),
      { clientError: Object.assign(new Error('client init failed'), { code: 'ClientError' }) }
    );
    const reserveErrorState = makeState();
    const reserveErrorFixture = loadSendEmailCode(
      'wechat_public_reserve_error',
      reserveErrorState
    );
    console.error = () => {};
    let clientErrorTimed;
    let reserveErrorTimed;
    try {
      clientErrorTimed = await withImmediateTimers(() => clientErrorFixture.module.main({
        purpose: 'reset', account: 'ClientError', email: 'client-error@example.com'
      }));
      getFakeDb().failNextRead = true;
      reserveErrorTimed = await withImmediateTimers(() => reserveErrorFixture.module.main({
        purpose: 'reset', account: 'ReserveError', email: 'reserve-error@example.com'
      }));
    } finally {
      console.error = originalConsoleError;
    }
    assertPublicResetTiming(clientErrorTimed, 9500);
    assertPublicResetTiming(reserveErrorTimed, 9500);

    const mismatchSetup = await makeResetState(
      'wechat_reset_owner_mismatch',
      'ResetMismatch',
      'reset-mismatch@example.com'
    );
    const mismatchFixture = loadSendEmailCode(
      'wechat_public_mismatch',
      mismatchSetup.resetState
    );
    const mismatchTimed = await withImmediateTimers(() => mismatchFixture.module.main({
      purpose: 'reset',
      account: 'DifferentAccount',
      email: 'reset-mismatch@example.com'
    }));
    assertPublicResetTiming(mismatchTimed, 9500);
    assert.strictEqual(mismatchFixture.sendCalls.length, 0);
    assert.strictEqual(findById(
      mismatchSetup.resetState.email_codes,
      emailCodeId('reset', 'reset-mismatch@example.com')
    ), undefined);

    const resetTargetSetup = await makeResetState(
      'wechat_reset_owner_target',
      'ResetTarget',
      'reset-target@example.com'
    );
    resetTargetSetup.resetState.email_codes.push({
      _id: emailCodeId('reset', 'reset-target@example.com'),
      purpose: 'reset',
      status: 'active',
      nextSendAt: Date.now() + 60000
    });
    const resetTargetFixture = loadSendEmailCode(
      'wechat_public_target',
      resetTargetSetup.resetState
    );
    const resetTargetTimed = await withImmediateTimers(() => resetTargetFixture.module.main({
      purpose: 'reset',
      account: 'ResetTarget',
      email: 'reset-target@example.com'
    }));
    assertPublicResetTiming(resetTargetTimed, 9500);
    assert.strictEqual(resetTargetFixture.sendCalls.length, 0);

    const resetActorSetup = await makeResetState(
      'wechat_reset_owner_actor',
      'ResetActor',
      'reset-actor@example.com'
    );
    resetActorSetup.resetState.email_codes.push({
      _id: emailRateId('reset', 'wechat_public_actor'),
      purpose: 'reset',
      status: 'rate_limit',
      nextSendAt: Date.now() + 60000
    });
    const resetActorFixture = loadSendEmailCode(
      'wechat_public_actor',
      resetActorSetup.resetState
    );
    const resetActorTimed = await withImmediateTimers(() => resetActorFixture.module.main({
      purpose: 'reset',
      account: 'ResetActor',
      email: 'reset-actor@example.com'
    }));
    assertPublicResetTiming(resetActorTimed, 9500);
    assert.strictEqual(resetActorFixture.sendCalls.length, 0);

    const resetFailedSetup = await makeResetState(
      'wechat_reset_owner_failed',
      'ResetFailed',
      'reset-failed@example.com'
    );
    let advanceResetFailure = () => {};
    const resetFailedFixture = loadSendEmailCode(
      'wechat_public_failed',
      resetFailedSetup.resetState,
      {
        sendEmail() {
          advanceResetFailure(8000);
          throw new Error('simulated SES failure');
        }
      }
    );
    console.error = () => {};
    let resetFailedTimed;
    try {
      resetFailedTimed = await withImmediateTimers((clock) => {
        advanceResetFailure = clock.advance;
        return resetFailedFixture.module.main({
          purpose: 'reset',
          account: 'ResetFailed',
          email: 'reset-failed@example.com'
        });
      });
    } finally {
      console.error = originalConsoleError;
    }
    assertPublicResetTiming(resetFailedTimed, 1500);
    assert.strictEqual(findById(
      resetFailedSetup.resetState.email_codes,
      emailCodeId('reset', 'reset-failed@example.com')
    ).status, 'failed');

    const resetSuccessSetup = await makeResetState(
      'wechat_reset_owner_success',
      'ResetSuccess',
      'reset-success@example.com'
    );
    let advanceResetSuccess = () => {};
    const resetSuccessFixture = loadSendEmailCode(
      'wechat_public_success',
      resetSuccessSetup.resetState,
      {
        sendEmail() {
          advanceResetSuccess(2000);
          return { RequestId: 'ses-request-id' };
        }
      }
    );
    const resetSuccessTimed = await withImmediateTimers((clock) => {
      advanceResetSuccess = clock.advance;
      return resetSuccessFixture.module.main({
        action: 'send',
        purpose: 'reset',
        account: ' ResetSuccess ',
        email: ' RESET-SUCCESS@EXAMPLE.COM '
      });
    });
    assertPublicResetTiming(resetSuccessTimed, 7500);
    assert.strictEqual(resetSuccessFixture.sendCalls.length, 1);
    const resetSuccessChallenge = findById(
      resetSuccessSetup.resetState.email_codes,
      emailCodeId('reset', 'reset-success@example.com')
    );
    assert.strictEqual(resetSuccessChallenge.status, 'active');
    assert.strictEqual(resetSuccessChallenge.accountId, resetSuccessSetup.resetAccount._id);
    assert.strictEqual(
      resetSuccessChallenge.emailBindingId,
      emailBindingId('reset-success@example.com')
    );

    console.log('emailRecovery tests passed');
  } finally {
    EMAIL_ENV_KEYS.forEach((key) => {
      if (previousEmailEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEmailEnv[key];
    });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
