const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nativeSetInterval = global.setInterval;
const nativeClearInterval = global.clearInterval;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function securityStatus(overrides = {}) {
  return Object.assign({
    ok: true,
    kind: 'security_status',
    account: 'Member_01',
    accountNameSet: true,
    passwordSet: true,
    phoneBound: true,
    phoneMasked: '138****8000',
    emailBound: true,
    emailMasked: 'm***@example.com',
    wechatBound: true,
    roles: ['member', 'coach'],
    currentRole: 'coach',
    reauthMethods: ['password', 'phone', 'email', 'wechat'],
    currentSession: {
      authenticatedAt: 1784253000000,
      authenticationMethod: 'password',
      createdAt: 1784250000000,
      lastSeenAt: 1784253600000,
      idleExpiresAt: 1786845600000,
      absoluteExpiresAt: 1792026000000
    },
    otherSessionCount: 2
  }, overrides);
}

function cloneData(value) {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === 'object') return Object.assign({}, value);
  return value;
}

function loadPage(relativePath, fakeData, options = {}) {
  const pagePath = path.join(root, relativePath);
  delete require.cache[require.resolve(pagePath)];
  let definition;
  const originalLoad = Module._load;
  const app = options.app || {
    globalData: {
      openid: 'openid-forged-local',
      role: 'member',
      currentRole: 'member',
      roles: ['member'],
      userProfile: { nickname: 'member' }
    }
  };
  const records = {
    modals: [],
    toasts: [],
    navigations: [],
    relaunches: [],
    backs: 0,
    removals: [],
    setData: []
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = request.replace(/\\/g, '/');
    if (normalized.endsWith('/services/data')) return fakeData || {};
    if (normalized.endsWith('/utils/themeBehavior')) return {};
    if (normalized.endsWith('/utils/mock')) {
      return options.mock || { getRole: () => 'member' };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Page = (nextDefinition) => {
    definition = nextDefinition;
  };
  global.Behavior = (nextDefinition) => nextDefinition;
  global.getApp = () => app;
  const defaultWx = {
    showModal(modalOptions) {
      records.modals.push(modalOptions);
    },
    showToast(toastOptions) {
      records.toasts.push(toastOptions);
    },
    navigateTo(navigationOptions) {
      records.navigations.push(navigationOptions.url);
    },
    navigateBack() {
      records.backs += 1;
    },
    reLaunch(relaunchOptions) {
      records.relaunches.push(relaunchOptions.url);
    },
    setClipboardData() {},
    showLoading() {},
    hideLoading() {},
    getStorageInfoSync() {
      return { keys: [], currentSize: 0 };
    },
    removeStorageSync(key) {
      records.removals.push(key);
    }
  };
  global.wx = Object.assign(defaultWx, options.wx || {});
  try {
    require(pagePath);
  } finally {
    Module._load = originalLoad;
  }
  assert(definition, `${relativePath} must register a Page.`);
  definition.data = Object.keys(definition.data || {}).reduce((result, key) => {
    result[key] = cloneData(definition.data[key]);
    return result;
  }, {});
  definition.setData = function setData(next) {
    records.setData.push(Object.assign({}, next));
    this.data = Object.assign({}, this.data, next);
  };
  definition._records = records;
  definition._app = app;
  if (typeof definition.onLoad === 'function') definition.onLoad();
  return definition;
}

function resolveModal(page, index, confirm) {
  const modal = page._records.modals[index];
  assert(modal, `Expected modal ${index}.`);
  if (typeof modal.success === 'function') modal.success({ confirm: !!confirm, cancel: !confirm });
}

function loadRecentAuth(fakeData) {
  const componentPath = path.join(root, 'miniprogram/components/recent-auth/index.js');
  delete require.cache[require.resolve(componentPath)];
  let definition;
  let nextTimerId = 1;
  const timers = new Map();
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = request.replace(/\\/g, '/');
    if (normalized.endsWith('/services/data')) return fakeData || {};
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Component = (nextDefinition) => {
    definition = nextDefinition;
  };
  global.setInterval = (callback) => {
    const timerId = nextTimerId;
    nextTimerId += 1;
    timers.set(timerId, callback);
    return timerId;
  };
  global.clearInterval = (timerId) => {
    timers.delete(timerId);
  };
  const toasts = [];
  const modals = [];
  const navigations = [];
  let backs = 0;
  global.wx = {
    showToast(options) {
      toasts.push(options);
    },
    showModal(options) {
      modals.push(options);
    },
    navigateTo(options) {
      navigations.push(options.url);
    },
    navigateBack() {
      backs += 1;
    }
  };
  try {
    require(componentPath);
  } finally {
    Module._load = originalLoad;
  }
  assert(definition, 'recent-auth must register a Component.');
  const instance = {
    data: {},
    _events: [],
    _setDataCalls: [],
    _toasts: toasts,
    _modals: modals,
    _navigations: navigations,
    _timers: timers,
    setData(next) {
      this._setDataCalls.push(Object.assign({}, next));
      this.data = Object.assign({}, this.data, next);
    },
    triggerEvent(name, detail) {
      this._events.push({ name, detail, snapshot: Object.assign({}, this.data) });
    }
  };
  Object.keys(definition.properties || {}).forEach((name) => {
    const descriptor = definition.properties[name];
    instance.data[name] = cloneData(descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined);
  });
  Object.keys(definition.data || {}).forEach((name) => {
    instance.data[name] = cloneData(definition.data[name]);
  });
  Object.keys(definition.methods || {}).forEach((name) => {
    instance[name] = definition.methods[name];
  });
  instance.observe = function observe(name, value) {
    this.data[name] = value;
    const observer = definition.observers && definition.observers[name];
    if (typeof observer === 'function') observer.call(this, value);
    const propertyObserver = definition.properties
      && definition.properties[name]
      && definition.properties[name].observer;
    if (typeof propertyObserver === 'function') propertyObserver.call(this, value);
  };
  instance.hidePage = function hidePage() {
    definition.pageLifetimes.hide.call(this);
  };
  instance.detach = function detach() {
    definition.lifetimes.detached.call(this);
  };
  instance.restore = function restore() {
    global.setInterval = nativeSetInterval;
    global.clearInterval = nativeClearInterval;
  };
  if (definition.lifetimes && typeof definition.lifetimes.attached === 'function') {
    definition.lifetimes.attached.call(instance);
  }
  instance._definition = definition;
  instance.getBackCount = () => backs;
  return instance;
}

function seedSensitiveState(component) {
  component.setData({
    password: 'Secret123',
    phone: '13800138000',
    code: '123456',
    challengeId: 'challenge-secret',
    sendingSms: true,
    sendingEmail: true,
    submitting: true,
    counting: true,
    countdown: 42
  });
  component._timer = setInterval(() => {}, 1000);
}

function assertSensitiveReset(component, message) {
  assert.strictEqual(component.data.password, '', `${message}: password`);
  assert.strictEqual(component.data.phone, '', `${message}: phone`);
  assert.strictEqual(component.data.code, '', `${message}: code`);
  assert.strictEqual(component.data.challengeId, '', `${message}: challenge`);
  assert.strictEqual(component.data.sendingSms, false, `${message}: SMS state`);
  assert.strictEqual(component.data.sendingEmail, false, `${message}: email state`);
  assert.strictEqual(component.data.submitting, false, `${message}: submitting state`);
  assert.strictEqual(component.data.counting, false, `${message}: countdown state`);
  assert.strictEqual(component.data.countdown, 60, `${message}: countdown value`);
  assert.strictEqual(component._timers.size, 0, `${message}: timer`);
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

async function assertInvalidatedRejectStaysSilent(options) {
  const expectedState = snapshot(options.getState());
  const expectedEffects = snapshot(options.getEffects());
  options.request.reject(options.error || codedError('AUTH_INTERNAL_ERROR'));
  await flushPromises();
  assert.deepStrictEqual(
    snapshot(options.getState()),
    expectedState,
    `${options.label}: an invalidated rejection must not rewrite state or loading flags.`
  );
  assert.deepStrictEqual(
    snapshot(options.getEffects()),
    expectedEffects,
    `${options.label}: an invalidated rejection must not toast, navigate, emit, or retry.`
  );
}

function loadDataFacade(facadeOptions = {}) {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  delete require.cache[require.resolve(dataPath)];
  const calls = [];
  const rotations = [];
  const revocations = [];
  const projections = [];
  const uiEffects = [];
  let token = 'session-old';
  const authSession = {
    getSession() {
      return token ? { sessionToken: token } : null;
    },
    sessionEnvelope(payload) {
      return Object.assign({ authProtocol: 2, clientInstanceId: 'client-stable', sessionToken: token }, payload);
    },
    anonymousEnvelope(payload) {
      return Object.assign({ authProtocol: 2, clientInstanceId: 'client-stable' }, payload);
    },
    applySessionProjection(expectedToken, result) {
      if (facadeOptions.applyProjection === false || token !== expectedToken) return false;
      projections.push({ expectedToken, result });
      return true;
    },
    commitSessionRotation(expectedToken, result) {
      if (facadeOptions.commitRotation === false || token !== expectedToken) return false;
      rotations.push({ expectedToken, result });
      token = result.sessionToken || 'session-new';
      return true;
    },
    clearSessionIfCurrent(expectedToken) {
      revocations.push(expectedToken);
      if (facadeOptions.clearSession === false || token !== expectedToken) return false;
      token = '';
      return true;
    }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === './auth-session') return authSession;
    if (request === '../utils/mock') return { getRole: () => 'member', ensureSeeded() {} };
    if (request === '../utils/color') return { levelFromMinutes: () => 0 };
    if (request === '../utils/billing') return {};
    if (request === '../utils/adminAuth') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  global.getApp = () => ({ globalData: { cloudReady: true } });
  global.wx = {
    cloud: {
      callFunction(callOptions) {
        calls.push(callOptions);
        if (typeof facadeOptions.transport === 'function') return facadeOptions.transport(callOptions);
        const action = callOptions.data && callOptions.data.action;
        if (action === 'logoutCurrent') {
          return Promise.resolve({ result: { ok: true, kind: 'session_revoked' } });
        }
        if (action === 'setPassword' || action === 'logoutOthers') {
          return Promise.resolve({
            result: { ok: true, kind: 'session_rotated', sessionToken: `session-new-${calls.length}` }
          });
        }
        if (action === 'status') return Promise.resolve({ result: securityStatus() });
        if (action === 'reauthenticate') {
          return Promise.resolve({ result: { ok: true, kind: 'reauthenticated' } });
        }
        if (['setAccountName', 'bindPhone', 'bindWechat', 'bindEmail'].indexOf(action) !== -1) {
          return Promise.resolve({ result: { ok: true, kind: 'security_mutation' } });
        }
        if (callOptions.name === 'sendSmsCode') {
          return Promise.resolve({
            result: { ok: true, challengeId: 'challenge-1', expiresIn: 300, resendAfter: 60 }
          });
        }
        if (callOptions.name === 'sendEmailCode') {
          return Promise.resolve({ result: { ok: true, accepted: true, msg: 'accepted' } });
        }
        return Promise.resolve({ result: { ok: true } });
      }
    },
    reLaunch(options) {
      uiEffects.push({ type: 'reLaunch', options });
    },
    showModal(options) {
      uiEffects.push({ type: 'showModal', options });
    },
    showToast(options) {
      uiEffects.push({ type: 'showToast', options });
    }
  };
  let data;
  try {
    data = require(dataPath);
  } finally {
    Module._load = originalLoad;
  }
  return {
    data,
    calls,
    rotations,
    revocations,
    projections,
    uiEffects,
    getToken: () => token,
    setToken(nextToken) {
      token = nextToken;
    }
  };
}

function callerPayload(call) {
  const payload = Object.assign({}, call.data);
  delete payload.authProtocol;
  delete payload.clientInstanceId;
  delete payload.sessionToken;
  delete payload.action;
  return payload;
}

async function testTypedDataFacadeContracts() {
  const harness = loadDataFacade();
  const cases = [
    ['getAccountSecurity', undefined, 'accountAuth', 'status', {}],
    ['sendSmsCode', { phone: '13800138000', purpose: 'bind_phone' }, 'sendSmsCode', undefined, { phone: '13800138000', purpose: 'bind_phone' }],
    ['sendSmsCode', { phone: '13800138000', purpose: 'reauth' }, 'sendSmsCode', undefined, { phone: '13800138000', purpose: 'reauth' }],
    ['sendEmailCode', { purpose: 'bind', email: 'member@example.com' }, 'sendEmailCode', undefined, { purpose: 'bind', email: 'member@example.com' }],
    ['sendEmailCode', { purpose: 'reauth' }, 'sendEmailCode', undefined, { purpose: 'reauth' }],
    ['reauthenticate', { method: 'password', password: 'Secret123' }, 'accountAuth', 'reauthenticate', { method: 'password', password: 'Secret123' }],
    ['reauthenticate', { method: 'phone', phone: '13800138000', challengeId: 'sms-1', code: '123456' }, 'accountAuth', 'reauthenticate', { method: 'phone', phone: '13800138000', challengeId: 'sms-1', code: '123456' }],
    ['reauthenticate', { method: 'email', code: '123456' }, 'accountAuth', 'reauthenticate', { method: 'email', code: '123456' }],
    ['reauthenticate', { method: 'wechat' }, 'accountAuth', 'reauthenticate', { method: 'wechat' }],
    ['setAccountName', { accountName: 'Member_01' }, 'accountAuth', 'setAccountName', { accountName: 'Member_01' }],
    ['setPassword', { password: 'Secret123' }, 'accountAuth', 'setPassword', { password: 'Secret123' }],
    ['bindPhone', { phone: '13800138000', challengeId: 'sms-2', code: '654321' }, 'accountAuth', 'bindPhone', { phone: '13800138000', challengeId: 'sms-2', code: '654321' }],
    ['bindEmail', { email: 'member@example.com', code: '123456' }, 'accountAuth', 'bindEmail', { email: 'member@example.com', code: '123456' }],
    ['bindWechat', undefined, 'accountAuth', 'bindWechat', {}],
    ['logoutOtherSessions', undefined, 'accountAuth', 'logoutOthers', {}]
  ];

  for (const [method, input, cloudName, action, expectedPayload] of cases) {
    assert.strictEqual(typeof harness.data[method], 'function', `${method} must be exported.`);
    const before = harness.calls.length;
    await (input === undefined ? harness.data[method]() : harness.data[method](input));
    const call = harness.calls[before];
    assert.strictEqual(call.name, cloudName, `${method} cloud route`);
    assert.strictEqual(call.data.action, action, `${method} controlled action`);
    assert.deepStrictEqual(callerPayload(call), expectedPayload, `${method} exact payload`);
  }
  assert.strictEqual(harness.rotations.length, 2, 'Password and logout-others rotations must be owned by the data boundary.');
  assert.strictEqual(harness.rotations[0].expectedToken, 'session-old');

  const secondHarness = loadDataFacade();
  await secondHarness.data.logoutCurrentSession();
  assert.strictEqual(secondHarness.calls[0].data.action, 'logoutCurrent');
  assert.deepStrictEqual(callerPayload(secondHarness.calls[0]), {});
  assert.deepStrictEqual(secondHarness.revocations, ['session-old'], 'Current logout must CAS-clear through the data boundary.');

  const beforeInvalid = harness.calls.length;
  await assert.rejects(
    harness.data.reauthenticate({ method: 'email', code: '123456', email: 'forged@example.com' }),
    (error) => error && error.code === 'INVALID_INPUT'
  );
  assert.strictEqual(harness.calls.length, beforeInvalid, 'Invalid proof fields must not reach cloud transport.');
  await assert.rejects(
    harness.data.sendEmailCode({ purpose: 'reauth', email: 'forged@example.com' }),
    (error) => error && error.code === 'INVALID_INPUT'
  );
  assert.strictEqual(harness.calls.length, beforeInvalid, 'Email reauth must reject a caller-supplied address.');
}

async function testFacadeSchemaAndSessionRaces() {
  const valid = loadDataFacade();
  const validStatus = await valid.data.getAccountSecurity();
  assert.deepStrictEqual(validStatus.roles, ['member', 'coach']);
  assert.strictEqual(validStatus.currentRole, 'coach');
  assert.strictEqual(valid.projections.length, 1, 'A real security status must reach session projection.');

  const malformed = loadDataFacade({
    transport: () => Promise.resolve({
      result: Object.assign(securityStatus(), { phoneMasked: '13800138000' })
    })
  });
  await assert.rejects(
    malformed.data.getAccountSecurity(),
    (error) => error && error.code === 'AUTH_INTERNAL_ERROR'
  );
  assert.strictEqual(malformed.projections.length, 0, 'Malformed security status must not reach session projection.');
  assert.strictEqual(malformed.uiEffects.length, 0, 'Malformed security status must have no UI side effect.');

  const malformedRoleCases = [
    { roles: 'member' },
    { roles: [] },
    { roles: ['member', 'member'] },
    { roles: ['member', 'admin'] },
    { roles: ['member'], currentRole: 'coach' },
    { currentRole: 42 }
  ];
  for (const overrides of malformedRoleCases) {
    const roleHarness = loadDataFacade({
      transport: () => Promise.resolve({ result: securityStatus(overrides) })
    });
    await assert.rejects(
      roleHarness.data.getAccountSecurity(),
      (error) => error && error.code === 'AUTH_INTERNAL_ERROR'
    );
    assert.strictEqual(roleHarness.projections.length, 0, 'Malformed roles must not reach session projection.');
    assert.strictEqual(roleHarness.uiEffects.length, 0, 'Malformed roles must have no UI side effect.');
  }

  const missingTopKey = securityStatus();
  delete missingTopKey.account;
  const missingSessionKey = Object.assign({}, securityStatus().currentSession);
  delete missingSessionKey.createdAt;
  const baseSession = securityStatus().currentSession;
  const malformedStatusCases = [
    ['top-level extra key', Object.assign(securityStatus(), { unexpected: true })],
    ['top-level missing key', missingTopKey],
    ['account type', securityStatus({ account: 42 })],
    ['credential boolean type', securityStatus({ passwordSet: 1 })],
    ['unbound phone mask', securityStatus({ phoneBound: false, phoneMasked: '' + '138****8000', reauthMethods: ['password', 'email', 'wechat'] })],
    ['bound phone mask', securityStatus({ phoneMasked: '13800138000' })],
    ['unbound email mask', securityStatus({ emailBound: false, emailMasked: 'm***@example.com', reauthMethods: ['password', 'phone', 'wechat'] })],
    ['bound email mask', securityStatus({ emailMasked: 'member@example.com' })],
    ['reauth method order', securityStatus({ reauthMethods: ['phone', 'password', 'email', 'wechat'] })],
    ['reauth method duplicate', securityStatus({ reauthMethods: ['password', 'phone', 'email', 'email'] })],
    ['session count type', securityStatus({ otherSessionCount: 1.5 })],
    ['session count range', securityStatus({ otherSessionCount: -1 })],
    ['current-session extra key', securityStatus({ currentSession: Object.assign({}, baseSession, { unexpected: true }) })],
    ['current-session missing key', securityStatus({ currentSession: missingSessionKey })],
    ['authentication method type', securityStatus({ currentSession: Object.assign({}, baseSession, { authenticationMethod: 42 }) })],
    ['epoch type', securityStatus({ currentSession: Object.assign({}, baseSession, { createdAt: '1784250000000' }) })],
    ['epoch beyond Date range', securityStatus({ currentSession: Object.assign({}, baseSession, { createdAt: Number.MAX_SAFE_INTEGER }) })],
    ['created after authentication', securityStatus({ currentSession: Object.assign({}, baseSession, { createdAt: baseSession.authenticatedAt + 1 }) })],
    ['created after last seen', securityStatus({ currentSession: Object.assign({}, baseSession, { createdAt: baseSession.lastSeenAt + 1 }) })],
    ['last seen at idle expiry', securityStatus({ currentSession: Object.assign({}, baseSession, { lastSeenAt: baseSession.idleExpiresAt }) })],
    ['created at absolute expiry', securityStatus({ currentSession: Object.assign({}, baseSession, { createdAt: baseSession.absoluteExpiresAt }) })],
    ['authentication at idle expiry', securityStatus({ currentSession: Object.assign({}, baseSession, { authenticatedAt: baseSession.idleExpiresAt }) })],
    ['authentication at absolute expiry', securityStatus({ currentSession: Object.assign({}, baseSession, { authenticatedAt: baseSession.absoluteExpiresAt }) })],
    ['last seen at absolute expiry', securityStatus({ currentSession: Object.assign({}, baseSession, { lastSeenAt: baseSession.absoluteExpiresAt }) })]
  ];
  for (const [label, status] of malformedStatusCases) {
    const statusHarness = loadDataFacade({
      transport: () => Promise.resolve({ result: status })
    });
    await assert.rejects(
      statusHarness.data.getAccountSecurity(),
      (error) => error && error.code === 'AUTH_INTERNAL_ERROR',
      `Malformed security status (${label}) must fail closed.`
    );
    assert.strictEqual(statusHarness.projections.length, 0, `${label} must not project.`);
    assert.strictEqual(statusHarness.uiEffects.length, 0, `${label} must have no UI effect.`);
  }

  const lateAuthentication = loadDataFacade({
    transport: () => Promise.resolve({
      result: securityStatus({
        currentSession: Object.assign({}, baseSession, {
          authenticatedAt: baseSession.lastSeenAt + 1000
        })
      })
    })
  });
  await lateAuthentication.data.getAccountSecurity();
  assert.strictEqual(
    lateAuthentication.projections.length,
    1,
    'A valid reauthentication timestamp may be later than a throttled lastSeenAt.'
  );

  const mutationResponse = deferred();
  const staleMutation = loadDataFacade({ transport: () => mutationResponse.promise });
  const mutationPromise = staleMutation.data.setAccountName({ accountName: 'Member_02' });
  staleMutation.setToken('newer-session');
  mutationResponse.resolve({ result: { ok: true, kind: 'security_mutation' } });
  await assert.rejects(mutationPromise, (error) => error && error.code === 'AUTH_ATTEMPT_STALE');

  const rotationResponse = deferred();
  const staleRotation = loadDataFacade({ transport: () => rotationResponse.promise });
  const rotationPromise = staleRotation.data.setPassword({ password: 'Secret123' });
  staleRotation.setToken('newer-session');
  rotationResponse.resolve({
    result: { ok: true, kind: 'session_rotated', sessionToken: 'request-rotation' }
  });
  await assert.rejects(rotationPromise, (error) => error && error.code === 'AUTH_ATTEMPT_STALE');

  const unappliedRotation = loadDataFacade({ commitRotation: false });
  await assert.rejects(
    unappliedRotation.data.setPassword({ password: 'Secret123' }),
    (error) => error && error.code === 'AUTH_INTERNAL_ERROR'
  );

  const logoutResponse = deferred();
  const staleLogout = loadDataFacade({ transport: () => logoutResponse.promise });
  const logoutPromise = staleLogout.data.logoutCurrentSession();
  staleLogout.setToken('newer-session');
  logoutResponse.resolve({ result: { ok: true, kind: 'session_revoked' } });
  await assert.rejects(logoutPromise, (error) => error && error.code === 'AUTH_ATTEMPT_STALE');

  const unclearedLogout = loadDataFacade({ clearSession: false });
  await assert.rejects(
    unclearedLogout.data.logoutCurrentSession(),
    (error) => error && error.code === 'AUTH_INTERNAL_ERROR'
  );
}

async function testFacadeRejectPathTokenGuard() {
  const serverFailure = deferred();
  const staleServerFailure = loadDataFacade({ transport: () => serverFailure.promise });
  const pendingMutation = staleServerFailure.data.setAccountName({ accountName: 'Member_03' });
  staleServerFailure.setToken('session-newer');
  serverFailure.resolve({ result: { ok: false, code: 'RECENT_AUTH_REQUIRED' } });
  await assert.rejects(
    pendingMutation,
    (error) => error && error.code === 'AUTH_ATTEMPT_STALE',
    'A server failure owned by an old token must become stale before page retry handling.'
  );
  assert.strictEqual(staleServerFailure.projections.length, 0);
  assert.strictEqual(staleServerFailure.uiEffects.length, 0);

  for (const code of [
    'SESSION_EXPIRED',
    'ROLE_NOT_ALLOWED',
    'AUTH_CONFLICT',
    'CLIENT_UPDATE_REQUIRED',
    'AUTH_MAINTENANCE'
  ]) {
    const response = deferred();
    const harness = loadDataFacade({ transport: () => response.promise });
    const pending = harness.data.setAccountName({ accountName: 'Member_09' });
    harness.setToken('session-newer');
    response.resolve({ result: { ok: false, code } });
    await assert.rejects(
      pending,
      (error) => error && error.code === 'AUTH_ATTEMPT_STALE',
      `${code} from an old token must become stale before error side effects.`
    );
    assert.strictEqual(harness.calls.length, 1, `${code} must not start a recovery refresh for T2.`);
    assert.strictEqual(harness.revocations.length, 0, `${code} must not clear T2.`);
    assert.strictEqual(harness.uiEffects.length, 0, `${code} must not show or relaunch for T2.`);
    assert.strictEqual(harness.getToken(), 'session-newer');
  }

  const transportFailure = deferred();
  const staleTransportFailure = loadDataFacade({ transport: () => transportFailure.promise });
  const pendingReauthentication = staleTransportFailure.data.reauthenticate({
    method: 'password',
    password: 'Secret123'
  });
  staleTransportFailure.setToken('session-newer');
  transportFailure.reject(new Error('private transport detail'));
  await assert.rejects(
    pendingReauthentication,
    (error) => error && error.code === 'AUTH_ATTEMPT_STALE',
    'A transport failure owned by an old token must become stale.'
  );
  assert.strictEqual(staleTransportFailure.projections.length, 0);
  assert.strictEqual(staleTransportFailure.uiEffects.length, 0);

  for (const code of ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'ACCOUNT_DISABLED']) {
    const sameResponse = loadDataFacade({
      transport: () => Promise.resolve({ result: { ok: false, code } })
    });
    await assert.rejects(
      sameResponse.data.setAccountName({ accountName: 'Member_04' }),
      (error) => error && error.code === code,
      `${code} must survive when that response successfully clears its own captured session.`
    );
    assert.strictEqual(sameResponse.getToken(), '');
  }

  const failedClear = loadDataFacade({
    clearSession: false,
    transport: () => Promise.resolve({ result: { ok: false, code: 'SESSION_EXPIRED' } })
  });
  await assert.rejects(
    failedClear.data.setAccountName({ accountName: 'Member_05' }),
    (error) => error && error.code === 'AUTH_INTERNAL_ERROR',
    'A failed clear with the captured token still current must fail closed.'
  );
  assert.strictEqual(failedClear.getToken(), 'session-old');
}

async function testEveryTask9FacadeRejectPathTokenGuard() {
  const cases = [
    ['getAccountSecurity', (data) => data.getAccountSecurity(), securityStatus()],
    ['sendSmsCode(bind)', (data) => data.sendSmsCode({ phone: '13800138000', purpose: 'bind_phone' }), {
      ok: true, challengeId: 'sms-bind', expiresIn: 300, resendAfter: 60
    }],
    ['sendSmsCode(reauth)', (data) => data.sendSmsCode({ phone: '13800138000', purpose: 'reauth' }), {
      ok: true, challengeId: 'sms-reauth', expiresIn: 300, resendAfter: 60
    }],
    ['sendEmailCode(bind)', (data) => data.sendEmailCode({ purpose: 'bind', email: 'member@example.com' }), {
      ok: true, accepted: true, msg: 'accepted'
    }],
    ['sendEmailCode(reauth)', (data) => data.sendEmailCode({ purpose: 'reauth' }), {
      ok: true, accepted: true, msg: 'accepted'
    }],
    ['reauthenticate', (data) => data.reauthenticate({ method: 'password', password: 'Secret123' }), {
      ok: true, kind: 'reauthenticated'
    }],
    ['setAccountName', (data) => data.setAccountName({ accountName: 'Member_08' }), {
      ok: true, kind: 'security_mutation'
    }],
    ['setPassword', (data) => data.setPassword({ password: 'Secret123' }), {
      ok: true, kind: 'session_rotated', sessionToken: 'request-rotation'
    }],
    ['bindPhone', (data) => data.bindPhone({ phone: '13800138000', challengeId: 'sms-4', code: '123456' }), {
      ok: true, kind: 'security_mutation'
    }],
    ['bindEmail', (data) => data.bindEmail({ email: 'member@example.com', code: '123456' }), {
      ok: true, kind: 'security_mutation'
    }],
    ['bindWechat', (data) => data.bindWechat(), { ok: true, kind: 'security_mutation' }],
    ['logoutCurrentSession', (data) => data.logoutCurrentSession(), {
      ok: true, kind: 'session_revoked'
    }],
    ['logoutOtherSessions', (data) => data.logoutOtherSessions(), {
      ok: true, kind: 'session_rotated', sessionToken: 'request-rotation'
    }]
  ];
  for (const [label, invoke, successResult] of cases) {
    for (const mode of ['success', 'server failure', 'transport failure']) {
      const response = deferred();
      const harness = loadDataFacade({ transport: () => response.promise });
      const pending = invoke(harness.data);
      harness.setToken('session-newer');
      if (mode === 'success') {
        response.resolve({ result: successResult });
      } else if (mode === 'server failure') {
        response.resolve({ result: { ok: false, code: 'RECENT_AUTH_REQUIRED' } });
      } else {
        response.reject(new Error('private transport detail'));
      }
      await assert.rejects(
        pending,
        (error) => error && error.code === 'AUTH_ATTEMPT_STALE',
        `${label} ${mode} must be stale after its captured token is replaced.`
      );
      assert.strictEqual(harness.getToken(), 'session-newer', `${label} must preserve the newer token.`);
      assert.strictEqual(harness.projections.length, 0, `${label} must not project stale data.`);
      assert.strictEqual(harness.rotations.length, 0, `${label} must not rotate a stale session.`);
      assert.strictEqual(harness.revocations.length, 0, `${label} must not revoke a newer session.`);
      assert.strictEqual(harness.uiEffects.length, 0, `${label} must have no stale UI side effect.`);
    }
  }
}

async function testFacadePersistencePostconditions() {
  const nonRotatingCases = [
    ['getAccountSecurity', undefined],
    ['sendSmsCode', { phone: '13800138000', purpose: 'bind_phone' }],
    ['sendEmailCode', { purpose: 'reauth' }],
    ['reauthenticate', { method: 'password', password: 'Secret123' }],
    ['setAccountName', { accountName: 'Member_06' }],
    ['bindPhone', { phone: '13800138000', challengeId: 'sms-3', code: '123456' }],
    ['bindEmail', { email: 'member@example.com', code: '123456' }],
    ['bindWechat', undefined]
  ];
  for (const [method, input] of nonRotatingCases) {
    const harness = loadDataFacade({ applyProjection: false });
    await assert.rejects(
      input === undefined ? harness.data[method]() : harness.data[method](input),
      (error) => error && error.code === 'AUTH_INTERNAL_ERROR',
      `${method} must fail closed when the old token remains current after projection persistence fails.`
    );
    assert.strictEqual(harness.getToken(), 'session-old');
  }

  for (const method of ['setPassword', 'logoutOtherSessions']) {
    const harness = loadDataFacade({ commitRotation: false });
    const pending = method === 'setPassword'
      ? harness.data.setPassword({ password: 'Secret123' })
      : harness.data.logoutOtherSessions();
    await assert.rejects(
      pending,
      (error) => error && error.code === 'AUTH_INTERNAL_ERROR',
      `${method} must fail closed when rotation persistence fails with the old token current.`
    );
    assert.strictEqual(harness.getToken(), 'session-old');
  }
}

async function testConflictRefreshValidatesSecurityStatus() {
  for (const code of ['AUTH_CONFLICT', 'ROLE_NOT_ALLOWED']) {
    let calls = 0;
    const harness = loadDataFacade({
      transport(call) {
        calls += 1;
        if (calls === 1) return Promise.resolve({ result: { ok: false, code } });
        assert.strictEqual(call.data.action, 'status');
        return Promise.resolve({ result: { ok: true, kind: 'security_status' } });
      }
    });
    await assert.rejects(
      harness.data.setAccountName({ accountName: 'Member_07' }),
      (error) => error && error.code === code
    );
    assert.strictEqual(calls, 2, `${code} must make one status refresh.`);
    assert.strictEqual(
      harness.projections.length,
      0,
      `${code} must not project an invalid recovery status.`
    );
    assert.strictEqual(
      harness.uiEffects.length,
      0,
      `${code} must not relaunch or open a role picker from an invalid recovery status.`
    );
  }

  for (const code of ['AUTH_CONFLICT', 'ROLE_NOT_ALLOWED']) {
    let calls = 0;
    const harness = loadDataFacade({
      transport() {
        calls += 1;
        return Promise.resolve({
          result: calls === 1 ? { ok: false, code } : securityStatus()
        });
      }
    });
    await assert.rejects(
      harness.data.setAccountName({ accountName: 'Member_10' }),
      (error) => error && error.code === code
    );
    assert.strictEqual(harness.projections.length, 1, `${code} may project one fully valid recovery status.`);
    assert.strictEqual(
      harness.uiEffects.filter((effect) => effect.type === 'reLaunch').length,
      code === 'ROLE_NOT_ALLOWED' ? 1 : 0,
      `${code} recovery relaunch contract.`
    );
  }
}

async function testSessionSendResponseContracts() {
  const validSms = { ok: true, challengeId: 'sms-valid', expiresIn: 300, resendAfter: 60 };
  const validEmail = { ok: true, accepted: true, msg: 'accepted' };
  const validSmsHarness = loadDataFacade({
    transport: () => Promise.resolve({ result: validSms })
  });
  assert.deepStrictEqual(
    await validSmsHarness.data.sendSmsCode({ phone: '13800138000', purpose: 'reauth' }),
    validSms
  );
  const validEmailHarness = loadDataFacade({
    transport: () => Promise.resolve({ result: validEmail })
  });
  assert.deepStrictEqual(
    await validEmailHarness.data.sendEmailCode({ purpose: 'reauth' }),
    validEmail
  );

  const malformedCases = [
    ['SMS pseudo rotation', 'sendSmsCode', { phone: '13800138000', purpose: 'bind_phone' }, {
      ok: true,
      kind: 'session_rotated',
      sessionToken: 'forged-rotation'
    }],
    ['SMS extra key', 'sendSmsCode', { phone: '13800138000', purpose: 'reauth' }, Object.assign({}, validSms, { kind: 'challenge' })],
    ['SMS empty challenge', 'sendSmsCode', { phone: '13800138000', purpose: 'reauth' }, Object.assign({}, validSms, { challengeId: '' })],
    ['SMS invalid expiry', 'sendSmsCode', { phone: '13800138000', purpose: 'reauth' }, Object.assign({}, validSms, { expiresIn: 0 })],
    ['SMS invalid resend', 'sendSmsCode', { phone: '13800138000', purpose: 'reauth' }, Object.assign({}, validSms, { resendAfter: -1 })],
    ['Email pseudo rotation', 'sendEmailCode', { purpose: 'bind', email: 'member@example.com' }, {
      ok: true,
      kind: 'session_rotated',
      sessionToken: 'forged-rotation'
    }],
    ['Email extra key', 'sendEmailCode', { purpose: 'reauth' }, Object.assign({}, validEmail, { kind: 'challenge' })],
    ['Email not accepted', 'sendEmailCode', { purpose: 'reauth' }, Object.assign({}, validEmail, { accepted: false })],
    ['Email invalid message', 'sendEmailCode', { purpose: 'reauth' }, Object.assign({}, validEmail, { msg: 42 })]
  ];
  for (const [label, method, input, response] of malformedCases) {
    const harness = loadDataFacade({
      transport: () => Promise.resolve({ result: response })
    });
    await assert.rejects(
      harness.data[method](input),
      (error) => error && error.code === 'AUTH_INTERNAL_ERROR',
      `${label} must fail before any session side effect.`
    );
    assert.strictEqual(harness.getToken(), 'session-old', `${label} must not rotate the token.`);
    assert.strictEqual(harness.projections.length, 0, `${label} must not project a session.`);
    assert.strictEqual(harness.rotations.length, 0, `${label} must not commit a rotation.`);
  }
}

async function testRecentAuthFilteringRequestsAndReset() {
  const reauthCalls = [];
  const smsCalls = [];
  const emailCalls = [];
  const phoneSend = deferred();
  const component = loadRecentAuth({
    sendSmsCode(payload) {
      smsCalls.push(payload);
      return phoneSend.promise;
    },
    sendEmailCode(payload) {
      emailCalls.push(payload);
      return Promise.resolve({});
    },
    reauthenticate(payload) {
      reauthCalls.push(payload);
      return Promise.resolve({});
    }
  });

  component.observe('methods', ['phone', 'forged', 'password', 'phone', 'email', 'wechat', null]);
  assert.deepStrictEqual(component.data.availableMethods, ['phone', 'password', 'email', 'wechat']);

  component.setData({ selectedMethod: 'phone' });
  component.onPhoneInput({ detail: { value: '13800138000' } });
  component.sendPhoneCode();
  component.sendPhoneCode();
  assert.deepStrictEqual(smsCalls, [{ phone: '13800138000', purpose: 'reauth' }]);
  component.onPhoneInput({ detail: { value: '13900139000' } });
  phoneSend.resolve({ challengeId: 'late-challenge' });
  await flushPromises();
  assert.strictEqual(component.data.challengeId, '', 'Editing the phone must suppress a late challenge.');

  component.setData({ selectedMethod: 'email' });
  component.sendBoundEmailCode();
  component.sendBoundEmailCode();
  await flushPromises();
  assert.deepStrictEqual(emailCalls, [{ purpose: 'reauth' }], 'Email reauth must never accept an email address.');
  component.onCodeInput({ detail: { value: '123456' } });
  component.submit();
  await flushPromises();
  assert.deepStrictEqual(reauthCalls[0], { method: 'email', code: '123456' });
  assertSensitiveReset(component, 'successful authentication');
  assert.strictEqual(component._events.length, 1);
  assert.strictEqual(component._events[0].name, 'authenticated');
  assert.strictEqual(component._events[0].snapshot.code, '', 'Reset must happen before authenticated is emitted.');

  const proofCases = [
    ['password', { password: 'Secret123', code: '999999' }, { method: 'password', password: 'Secret123' }],
    ['phone', { phone: '13800138000', challengeId: 'sms-3', code: '123456' }, { method: 'phone', phone: '13800138000', challengeId: 'sms-3', code: '123456' }],
    ['wechat', {}, { method: 'wechat' }]
  ];
  for (const [method, fields, expected] of proofCases) {
    component.observe('methods', [method]);
    component.setData(Object.assign({ selectedMethod: method }, fields));
    component.submit();
    await flushPromises();
    assert.deepStrictEqual(reauthCalls[reauthCalls.length - 1], expected);
  }
  component.restore();
}

async function testRecentAuthAllClosePathsAndLateSuppression() {
  const pending = deferred();
  const component = loadRecentAuth({
    reauthenticate() {
      return pending.promise;
    },
    sendSmsCode() {
      return Promise.resolve({ challengeId: 'challenge' });
    },
    sendEmailCode() {
      return Promise.resolve({});
    }
  });
  component.observe('methods', ['password']);
  component.setData({ selectedMethod: 'password', password: 'Secret123' });
  component.submit();
  component.hidePage();
  assertSensitiveReset(component, 'page hide');
  pending.resolve({});
  await flushPromises();
  assert.strictEqual(component._events.length, 0, 'A hidden component must suppress late authentication.');

  seedSensitiveState(component);
  component.cancel();
  assertSensitiveReset(component, 'cancel');
  const cancelEvent = component._events[0];
  assert.strictEqual(cancelEvent.name, 'cancel');
  assert.strictEqual(cancelEvent.snapshot.password, '', 'Reset must happen before cancel is emitted.');
  component.observe('visible', true);
  assertSensitiveReset(component, 'reopen after cancel');

  seedSensitiveState(component);
  component.observe('visible', false);
  assertSensitiveReset(component, 'parent close');
  component.observe('visible', true);
  assertSensitiveReset(component, 'reopen after parent close');

  seedSensitiveState(component);
  component.detach();
  assertSensitiveReset(component, 'detach');
  component.restore();

  const editedProof = deferred();
  const editedComponent = loadRecentAuth({
    reauthenticate() {
      return editedProof.promise;
    },
    sendSmsCode() {
      return Promise.resolve({ challengeId: 'challenge' });
    },
    sendEmailCode() {
      return Promise.resolve({});
    }
  });
  editedComponent.observe('methods', ['password']);
  editedComponent.onPasswordInput({ detail: { value: 'Secret123' } });
  editedComponent.submit();
  editedComponent.onPasswordInput({ detail: { value: 'Changed123' } });
  editedProof.resolve({});
  await flushPromises();
  assert.strictEqual(editedComponent._events.length, 0, 'Editing a proof must suppress late authentication.');
  assert.strictEqual(editedComponent.data.submitting, false);
  editedComponent.restore();

  const editedCodeProof = deferred();
  const editedCodeComponent = loadRecentAuth({
    reauthenticate() {
      return editedCodeProof.promise;
    },
    sendSmsCode() {
      return Promise.resolve({ challengeId: 'challenge' });
    },
    sendEmailCode() {
      return Promise.resolve({});
    }
  });
  editedCodeComponent.observe('methods', ['email']);
  editedCodeComponent.onCodeInput({ detail: { value: '123456' } });
  editedCodeComponent.submit();
  editedCodeComponent.onCodeInput({ detail: { value: '654321' } });
  editedCodeProof.resolve({});
  await flushPromises();
  assert.strictEqual(editedCodeComponent._events.length, 0, 'Editing a code must suppress late authentication.');
  assert.strictEqual(editedCodeComponent.data.submitting, false);
  editedCodeComponent.restore();
}

async function testRecentAuthPhoneSendInvalidatesOldProof() {
  const oldProof = deferred();
  const newSend = deferred();
  const component = loadRecentAuth({
    reauthenticate() {
      return oldProof.promise;
    },
    sendSmsCode() {
      return newSend.promise;
    },
    sendEmailCode() {
      return Promise.resolve({});
    }
  });
  component.observe('methods', ['phone']);
  component.setData({
    selectedMethod: 'phone',
    phone: '13800138000',
    challengeId: 'old-challenge',
    code: '123456'
  });
  component.submit();
  assert.strictEqual(component.data.submitting, true);
  component.sendPhoneCode();
  assert.strictEqual(
    component.data.submitting,
    false,
    'Sending a new phone code must invalidate and release an older proof submission.'
  );
  oldProof.resolve({});
  await flushPromises();
  assert.strictEqual(component._events.length, 0, 'An old phone proof must not authenticate after a newer send.');
  component.detach();
  component.restore();
}

async function testRecentAuthEmailSendInvalidatesOldProof() {
  const oldProof = deferred();
  const newSend = deferred();
  const component = loadRecentAuth({
    reauthenticate() {
      return oldProof.promise;
    },
    sendSmsCode() {
      return Promise.resolve({ challengeId: 'unused' });
    },
    sendEmailCode() {
      return newSend.promise;
    }
  });
  component.observe('methods', ['email']);
  component.setData({ selectedMethod: 'email', code: '123456' });
  component.submit();
  assert.strictEqual(component.data.submitting, true);
  component.sendBoundEmailCode();
  assert.strictEqual(
    component.data.submitting,
    false,
    'Sending a new email code must invalidate and release an older proof submission.'
  );
  oldProof.resolve({});
  await flushPromises();
  assert.strictEqual(component._events.length, 0, 'An old email proof must not authenticate after a newer send.');
  component.detach();
  component.restore();
}

async function testRecentAuthCurrentStaleFailuresStaySilent() {
  const sms = loadRecentAuth({
    sendSmsCode: () => Promise.reject(codedError('AUTH_ATTEMPT_STALE')),
    sendEmailCode: () => Promise.resolve({}),
    reauthenticate: () => Promise.resolve({})
  });
  sms.observe('methods', ['phone']);
  sms.onPhoneInput({ detail: { value: '13800138000' } });
  sms.sendPhoneCode();
  await flushPromises();
  assert.strictEqual(sms.data.sendingSms, false);
  assert.strictEqual(sms._toasts.length, 0, 'A current stale SMS send must stay silent.');
  sms.restore();

  const email = loadRecentAuth({
    sendSmsCode: () => Promise.resolve({ challengeId: 'unused' }),
    sendEmailCode: () => Promise.reject(codedError('AUTH_ATTEMPT_STALE')),
    reauthenticate: () => Promise.resolve({})
  });
  email.observe('methods', ['email']);
  email.sendBoundEmailCode();
  await flushPromises();
  assert.strictEqual(email.data.sendingEmail, false);
  assert.strictEqual(email._toasts.length, 0, 'A current stale email send must stay silent.');
  email.restore();

  const submit = loadRecentAuth({
    sendSmsCode: () => Promise.resolve({ challengeId: 'unused' }),
    sendEmailCode: () => Promise.resolve({}),
    reauthenticate: () => Promise.reject(codedError('AUTH_ATTEMPT_STALE'))
  });
  submit.observe('methods', ['password']);
  submit.onPasswordInput({ detail: { value: 'Secret123' } });
  submit.submit();
  await flushPromises();
  assert.strictEqual(submit.data.submitting, false);
  assert.strictEqual(submit._toasts.length, 0, 'A current stale reauthentication must stay silent.');
  assert.strictEqual(submit._events.length, 0);
  submit.restore();
}

async function testRecentAuthInvalidatedRejectsStaySilent() {
  const oldSms = deferred();
  const newSms = deferred();
  let smsCalls = 0;
  const sms = loadRecentAuth({
    sendSmsCode() {
      smsCalls += 1;
      return smsCalls === 1 ? oldSms.promise : newSms.promise;
    },
    sendEmailCode: () => Promise.resolve({}),
    reauthenticate: () => Promise.resolve({})
  });
  sms.observe('methods', ['phone']);
  sms.onPhoneInput({ detail: { value: '13800138000' } });
  sms.sendPhoneCode();
  sms.onPhoneInput({ detail: { value: '13900139000' } });
  sms.sendPhoneCode();
  assert.strictEqual(sms.data.sendingSms, true, 'The replacement SMS send must own the loading state.');
  await assertInvalidatedRejectStaysSilent({
    label: 'Recent-auth SMS send invalidated by phone edit and resend',
    request: oldSms,
    getState: () => ({ data: sms.data, timerCount: sms._timers.size }),
    getEffects: () => ({
      toasts: sms._toasts.length,
      modals: sms._modals.length,
      navigations: sms._navigations.length,
      backs: sms.getBackCount(),
      events: sms._events.length,
      smsCalls
    })
  });
  assert.strictEqual(sms.data.sendingSms, true, 'The old rejection must not clear the replacement SMS loading state.');
  newSms.resolve({ challengeId: 'new-sms-challenge' });
  await flushPromises();
  assert.strictEqual(sms.data.challengeId, 'new-sms-challenge');
  sms.detach();
  sms.restore();

  const oldEmail = deferred();
  const newEmail = deferred();
  let emailCalls = 0;
  const email = loadRecentAuth({
    sendSmsCode: () => Promise.resolve({ challengeId: 'unused' }),
    sendEmailCode() {
      emailCalls += 1;
      return emailCalls === 1 ? oldEmail.promise : newEmail.promise;
    },
    reauthenticate: () => Promise.resolve({})
  });
  email.observe('methods', ['email']);
  email.sendBoundEmailCode();
  email.hidePage();
  email.observe('visible', true);
  email.sendBoundEmailCode();
  assert.strictEqual(email.data.sendingEmail, true, 'The reopened email send must own the loading state.');
  await assertInvalidatedRejectStaysSilent({
    label: 'Recent-auth email send invalidated by page hide',
    request: oldEmail,
    error: new Error('late email transport failure'),
    getState: () => ({ data: email.data, timerCount: email._timers.size }),
    getEffects: () => ({
      toasts: email._toasts.length,
      modals: email._modals.length,
      navigations: email._navigations.length,
      backs: email.getBackCount(),
      events: email._events.length,
      emailCalls
    })
  });
  assert.strictEqual(email.data.sendingEmail, true, 'The hidden request rejection must not clear the reopened send.');
  newEmail.resolve({});
  await flushPromises();
  email.detach();
  email.restore();

  const oldProof = deferred();
  const newProof = deferred();
  let proofCalls = 0;
  const proof = loadRecentAuth({
    sendSmsCode: () => Promise.resolve({ challengeId: 'unused' }),
    sendEmailCode: () => Promise.resolve({}),
    reauthenticate() {
      proofCalls += 1;
      return proofCalls === 1 ? oldProof.promise : newProof.promise;
    }
  });
  proof.observe('methods', ['password']);
  proof.onPasswordInput({ detail: { value: 'Secret123' } });
  proof.submit();
  proof.onPasswordInput({ detail: { value: 'Changed123' } });
  proof.submit();
  assert.strictEqual(proof.data.submitting, true, 'The edited proof must own the replacement submit state.');
  await assertInvalidatedRejectStaysSilent({
    label: 'Recent-auth submit invalidated by proof edit',
    request: oldProof,
    getState: () => ({ data: proof.data, timerCount: proof._timers.size }),
    getEffects: () => ({
      toasts: proof._toasts.length,
      modals: proof._modals.length,
      navigations: proof._navigations.length,
      backs: proof.getBackCount(),
      events: proof._events.length,
      proofCalls
    })
  });
  assert.strictEqual(proof.data.submitting, true, 'The old proof rejection must not clear the replacement submit.');
  newProof.resolve({});
  await flushPromises();
  assert.strictEqual(proof._events.length, 1, 'The replacement proof must remain able to authenticate.');
  proof.detach();
  proof.restore();
}

async function testAccountSecurityServerProjectionAndNavigation() {
  const status = {
    account: 'Member_01',
    accountNameSet: true,
    passwordSet: true,
    phoneBound: true,
    phoneMasked: '138****8000',
    phone: '13900139000',
    emailBound: true,
    emailMasked: 'm***@example.com',
    wechatBound: true,
    reauthMethods: ['password'],
    currentSession: {
      createdAt: 1784250000000,
      lastSeenAt: 1784253600000,
      authenticatedAt: 1784253000000,
      absoluteExpiresAt: 1792026000000,
      authenticationMethod: 'password'
    },
    otherSessionCount: 2
  };
  const page = loadPage('miniprogram/pages/settings/account-security/index.js', {
    getAccountSecurity: () => Promise.resolve(status)
  });
  page.onShow();
  await flushPromises();
  assert.strictEqual(page.data.accountText, 'Member_01');
  assert.strictEqual(page.data.phoneText, '138****8000');
  assert.notStrictEqual(page.data.phoneText, status.phone, 'Raw phone must be ignored.');
  assert.strictEqual(page.data.emailText, 'm***@example.com');
  assert(page.data.currentSessionText.includes('密码'));
  assert(page.data.currentSessionText.includes('2026'), 'Current-session summary should include a safe server epoch.');
  assert(page.data.otherSessionText.includes('2'));
  page.onAccountName();
  page.onPhone();
  page.onEmail();
  page.onWechat();
  assert.deepStrictEqual(page._records.navigations, [], 'Bound one-time credentials must be display-only.');
  assert.strictEqual(page._records.modals.length, 0, 'Bound WeChat must not offer rebind.');

  const unboundPage = loadPage('miniprogram/pages/settings/account-security/index.js', {
    getAccountSecurity: () => Promise.resolve({
      accountNameSet: false,
      passwordSet: false,
      phoneBound: false,
      emailBound: false,
      wechatBound: false,
      reauthMethods: []
    })
  });
  unboundPage.onShow();
  await flushPromises();
  unboundPage.onAccountName();
  unboundPage.onPassword();
  unboundPage.onPhone();
  unboundPage.onEmail();
  assert.deepStrictEqual(unboundPage._records.navigations, [
    '/pages/settings/account-security/account-name/index',
    '/pages/settings/account-security/password/index',
    '/pages/settings/account-security/phone-binding/index',
    '/pages/settings/email-binding/index'
  ]);

  const failedCalls = { bind: 0, logout: 0 };
  const failedPage = loadPage('miniprogram/pages/settings/account-security/index.js', {
    getAccountSecurity: () => Promise.reject(codedError('AUTH_INTERNAL_ERROR')),
    bindWechat() {
      failedCalls.bind += 1;
      return Promise.resolve({});
    },
    logoutOtherSessions() {
      failedCalls.logout += 1;
      return Promise.resolve({});
    }
  });
  failedPage.onShow();
  await flushPromises();
  assert.strictEqual(failedPage.data.statusReady, false);
  failedPage.onWechat();
  failedPage.onLogoutOtherSessions();
  assert.strictEqual(failedPage._records.modals.length, 0);
  assert.deepStrictEqual(failedCalls, { bind: 0, logout: 0 }, 'Unknown status must disable sensitive actions.');
}

async function testAccountSecurityWechatRetryOnceAndLogoutOthers() {
  let statusCalls = 0;
  let bindCalls = 0;
  const logoutRequest = deferred();
  let logoutCalls = 0;
  const status = {
    accountNameSet: false,
    passwordSet: true,
    phoneBound: true,
    phoneMasked: '138****8000',
    emailBound: true,
    emailMasked: 'm***@example.com',
    wechatBound: false,
    reauthMethods: ['wechat', 'password', 'phone', 'password', 'email', 'forged'],
    otherSessionCount: 2
  };
  const page = loadPage('miniprogram/pages/settings/account-security/index.js', {
    getAccountSecurity() {
      statusCalls += 1;
      return Promise.resolve(statusCalls === 1
        ? status
        : Object.assign({}, status, { reauthMethods: ['email', 'password', 'email'] }));
    },
    bindWechat() {
      bindCalls += 1;
      return bindCalls === 1
        ? Promise.reject(codedError('RECENT_AUTH_REQUIRED', 'internal account detail'))
        : Promise.resolve({});
    },
    logoutOtherSessions() {
      logoutCalls += 1;
      return logoutRequest.promise;
    }
  });
  page.onShow();
  await flushPromises();
  page.onWechat();
  assert.strictEqual(page._records.modals[0].content, '是否绑定当前微信？绑定后，后续可直接使用微信登录。');
  resolveModal(page, 0, false);
  assert.strictEqual(bindCalls, 0, 'Cancelling WeChat confirmation must make no request.');
  page.onWechat();
  resolveModal(page, 1, true);
  await flushPromises();
  assert.strictEqual(bindCalls, 1);
  assert.strictEqual(page.data.recentAuthVisible, true);
  assert.deepStrictEqual(
    page.data.recentAuthMethods,
    ['email', 'password'],
    'Recent auth must use a fresh server method list and still exclude first-binding WeChat.'
  );
  page.onRecentAuthenticated();
  await flushPromises();
  assert.strictEqual(bindCalls, 2, 'The already-confirmed action must retry exactly once.');
  assert(statusCalls >= 2, 'Status may refresh only after bind resolves.');

  page.onLogoutOtherSessions();
  page.onLogoutOtherSessions();
  assert.strictEqual(logoutCalls, 1, 'Logout-others must be single-flight.');
  logoutRequest.resolve({});
  await flushPromises();
  assert.strictEqual(page.data.actionPending, false);

  let freshBoundStatusCalls = 0;
  let freshBoundBindCalls = 0;
  const freshBoundPage = loadPage('miniprogram/pages/settings/account-security/index.js', {
    getAccountSecurity() {
      freshBoundStatusCalls += 1;
      return Promise.resolve(freshBoundStatusCalls === 1
        ? { wechatBound: false, reauthMethods: ['password'], otherSessionCount: 0 }
        : { wechatBound: true, reauthMethods: ['password'], otherSessionCount: 0 });
    },
    bindWechat() {
      freshBoundBindCalls += 1;
      return Promise.reject(codedError('RECENT_AUTH_REQUIRED'));
    }
  });
  freshBoundPage.onShow();
  await flushPromises();
  freshBoundPage.onWechat();
  resolveModal(freshBoundPage, 0, true);
  await flushPromises();
  assert.strictEqual(freshBoundBindCalls, 1);
  assert.strictEqual(freshBoundPage.data.wechatBound, true, 'Freshly bound WeChat must become display-only.');
  assert.strictEqual(freshBoundPage.data.recentAuthVisible, false, 'Freshly bound WeChat must not open recent auth.');
}

async function testAccountSecuritySecondRecentAuthAndLifecycleFailClosed() {
  let calls = 0;
  const page = loadPage('miniprogram/pages/settings/account-security/index.js', {
    getAccountSecurity: () => Promise.resolve({
      wechatBound: false,
      reauthMethods: ['password'],
      otherSessionCount: 0
    }),
    bindWechat() {
      calls += 1;
      return Promise.reject(codedError('RECENT_AUTH_REQUIRED', 'raw server message'));
    }
  });
  page.onShow();
  await flushPromises();
  page.onWechat();
  resolveModal(page, 0, true);
  await flushPromises();
  page.onRecentAuthenticated();
  await flushPromises();
  assert.strictEqual(calls, 2);
  assert.strictEqual(page.data.recentAuthVisible, false, 'A second recent-auth demand must not loop.');
  assert(page._records.toasts.length > 0);
  assert(!/raw server message/.test(page._records.toasts[page._records.toasts.length - 1].title));

  const late = deferred();
  const hiddenPage = loadPage('miniprogram/pages/settings/account-security/index.js', {
    getAccountSecurity: () => Promise.resolve({ wechatBound: false, reauthMethods: ['password'] }),
    bindWechat: () => late.promise
  });
  hiddenPage.onShow();
  await flushPromises();
  hiddenPage.onWechat();
  resolveModal(hiddenPage, 0, true);
  hiddenPage.onHide();
  assert.strictEqual(hiddenPage.data.statusReady, false, 'A hidden parent page must require fresh status.');
  assert.strictEqual(hiddenPage.data.recentAuthVisible, false, 'A hidden parent page must close recent auth.');
  late.resolve({});
  await flushPromises();
  assert.strictEqual(hiddenPage._records.toasts.length, 0);
  assert.strictEqual(hiddenPage._records.navigations.length, 0);
}

async function testAccountNameOneTimeAndRecentAuth() {
  let status = {
    account: 'Member_01',
    accountNameSet: true,
    reauthMethods: ['password']
  };
  const calls = [];
  const page = loadPage('miniprogram/pages/settings/account-security/account-name/index.js', {
    getAccountSecurity: () => Promise.resolve(status),
    setAccountName(payload) {
      calls.push(payload);
      return Promise.resolve({});
    }
  });
  page.onShow();
  await flushPromises();
  assert.strictEqual(page.data.displayOnly, true);
  assert.strictEqual(page.data.accountName, 'Member_01');
  page.submit();
  assert.deepStrictEqual(calls, [], 'A set account name must never be renamed.');

  status = { accountNameSet: false, reauthMethods: ['email', 'email', 'forged'] };
  let attempts = 0;
  const unsetPage = loadPage('miniprogram/pages/settings/account-security/account-name/index.js', {
    getAccountSecurity: () => Promise.resolve(status),
    setAccountName(payload) {
      calls.push(payload);
      attempts += 1;
      return attempts === 1
        ? Promise.reject(codedError('RECENT_AUTH_REQUIRED'))
        : Promise.resolve({});
    }
  });
  unsetPage.onShow();
  await flushPromises();
  unsetPage.onAccountNameInput({ detail: { value: '1bad' } });
  unsetPage.submit();
  assert.strictEqual(attempts, 0);
  unsetPage.onAccountNameInput({ detail: { value: ' Member_02 ' } });
  unsetPage.submit();
  await flushPromises();
  assert.deepStrictEqual(calls[calls.length - 1], { accountName: 'Member_02' });
  assert.deepStrictEqual(unsetPage.data.recentAuthMethods, ['email']);
  unsetPage.onRecentAuthenticated();
  await flushPromises();
  assert.strictEqual(attempts, 2);
  assert.strictEqual(unsetPage._records.backs, 1);

  const lateMutation = deferred();
  const latePage = loadPage('miniprogram/pages/settings/account-security/account-name/index.js', {
    getAccountSecurity: () => Promise.resolve({ accountNameSet: false, reauthMethods: [] }),
    setAccountName: () => lateMutation.promise
  });
  latePage.onShow();
  await flushPromises();
  latePage.onAccountNameInput({ detail: { value: 'Member_04' } });
  latePage.submit();
  latePage.onAccountNameInput({ detail: { value: 'Member_05' } });
  lateMutation.resolve({});
  await flushPromises();
  assert.strictEqual(latePage._records.backs, 0, 'Editing account name must suppress late success navigation.');
  assert.strictEqual(latePage._records.toasts.length, 0, 'Editing account name must suppress late feedback.');
  latePage.onHide();
  assert.strictEqual(latePage.data.statusReady, false, 'A hidden account-name page must require fresh status.');
  assert.strictEqual(latePage.data.accountName, '', 'A hidden account-name page must clear its pending value.');

  let freshStatusCalls = 0;
  let alreadySetAttempts = 0;
  const alreadySetPage = loadPage('miniprogram/pages/settings/account-security/account-name/index.js', {
    getAccountSecurity() {
      freshStatusCalls += 1;
      return Promise.resolve(freshStatusCalls === 1
        ? { accountNameSet: false, reauthMethods: ['password'] }
        : { accountNameSet: true, account: 'Member_06', reauthMethods: ['password'] });
    },
    setAccountName() {
      alreadySetAttempts += 1;
      return Promise.reject(codedError('RECENT_AUTH_REQUIRED'));
    }
  });
  alreadySetPage.onShow();
  await flushPromises();
  alreadySetPage.onAccountNameInput({ detail: { value: 'Member_07' } });
  alreadySetPage.submit();
  await flushPromises();
  assert.strictEqual(alreadySetAttempts, 1);
  assert.strictEqual(alreadySetPage.data.displayOnly, true, 'Freshly set account name must become display-only.');
  assert.strictEqual(alreadySetPage.data.accountName, 'Member_06');
  assert.strictEqual(alreadySetPage.data.recentAuthVisible, false, 'Already-set account name must not open recent auth.');

  const stalePage = loadPage('miniprogram/pages/settings/account-security/account-name/index.js', {
    getAccountSecurity: () => Promise.resolve({ accountNameSet: false, reauthMethods: ['password'] }),
    setAccountName: () => Promise.reject(codedError('AUTH_ATTEMPT_STALE', 'internal stale detail'))
  });
  stalePage.onShow();
  await flushPromises();
  stalePage.onAccountNameInput({ detail: { value: 'Member_03' } });
  stalePage.submit();
  await flushPromises();
  assert.strictEqual(stalePage._records.toasts.length, 0, 'Stale credential mutation must stay silent.');
  assert.strictEqual(stalePage._records.backs, 0);
}

async function testPasswordSetChangeAndCircularMethodFiltering() {
  let attempts = 0;
  const calls = [];
  const page = loadPage('miniprogram/pages/settings/account-security/password/index.js', {
    getAccountSecurity: () => Promise.resolve({
      passwordSet: false,
      reauthMethods: ['password', 'wechat', 'password']
    }),
    setPassword(payload) {
      calls.push(payload);
      attempts += 1;
      return attempts === 1
        ? Promise.reject(codedError('RECENT_AUTH_REQUIRED'))
        : Promise.resolve({});
    }
  });
  page.onShow();
  await flushPromises();
  assert.strictEqual(page.data.passwordSet, false);
  assert.strictEqual(page.data.titleText, '设置登录密码');
  page.onPasswordInput({ detail: { value: 'Secret123' } });
  page.onConfirmInput({ detail: { value: 'Mismatch' } });
  page.submit();
  assert.strictEqual(attempts, 0);
  page.onConfirmInput({ detail: { value: 'Secret123' } });
  page.submit();
  await flushPromises();
  assert.deepStrictEqual(calls, [{ password: 'Secret123' }]);
  assert.deepStrictEqual(page.data.recentAuthMethods, ['wechat'], 'First password set cannot use password reauth.');
  page.onRecentAuthenticated();
  await flushPromises();
  assert.strictEqual(attempts, 2);

  const changePage = loadPage('miniprogram/pages/settings/account-security/password/index.js', {
    getAccountSecurity: () => Promise.resolve({ passwordSet: true, reauthMethods: ['password'] }),
    setPassword: () => Promise.reject(codedError('RECENT_AUTH_REQUIRED'))
  });
  changePage.onShow();
  await flushPromises();
  assert.strictEqual(changePage.data.titleText, '修改登录密码');
  changePage.onPasswordInput({ detail: { value: 'Changed123' } });
  changePage.onConfirmInput({ detail: { value: 'Changed123' } });
  changePage.submit();
  await flushPromises();
  assert.deepStrictEqual(changePage.data.recentAuthMethods, ['password'], 'Password change may use the current password.');

  const lateMutation = deferred();
  const latePage = loadPage('miniprogram/pages/settings/account-security/password/index.js', {
    getAccountSecurity: () => Promise.resolve({ passwordSet: true, reauthMethods: ['password'] }),
    setPassword: () => lateMutation.promise
  });
  latePage.onShow();
  await flushPromises();
  latePage.onPasswordInput({ detail: { value: 'Original123' } });
  latePage.onConfirmInput({ detail: { value: 'Original123' } });
  latePage.submit();
  latePage.onPasswordInput({ detail: { value: 'Changed123' } });
  lateMutation.resolve({});
  await flushPromises();
  assert.strictEqual(latePage._records.backs, 0, 'Editing password must suppress late success navigation.');
  assert.strictEqual(latePage._records.toasts.length, 0, 'Editing password must suppress late feedback.');
  latePage.onHide();
  assert.strictEqual(latePage.data.statusReady, false, 'A hidden password page must require fresh status.');
  assert.strictEqual(latePage.data.password, '');
  assert.strictEqual(latePage.data.confirmPassword, '');

  let freshStatusCalls = 0;
  const freshMethodPage = loadPage('miniprogram/pages/settings/account-security/password/index.js', {
    getAccountSecurity() {
      freshStatusCalls += 1;
      return Promise.resolve(freshStatusCalls === 1
        ? { passwordSet: true, reauthMethods: ['password'] }
        : { passwordSet: false, reauthMethods: ['password', 'wechat'] });
    },
    setPassword: () => Promise.reject(codedError('RECENT_AUTH_REQUIRED'))
  });
  freshMethodPage.onShow();
  await flushPromises();
  freshMethodPage.onPasswordInput({ detail: { value: 'Fresh123' } });
  freshMethodPage.onConfirmInput({ detail: { value: 'Fresh123' } });
  freshMethodPage.submit();
  await flushPromises();
  assert.strictEqual(freshMethodPage.data.passwordSet, false);
  assert.strictEqual(freshMethodPage.data.titleText, '设置登录密码');
  assert.deepStrictEqual(
    freshMethodPage.data.recentAuthMethods,
    ['wechat'],
    'Fresh first-set status must exclude password as a circular method.'
  );
}

async function testPhoneBindingProofOwnershipAndBoundDisplay() {
  const boundCalls = { send: 0, bind: 0 };
  const boundPage = loadPage('miniprogram/pages/settings/account-security/phone-binding/index.js', {
    getAccountSecurity: () => Promise.resolve({
      phoneBound: true,
      phoneMasked: '138****8000',
      phone: '13900139000',
      reauthMethods: ['phone']
    }),
    sendSmsCode() {
      boundCalls.send += 1;
      return Promise.resolve({});
    },
    bindPhone() {
      boundCalls.bind += 1;
      return Promise.resolve({});
    }
  });
  boundPage.onShow();
  await flushPromises();
  assert.strictEqual(boundPage.data.displayOnly, true);
  assert.strictEqual(boundPage.data.phoneMasked, '138****8000');
  assert.strictEqual(boundPage.data.phone, '');
  boundPage.sendCode();
  boundPage.submit();
  assert.deepStrictEqual(boundCalls, { send: 0, bind: 0 });

  const sendRequest = deferred();
  const calls = { send: [], bind: [] };
  let bindAttempts = 0;
  const page = loadPage('miniprogram/pages/settings/account-security/phone-binding/index.js', {
    getAccountSecurity: () => Promise.resolve({
      phoneBound: false,
      reauthMethods: ['phone', 'password', 'phone']
    }),
    sendSmsCode(payload) {
      calls.send.push(payload);
      return sendRequest.promise;
    },
    bindPhone(payload) {
      calls.bind.push(payload);
      bindAttempts += 1;
      return bindAttempts === 1
        ? Promise.reject(codedError('RECENT_AUTH_REQUIRED'))
        : Promise.resolve({});
    }
  });
  page.onShow();
  await flushPromises();
  page.onPhoneInput({ detail: { value: '13800138000' } });
  page.sendCode();
  page.sendCode();
  assert.deepStrictEqual(calls.send, [{ phone: '13800138000', purpose: 'bind_phone' }]);
  sendRequest.resolve({ challengeId: 'bind-challenge' });
  await flushPromises();
  page.onCodeInput({ detail: { value: '123456' } });
  page.submit();
  await flushPromises();
  assert.deepStrictEqual(calls.bind, [{ phone: '13800138000', challengeId: 'bind-challenge', code: '123456' }]);
  assert.deepStrictEqual(page.data.recentAuthMethods, ['password'], 'First phone binding cannot use phone reauth.');
  page.onRecentAuthenticated();
  await flushPromises();
  assert.strictEqual(bindAttempts, 2);

  const lateSend = deferred();
  const editedPage = loadPage('miniprogram/pages/settings/account-security/phone-binding/index.js', {
    getAccountSecurity: () => Promise.resolve({ phoneBound: false, reauthMethods: [] }),
    sendSmsCode: () => lateSend.promise,
    bindPhone: () => Promise.resolve({})
  });
  editedPage.onShow();
  await flushPromises();
  editedPage.onPhoneInput({ detail: { value: '13800138000' } });
  editedPage.sendCode();
  editedPage.onPhoneInput({ detail: { value: '13900139000' } });
  lateSend.resolve({ challengeId: 'late' });
  await flushPromises();
  assert.strictEqual(editedPage.data.challengeId, '');
  assert.strictEqual(editedPage.data.counting, false);

  const lateBind = deferred();
  const lateBindPage = loadPage('miniprogram/pages/settings/account-security/phone-binding/index.js', {
    getAccountSecurity: () => Promise.resolve({ phoneBound: false, reauthMethods: [] }),
    sendSmsCode: () => Promise.resolve({ challengeId: 'bind-late' }),
    bindPhone: () => lateBind.promise
  });
  lateBindPage.onShow();
  await flushPromises();
  lateBindPage.onPhoneInput({ detail: { value: '13800138000' } });
  lateBindPage.sendCode();
  await flushPromises();
  lateBindPage.onCodeInput({ detail: { value: '123456' } });
  const toastCountBeforeBind = lateBindPage._records.toasts.length;
  lateBindPage.submit();
  lateBindPage.onCodeInput({ detail: { value: '654321' } });
  lateBind.resolve({});
  await flushPromises();
  assert.strictEqual(lateBindPage._records.backs, 0, 'Editing bind code must suppress late success navigation.');
  assert.strictEqual(
    lateBindPage._records.toasts.length,
    toastCountBeforeBind,
    'Editing bind code must suppress late success feedback.'
  );
  lateBindPage.onHide();
  assert.strictEqual(lateBindPage.data.statusReady, false, 'A hidden phone page must require fresh status.');
  assert.strictEqual(lateBindPage.data.phone, '');
  assert.strictEqual(lateBindPage.data.code, '');

  let freshStatusCalls = 0;
  let freshBoundAttempts = 0;
  const freshBoundPage = loadPage('miniprogram/pages/settings/account-security/phone-binding/index.js', {
    getAccountSecurity() {
      freshStatusCalls += 1;
      return Promise.resolve(freshStatusCalls === 1
        ? { phoneBound: false, reauthMethods: ['password'] }
        : { phoneBound: true, phoneMasked: '138****8000', reauthMethods: ['phone', 'password'] });
    },
    sendSmsCode: () => Promise.resolve({ challengeId: 'bind-fresh' }),
    bindPhone() {
      freshBoundAttempts += 1;
      return Promise.reject(codedError('RECENT_AUTH_REQUIRED'));
    }
  });
  freshBoundPage.onShow();
  await flushPromises();
  freshBoundPage.onPhoneInput({ detail: { value: '13800138000' } });
  freshBoundPage.sendCode();
  await flushPromises();
  freshBoundPage.onCodeInput({ detail: { value: '123456' } });
  freshBoundPage.submit();
  await flushPromises();
  freshBoundPage.clearCountdown();
  assert.strictEqual(freshBoundAttempts, 1);
  assert.strictEqual(freshBoundPage.data.displayOnly, true, 'Freshly bound phone must become display-only.');
  assert.strictEqual(freshBoundPage.data.phoneMasked, '138****8000');
  assert.strictEqual(freshBoundPage.data.counting, false);
  assert.strictEqual(freshBoundPage.data.recentAuthVisible, false);
}

async function testPhoneBindingSendInvalidatesOldBind() {
  const oldBind = deferred();
  const newSend = deferred();
  let sendCalls = 0;
  const page = loadPage('miniprogram/pages/settings/account-security/phone-binding/index.js', {
    getAccountSecurity: () => Promise.resolve({ phoneBound: false, reauthMethods: ['password'] }),
    sendSmsCode() {
      sendCalls += 1;
      return newSend.promise;
    },
    bindPhone() {
      return oldBind.promise;
    }
  });
  page.onShow();
  await flushPromises();
  page.setData({
    phone: '13800138000',
    challengeId: 'old-bind-challenge',
    code: '123456'
  });
  page.submit();
  assert.strictEqual(page.data.binding, true);
  page.sendCode();
  assert.strictEqual(sendCalls, 1);
  assert.strictEqual(page.data.binding, false, 'A new phone code must release an older bind request.');
  assert.strictEqual(page.data.code, '');
  assert.strictEqual(page.data.challengeId, '');
  oldBind.resolve({});
  await flushPromises();
  assert.strictEqual(page._records.backs, 0, 'An old bind must not navigate after a newer send.');
  assert.strictEqual(page._records.toasts.length, 0, 'An old bind must not show success after a newer send.');

  let bindCalls = 0;
  const retryPage = loadPage('miniprogram/pages/settings/account-security/phone-binding/index.js', {
    getAccountSecurity: () => Promise.resolve({ phoneBound: false, reauthMethods: ['password'] }),
    sendSmsCode: () => new Promise(() => {}),
    bindPhone() {
      bindCalls += 1;
      return Promise.reject(codedError('RECENT_AUTH_REQUIRED'));
    }
  });
  retryPage.onShow();
  await flushPromises();
  retryPage.setData({
    phone: '13800138000',
    challengeId: 'old-retry-challenge',
    code: '123456'
  });
  retryPage.submit();
  await flushPromises();
  assert.strictEqual(retryPage.data.recentAuthVisible, true);
  retryPage.sendCode();
  assert.strictEqual(retryPage.data.recentAuthVisible, false, 'A new send must close an old recent-auth retry.');
  retryPage.onRecentAuthenticated();
  assert.strictEqual(bindCalls, 1, 'An invalidated pending payload must not retry after authentication.');
}

async function testPhoneBindingInvalidatedRejectsStaySilent() {
  const oldSend = deferred();
  const newSend = deferred();
  let sendCalls = 0;
  let bindCalls = 0;
  const sendPage = loadPage('miniprogram/pages/settings/account-security/phone-binding/index.js', {
    getAccountSecurity: () => Promise.resolve({ phoneBound: false, reauthMethods: ['password'] }),
    sendSmsCode() {
      sendCalls += 1;
      return sendCalls === 1 ? oldSend.promise : newSend.promise;
    },
    bindPhone() {
      bindCalls += 1;
      return Promise.resolve({});
    }
  });
  sendPage.onShow();
  await flushPromises();
  sendPage.onPhoneInput({ detail: { value: '13800138000' } });
  sendPage.sendCode();
  sendPage.onPhoneInput({ detail: { value: '13900139000' } });
  sendPage.sendCode();
  assert.strictEqual(sendPage.data.sending, true, 'The replacement phone-code send must own the loading state.');
  assert.strictEqual(sendPage._sending, true);
  await assertInvalidatedRejectStaysSilent({
    label: 'Phone-binding SMS send invalidated by phone edit and resend',
    request: oldSend,
    error: new Error('late phone send transport failure'),
    getState: () => ({
      data: sendPage.data,
      sending: sendPage._sending,
      binding: sendPage._binding,
      pendingPayload: sendPage._pendingPayload
    }),
    getEffects: () => ({
      toasts: sendPage._records.toasts.length,
      modals: sendPage._records.modals.length,
      navigations: sendPage._records.navigations.length,
      backs: sendPage._records.backs,
      relaunches: sendPage._records.relaunches.length,
      sendCalls,
      bindCalls
    })
  });
  assert.strictEqual(sendPage.data.sending, true, 'The old send rejection must not clear the replacement send.');
  assert.strictEqual(sendPage._sending, true);
  newSend.resolve({ challengeId: 'replacement-phone-challenge' });
  await flushPromises();
  assert.strictEqual(sendPage.data.challengeId, 'replacement-phone-challenge');
  sendPage.clearCountdown();

  const oldBind = deferred();
  const replacementSend = deferred();
  let replacementSendCalls = 0;
  let oldBindCalls = 0;
  const bindPage = loadPage('miniprogram/pages/settings/account-security/phone-binding/index.js', {
    getAccountSecurity: () => Promise.resolve({ phoneBound: false, reauthMethods: ['password'] }),
    sendSmsCode() {
      replacementSendCalls += 1;
      return replacementSend.promise;
    },
    bindPhone() {
      oldBindCalls += 1;
      return oldBind.promise;
    }
  });
  bindPage.onShow();
  await flushPromises();
  bindPage.setData({
    phone: '13800138000',
    challengeId: 'old-bind-challenge',
    code: '123456'
  });
  bindPage.submit();
  bindPage.sendCode();
  assert.strictEqual(bindPage.data.sending, true, 'The replacement send must remain visibly pending.');
  assert.strictEqual(bindPage._sending, true);
  assert.strictEqual(bindPage.data.binding, false);
  await assertInvalidatedRejectStaysSilent({
    label: 'Phone bind invalidated by a new SMS send',
    request: oldBind,
    getState: () => ({
      data: bindPage.data,
      sending: bindPage._sending,
      binding: bindPage._binding,
      pendingPayload: bindPage._pendingPayload
    }),
    getEffects: () => ({
      toasts: bindPage._records.toasts.length,
      modals: bindPage._records.modals.length,
      navigations: bindPage._records.navigations.length,
      backs: bindPage._records.backs,
      relaunches: bindPage._records.relaunches.length,
      sendCalls: replacementSendCalls,
      bindCalls: oldBindCalls
    })
  });
  assert.strictEqual(bindPage.data.sending, true, 'The old bind rejection must not clear the new send loading state.');
  assert.strictEqual(bindPage._sending, true);
  assert.strictEqual(oldBindCalls, 1, 'The invalidated bind must not retry.');
  replacementSend.resolve({ challengeId: 'new-bind-challenge' });
  await flushPromises();
  assert.strictEqual(bindPage.data.challengeId, 'new-bind-challenge');
  bindPage.clearCountdown();
}

async function testEmailBindingBoundState() {
  const calls = { send: 0, bind: 0 };
  const page = loadPage('miniprogram/pages/settings/email-binding/index.js', {
    getAccountSecurity: () => Promise.resolve({ emailBound: true, emailMasked: 'm***@example.com' }),
    sendEmailCode() {
      calls.send += 1;
      return Promise.resolve({});
    },
    bindEmail() {
      calls.bind += 1;
      return Promise.resolve({});
    }
  });
  page.onShow();
  await flushPromises();
  assert.strictEqual(page.data.emailBound, true);
  assert.strictEqual(page.data.currentEmail, 'm***@example.com');
  page.onEmailInput({ detail: { value: 'replacement@example.com' } });
  page.onCodeInput({ detail: { value: '123456' } });
  page.sendCode();
  page.submit();
  assert.deepStrictEqual(calls, { send: 0, bind: 0 }, 'Bound email must not expose a replacement path.');

  const pendingStatus = deferred();
  const directCalls = { send: 0, bind: 0 };
  const directPage = loadPage('miniprogram/pages/settings/email-binding/index.js', {
    getAccountSecurity: () => pendingStatus.promise,
    sendEmailCode() {
      directCalls.send += 1;
      return Promise.resolve({});
    },
    bindEmail() {
      directCalls.bind += 1;
      return Promise.resolve({});
    }
  });
  directPage.onShow();
  directPage.onEmailInput({ detail: { value: 'member@example.com' } });
  directPage.onCodeInput({ detail: { value: '123456' } });
  directPage.sendCode();
  directPage.submit();
  assert.deepStrictEqual(directCalls, { send: 0, bind: 0 }, 'Deep-link entry must wait for validated status.');
  pendingStatus.resolve({ emailBound: false, emailMasked: '' });
  await flushPromises();
  assert.strictEqual(directPage.data.statusReady, true);
  directPage.sendCode();
  directPage.onCodeInput({ detail: { value: '123456' } });
  directPage.submit();
  assert.deepStrictEqual(directCalls, { send: 1, bind: 1 }, 'Explicit emailBound:false may enable binding calls.');

  const failedCalls = { send: 0, bind: 0 };
  const failedPage = loadPage('miniprogram/pages/settings/email-binding/index.js', {
    getAccountSecurity: () => Promise.reject(codedError('AUTH_INTERNAL_ERROR')),
    sendEmailCode() {
      failedCalls.send += 1;
      return Promise.resolve({});
    },
    bindEmail() {
      failedCalls.bind += 1;
      return Promise.resolve({});
    }
  });
  failedPage.onShow();
  await flushPromises();
  assert.strictEqual(failedPage.data.statusReady, false);
  failedPage.onEmailInput({ detail: { value: 'member@example.com' } });
  failedPage.onCodeInput({ detail: { value: '123456' } });
  failedPage.sendCode();
  failedPage.submit();
  assert.deepStrictEqual(failedCalls, { send: 0, bind: 0 }, 'Unknown email status must fail closed.');
}

async function testSettingsCacheCurrentLogoutAndRoleSwitch() {
  const logoutRequest = deferred();
  let logoutCalls = 0;
  const keys = [
    'cuetrace_auth_v2_session',
    'cuetrace_auth_v2_client',
    'cuetrace_auth_v2_migrated',
    'dc_theme_mode',
    'dc_role',
    'ordinary_cache',
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__'
  ];
  const page = loadPage('miniprogram/pages/settings/index.js', {
    logoutCurrentSession() {
      logoutCalls += 1;
      return logoutRequest.promise;
    }
  }, {
    wx: {
      getStorageInfoSync() {
        return { keys, currentSize: 12 };
      }
    }
  });
  page.clearCache();
  resolveModal(page, 0, true);
  assert.deepStrictEqual(
    page._records.removals.sort(),
    ['dc_role', 'ordinary_cache', 'constructor', 'toString', 'hasOwnProperty', '__proto__'].sort(),
    'Cache cleanup must preserve exactly the four explicit whitelist keys.'
  );

  const logoutModalStart = page._records.modals.length;
  page.logout();
  page.logout();
  assert.strictEqual(
    page._records.modals.length - logoutModalStart,
    1,
    'Repeated logout taps must not open duplicate prompts.'
  );
  resolveModal(page, logoutModalStart, true);
  assert.strictEqual(logoutCalls, 1);
  assert.strictEqual(page._records.relaunches.length, 0, 'Local success must wait for server revocation.');
  assert(page._app.globalData.userProfile, 'In-memory auth projection must remain until server success.');
  logoutRequest.resolve({});
  await flushPromises();
  assert.strictEqual(page._app.globalData.userProfile, null);
  assert.strictEqual(page._app.globalData.openid, '');
  assert.deepStrictEqual(page._records.relaunches, ['/pages/login/index']);
  assert(!page._records.removals.includes('cuetrace_auth_v2_client'));

  const switchPage = loadPage('miniprogram/pages/settings/index.js', {
    logoutCurrentSession() {
      throw new Error('Switching identity must not log out.');
    }
  });
  switchPage.switchIdentity();
  assert.deepStrictEqual(switchPage._records.relaunches, ['/pages/login/index?switchRole=1']);

  const coachPage = loadPage('miniprogram/pages/settings/index.js', {}, {
    app: {
      globalData: {
        currentRole: 'coach',
        role: 'member',
        userProfile: { nickname: 'coach' }
      }
    },
    mock: { getRole: () => 'member' }
  });
  coachPage.goEditProfile();
  assert.deepStrictEqual(
    coachPage._records.navigations,
    ['/pages/coach/profile/index'],
    'Settings routing must use the live session role rather than legacy role cache.'
  );

  const shopPage = loadPage('miniprogram/pages/settings/index.js', {}, {
    app: {
      globalData: {
        currentRole: 'shop',
        role: 'member',
        userProfile: { nickname: 'shop' }
      }
    },
    mock: { getRole: () => 'member' }
  });
  shopPage.goMyProfile();
  assert.deepStrictEqual(shopPage._records.navigations, ['/pages/shop/profile/index']);
}

async function testSettingsLogoutFailureAndLateResult() {
  const failedPage = loadPage('miniprogram/pages/settings/index.js', {
    logoutCurrentSession: () => Promise.reject(codedError('AUTH_INTERNAL_ERROR', 'token internal'))
  });
  failedPage.logout();
  resolveModal(failedPage, 0, true);
  await flushPromises();
  assert.strictEqual(failedPage._records.relaunches.length, 0);
  assert(failedPage._app.globalData.userProfile);
  assert(failedPage._records.toasts.length > 0);
  assert(!/token internal/.test(failedPage._records.toasts[0].title));

  const stalePage = loadPage('miniprogram/pages/settings/index.js', {
    logoutCurrentSession: () => Promise.reject(codedError('AUTH_ATTEMPT_STALE', 'internal stale detail'))
  });
  stalePage.logout();
  resolveModal(stalePage, 0, true);
  await flushPromises();
  assert.strictEqual(stalePage._records.relaunches.length, 0);
  assert.strictEqual(stalePage._records.toasts.length, 0, 'Stale logout completion must stay silent.');
  assert(stalePage._app.globalData.userProfile);

  const late = deferred();
  const hiddenPage = loadPage('miniprogram/pages/settings/index.js', {
    logoutCurrentSession: () => late.promise
  });
  hiddenPage.logout();
  resolveModal(hiddenPage, 0, true);
  hiddenPage.onHide();
  late.resolve({});
  await flushPromises();
  assert.strictEqual(hiddenPage._records.relaunches.length, 0);
  assert(hiddenPage._app.globalData.userProfile, 'A late logout result must not mutate hidden-page UI projection.');
}

async function testSettingsLogoutPendingSurvivesHideShow() {
  const first = deferred();
  const second = deferred();
  let logoutCalls = 0;
  const page = loadPage('miniprogram/pages/settings/index.js', {
    getAdminStatus: () => Promise.resolve({ isAdmin: false }),
    getMyCoachShopBindingStatus: () => Promise.resolve({ status: 'none' }),
    logoutCurrentSession() {
      logoutCalls += 1;
      return logoutCalls === 1 ? first.promise : second.promise;
    }
  });
  page.logout();
  resolveModal(page, 0, true);
  assert.strictEqual(logoutCalls, 1);

  page.onHide();
  page.onShow();
  await flushPromises();
  const modalCountWhilePending = page._records.modals.length;
  page.logout();
  if (page._records.modals.length > modalCountWhilePending) {
    resolveModal(page, modalCountWhilePending, true);
  }
  assert.strictEqual(
    logoutCalls,
    1,
    'Hide/show must not release the transport-level logout single-flight lock.'
  );
  assert.strictEqual(
    page._records.modals.length,
    modalCountWhilePending,
    'A pending logout must not open another confirmation after show.'
  );

  first.resolve({});
  await flushPromises();
  assert.strictEqual(page._records.relaunches.length, 0, 'A prior-lifecycle logout result must not relaunch.');
  assert(page._app.globalData.userProfile, 'A prior-lifecycle logout result must not clear UI projection.');
  assert.strictEqual(page._records.toasts.length, 0);

  page.logout();
  assert.strictEqual(
    page._records.modals.length,
    modalCountWhilePending + 1,
    'Settling the old request must release the internal lock for a fresh logout.'
  );
  resolveModal(page, modalCountWhilePending, true);
  assert.strictEqual(logoutCalls, 2);
  second.reject(codedError('AUTH_ATTEMPT_STALE'));
  await flushPromises();
  assert.strictEqual(page.data.loggingOut, false);
  assert.strictEqual(page._records.toasts.length, 0);
}

function testPageRegistrationAndSessionOwnership() {
  const app = JSON.parse(read('miniprogram/app.json'));
  const taskPages = app.pages.filter((page) => page.startsWith('pages/settings/account-security/') && page !== 'pages/settings/account-security/index');
  assert.deepStrictEqual(taskPages, [
    'pages/settings/account-security/account-name/index',
    'pages/settings/account-security/password/index',
    'pages/settings/account-security/phone-binding/index'
  ]);

  const componentPages = [
    'miniprogram/pages/settings/account-security/index.json',
    'miniprogram/pages/settings/account-security/account-name/index.json',
    'miniprogram/pages/settings/account-security/password/index.json',
    'miniprogram/pages/settings/account-security/phone-binding/index.json'
  ];
  componentPages.forEach((file) => {
    const config = JSON.parse(read(file));
    assert.strictEqual(config.usingComponents['recent-auth'], '/components/recent-auth/index', `${file} recent-auth registration`);
  });

  const pageSources = [
    'miniprogram/pages/settings/account-security/index.js',
    'miniprogram/pages/settings/account-security/account-name/index.js',
    'miniprogram/pages/settings/account-security/password/index.js',
    'miniprogram/pages/settings/account-security/phone-binding/index.js',
    'miniprogram/pages/settings/index.js'
  ].map(read).join('\n');
  assert(!/auth-session|commitSessionRotation|clearSessionIfCurrent/.test(pageSources), 'Pages must leave session CAS ownership to data.js.');
  const accountSecuritySource = read('miniprogram/pages/settings/account-security/index.js');
  assert(!/status\.phone\b|maskPhone/.test(accountSecuritySource), 'Account security must never read or mask a raw phone.');
  const accountSecurityWxml = read('miniprogram/pages/settings/account-security/index.wxml');
  assert(/我的二维码[\s\S]*?<text class="arrow">›<\/text>/.test(accountSecurityWxml), 'QR navigation arrow must remain unconditional.');
  assert(/手机号[\s\S]*?wx:if="\{\{!phoneBound\}\}" class="arrow"/.test(accountSecurityWxml), 'Phone arrow must disappear after binding.');
  assert(/邮箱[\s\S]*?wx:if="\{\{!emailBound\}\}" class="arrow"/.test(accountSecurityWxml), 'Email arrow must disappear after binding.');
}

(async () => {
  await testTypedDataFacadeContracts();
  await testFacadeSchemaAndSessionRaces();
  await testFacadeRejectPathTokenGuard();
  await testEveryTask9FacadeRejectPathTokenGuard();
  await testFacadePersistencePostconditions();
  await testConflictRefreshValidatesSecurityStatus();
  await testSessionSendResponseContracts();
  await testRecentAuthFilteringRequestsAndReset();
  await testRecentAuthAllClosePathsAndLateSuppression();
  await testRecentAuthPhoneSendInvalidatesOldProof();
  await testRecentAuthEmailSendInvalidatesOldProof();
  await testRecentAuthCurrentStaleFailuresStaySilent();
  await testRecentAuthInvalidatedRejectsStaySilent();
  await testAccountSecurityServerProjectionAndNavigation();
  await testAccountSecurityWechatRetryOnceAndLogoutOthers();
  await testAccountSecuritySecondRecentAuthAndLifecycleFailClosed();
  await testAccountNameOneTimeAndRecentAuth();
  await testPasswordSetChangeAndCircularMethodFiltering();
  await testPhoneBindingProofOwnershipAndBoundDisplay();
  await testPhoneBindingSendInvalidatesOldBind();
  await testPhoneBindingInvalidatedRejectsStaySilent();
  await testEmailBindingBoundState();
  await testSettingsCacheCurrentLogoutAndRoleSwitch();
  await testSettingsLogoutFailureAndLateResult();
  await testSettingsLogoutPendingSurvivesHideShow();
  testPageRegistrationAndSessionOwnership();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
