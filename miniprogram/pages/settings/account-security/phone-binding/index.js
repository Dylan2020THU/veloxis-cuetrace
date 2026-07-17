const data = require('../../../../services/data');

const PHONE_RE = /^1\d{10}$/;
const CODE_RE = /^\d{6}$/;
const VALID_REAUTH_METHODS = ['password', 'phone', 'email', 'wechat'];
const SAFE_MESSAGES = {
  INVALID_PHONE: '请输入正确的手机号',
  SMS_TOO_FREQUENT: '验证码发送过于频繁，请稍后重试',
  SMS_CODE_INVALID: '验证码错误，请重新输入',
  SMS_CODE_EXPIRED: '验证码已过期，请重新获取',
  SMS_CODE_LOCKED: '验证码错误次数过多，请重新获取',
  PHONE_ALREADY_BOUND: '该手机号已绑定其他账号',
  ACCOUNT_PHONE_ALREADY_BOUND: '当前账号已绑定手机号',
  AUTH_CONFLICT: '账号状态已变更，请刷新后重试',
  SESSION_REQUIRED: '登录状态已失效，请重新登录',
  SESSION_EXPIRED: '登录状态已失效，请重新登录'
};

function filterMethods(methods) {
  if (!Array.isArray(methods)) return [];
  const seen = Object.create(null);
  return methods.filter((method) => {
    if (
      method === 'phone'
      || VALID_REAUTH_METHODS.indexOf(method) === -1
      || seen[method]
    ) return false;
    seen[method] = true;
    return true;
  });
}

function safeMessage(error, fallback) {
  return SAFE_MESSAGES[error && error.code] || fallback;
}

Page({
  behaviors: [require('../../../../utils/themeBehavior')],

  data: {
    displayOnly: true,
    phoneMasked: '',
    phone: '',
    code: '',
    challengeId: '',
    statusReady: false,
    sending: false,
    counting: false,
    countdown: 60,
    binding: false,
    recentAuthVisible: false,
    recentAuthMethods: []
  },

  onLoad() {
    this._active = true;
    this._disposed = false;
    this._statusPending = false;
    this._sending = false;
    this._binding = false;
  },

  onShow() {
    this._active = true;
    this.refresh();
  },

  refresh() {
    if (this._statusPending) return;
    this._statusPending = true;
    const generation = (this._statusGeneration || 0) + 1;
    this._statusGeneration = generation;
    data.getAccountSecurity()
      .then((status) => {
        if (!this.isCurrent('_statusGeneration', generation)) return;
        this._statusPending = false;
        const source = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
        const displayOnly = source.phoneBound === true;
        this._reauthMethods = filterMethods(source.reauthMethods);
        if (displayOnly) this.invalidateSensitiveWork();
        this.setData({
          displayOnly,
          phoneMasked: displayOnly && typeof source.phoneMasked === 'string'
            ? source.phoneMasked
            : '',
          phone: displayOnly ? '' : this.data.phone,
          code: displayOnly ? '' : this.data.code,
          challengeId: displayOnly ? '' : this.data.challengeId,
          statusReady: true,
          sending: false,
          binding: false,
          recentAuthVisible: false,
          recentAuthMethods: []
        });
      })
      .catch((error) => {
        if (!this.isCurrent('_statusGeneration', generation)) return;
        this._statusPending = false;
        if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
        this.invalidateSensitiveWork();
        this.setData({
          displayOnly: true,
          phoneMasked: '',
          phone: '',
          code: '',
          challengeId: '',
          statusReady: false,
          sending: false,
          binding: false,
          recentAuthVisible: false,
          recentAuthMethods: []
        });
        wx.showToast({ title: '账号安全状态加载失败', icon: 'none' });
      });
  },

  isCurrent(key, generation) {
    return !this._disposed && this._active !== false && this[key] === generation;
  },

  clearCountdown() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  invalidateSensitiveWork() {
    this._sendGeneration = (this._sendGeneration || 0) + 1;
    this._bindGeneration = (this._bindGeneration || 0) + 1;
    this._sending = false;
    this._binding = false;
    this._pendingPayload = null;
    this.clearCountdown();
  },

  onPhoneInput(event) {
    if (this.data.displayOnly || !this.data.statusReady) return;
    const phone = event.detail.value;
    if (String(phone || '').trim() !== String(this.data.phone || '').trim()) {
      this.invalidateSensitiveWork();
      this.setData({
        phone,
        code: '',
        challengeId: '',
        sending: false,
        counting: false,
        countdown: 60,
        binding: false,
        recentAuthVisible: false,
        recentAuthMethods: []
      });
      return;
    }
    this.setData({ phone });
  },

  onCodeInput(event) {
    if (this.data.displayOnly || !this.data.statusReady) return;
    const code = event.detail.value;
    if (code !== this.data.code) {
      this._bindGeneration = (this._bindGeneration || 0) + 1;
      this._binding = false;
      this._pendingPayload = null;
      this.setData({
        code,
        binding: false,
        recentAuthVisible: false,
        recentAuthMethods: []
      });
      return;
    }
    this.setData({ code });
  },

  startCountdown(generation) {
    if (!this.isCurrent('_sendGeneration', generation)) return;
    this.clearCountdown();
    this.setData({ counting: true, countdown: 60 });
    this._timer = setInterval(() => {
      if (!this.isCurrent('_sendGeneration', generation)) return;
      const countdown = this.data.countdown - 1;
      if (countdown <= 0) {
        this.clearCountdown();
        this.setData({ counting: false, countdown: 60 });
      } else {
        this.setData({ countdown });
      }
    }, 1000);
  },

  sendCode() {
    if (
      this.data.displayOnly
      || !this.data.statusReady
      || this._sending
      || this.data.counting
    ) return;
    const phone = String(this.data.phone || '').trim();
    if (!PHONE_RE.test(phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    this._bindGeneration = (this._bindGeneration || 0) + 1;
    this._binding = false;
    this._pendingPayload = null;
    this._reauthMethods = [];
    this._sending = true;
    const generation = (this._sendGeneration || 0) + 1;
    this._sendGeneration = generation;
    this.setData({
      sending: true,
      code: '',
      challengeId: '',
      binding: false,
      recentAuthVisible: false,
      recentAuthMethods: []
    });
    data.sendSmsCode({ phone, purpose: 'bind_phone' })
      .then((result) => {
        if (!this.isCurrent('_sendGeneration', generation)) return;
        this._sending = false;
        const challengeId = result && typeof result.challengeId === 'string'
          ? result.challengeId
          : '';
        this.setData({ sending: false, challengeId });
        if (!challengeId) {
          wx.showToast({ title: '验证码发送失败，请稍后重试', icon: 'none' });
          return;
        }
        this.startCountdown(generation);
        wx.showToast({ title: '验证码已发送', icon: 'none' });
      })
      .catch((error) => {
        if (!this.isCurrent('_sendGeneration', generation)) return;
        this._sending = false;
        this.setData({ sending: false });
        if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
        wx.showToast({ title: safeMessage(error, '验证码发送失败，请稍后重试'), icon: 'none' });
      });
  },

  submit() {
    if (this.data.displayOnly || !this.data.statusReady || this._binding) return;
    const phone = String(this.data.phone || '').trim();
    const code = String(this.data.code || '').trim();
    const challengeId = String(this.data.challengeId || '');
    if (!PHONE_RE.test(phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    if (!challengeId || !CODE_RE.test(code)) {
      wx.showToast({ title: '请先获取并输入 6 位验证码', icon: 'none' });
      return;
    }
    this.runBindPhone({ phone, challengeId, code }, false);
  },

  runBindPhone(payload, retried) {
    if (this._binding || this._disposed || this._active === false) return;
    this._binding = true;
    const generation = (this._bindGeneration || 0) + 1;
    this._bindGeneration = generation;
    this.setData({ binding: true });
    data.bindPhone(payload)
      .then(() => {
        if (!this.isCurrent('_bindGeneration', generation)) return;
        this._binding = false;
        this._pendingPayload = null;
        this.clearCountdown();
        this.setData({
          phone: '',
          code: '',
          challengeId: '',
          binding: false,
          counting: false,
          countdown: 60,
          recentAuthVisible: false,
          recentAuthMethods: []
        });
        wx.showToast({ title: '手机号绑定成功', icon: 'success' });
        wx.navigateBack();
      })
      .catch((error) => {
        if (!this.isCurrent('_bindGeneration', generation)) return;
        this._binding = false;
        if (error && error.code === 'RECENT_AUTH_REQUIRED' && !retried) {
          this._binding = true;
          data.getAccountSecurity()
            .then((status) => {
              if (!this.isCurrent('_bindGeneration', generation)) return;
              this._binding = false;
              if (status && status.phoneBound === true) {
                this.invalidateSensitiveWork();
                this._reauthMethods = [];
                this.setData({
                  displayOnly: true,
                  phoneMasked: typeof status.phoneMasked === 'string' ? status.phoneMasked : '',
                  phone: '',
                  code: '',
                  challengeId: '',
                  statusReady: true,
                  sending: false,
                  counting: false,
                  countdown: 60,
                  binding: false,
                  recentAuthVisible: false,
                  recentAuthMethods: []
                });
                wx.showToast({ title: '账号状态已变更，请刷新后重试', icon: 'none' });
                return;
              }
              const methods = filterMethods(status && status.reauthMethods);
              if (methods.length === 0) {
                this._pendingPayload = null;
                this.setData({ binding: false, recentAuthVisible: false, recentAuthMethods: [] });
                wx.showToast({ title: '暂无可用的身份验证方式', icon: 'none' });
                return;
              }
              this._reauthMethods = methods;
              this._pendingPayload = payload;
              this.setData({ binding: false, recentAuthVisible: true, recentAuthMethods: methods });
            })
            .catch((statusError) => {
              if (!this.isCurrent('_bindGeneration', generation)) return;
              this._binding = false;
              this._pendingPayload = null;
              this.setData({ binding: false });
              if (statusError && statusError.code === 'AUTH_ATTEMPT_STALE') return;
              this.setData({ recentAuthVisible: false, recentAuthMethods: [] });
              wx.showToast({ title: '身份验证方式加载失败，请稍后重试', icon: 'none' });
            });
          return;
        }
        this._pendingPayload = null;
        this.setData({ binding: false });
        if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
        this.setData({ recentAuthVisible: false, recentAuthMethods: [] });
        wx.showToast({
          title: error && error.code === 'RECENT_AUTH_REQUIRED'
            ? '身份验证已过期，请稍后重试'
            : safeMessage(error, '手机号绑定失败，请稍后重试'),
          icon: 'none'
        });
      });
  },

  onRecentAuthenticated() {
    if (this._disposed || this._active === false) return;
    const payload = this._pendingPayload;
    this._pendingPayload = null;
    this.setData({ recentAuthVisible: false, recentAuthMethods: [] });
    if (payload) this.runBindPhone(payload, true);
  },

  onRecentCancel() {
    this._pendingPayload = null;
    this.setData({ recentAuthVisible: false, recentAuthMethods: [] });
  },

  deactivate() {
    this._active = false;
    this._statusPending = false;
    this._statusGeneration = (this._statusGeneration || 0) + 1;
    this.invalidateSensitiveWork();
    this._reauthMethods = [];
    this.setData({
      displayOnly: true,
      phoneMasked: '',
      phone: '',
      code: '',
      challengeId: '',
      statusReady: false,
      sending: false,
      counting: false,
      countdown: 60,
      binding: false,
      recentAuthVisible: false,
      recentAuthMethods: []
    });
  },

  onHide() {
    this.deactivate();
  },

  onUnload() {
    this._disposed = true;
    this.deactivate();
  }
});
