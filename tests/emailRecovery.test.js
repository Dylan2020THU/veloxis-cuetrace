const assert = require('assert');
const crypto = require('crypto');

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
  const previousSecret = process.env.CUETRACE_EMAIL_CODE_SECRET;
  process.env.CUETRACE_EMAIL_CODE_SECRET = TEST_SECRET;

  try {
    const state = makeState();
    const main = await register('wechat_email_a', state, 'MemberEmail');
    const account = findAccount(state, 'MemberEmail');

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
    assert.strictEqual(resetResult.ok, true);
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

    console.log('emailRecovery tests passed');
  } finally {
    if (previousSecret === undefined) delete process.env.CUETRACE_EMAIL_CODE_SECRET;
    else process.env.CUETRACE_EMAIL_CODE_SECRET = previousSecret;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
