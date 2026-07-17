const data = require('../../../../services/data');

const VALID_REAUTH_METHODS = ['password', 'phone', 'email', 'wechat'];
const SAFE_MESSAGES = {
  AUTH_CONFLICT: '账号状态已变更，请刷新后重试',
  SESSION_REQUIRED: '登录状态已失效，请重新登录',
  SESSION_EXPIRED: '登录状态已失效，请重新登录',
  PASSWORD_RATE_LIMITED: '操作过于频繁，请稍后重试'
};

function filterMethods(methods, excludePassword) {
  if (!Array.isArray(methods)) return [];
  const seen = Object.create(null);
  return methods.filter((method) => {
    if (
      (excludePassword && method === 'password')
      || VALID_REAUTH_METHODS.indexOf(method) === -1
      || seen[method]
    ) return false;
    seen[method] = true;
    return true;
  });
}

function safeMessage(error) {
  return SAFE_MESSAGES[error && error.code] || '密码设置失败，请稍后重试';
}

Page({
  behaviors: [require('../../../../utils/themeBehavior')],

  data: {
    passwordSet: false,
    titleText: '设置登录密码',
    password: '',
    confirmPassword: '',
    statusReady: false,
    submitting: false,
    recentAuthVisible: false,
    recentAuthMethods: []
  },

  onLoad() {
    this._active = true;
    this._disposed = false;
    this._submitting = false;
    this._statusPending = false;
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
        const passwordSet = source.passwordSet === true;
        this._reauthMethods = filterMethods(source.reauthMethods, !passwordSet);
        this.setData({
          passwordSet,
          titleText: passwordSet ? '修改登录密码' : '设置登录密码',
          statusReady: true,
          submitting: false,
          recentAuthVisible: false,
          recentAuthMethods: []
        });
      })
      .catch((error) => {
        if (!this.isCurrent('_statusGeneration', generation)) return;
        this._statusPending = false;
        if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
        this._reauthMethods = [];
        this.setData({ statusReady: false, submitting: false });
        wx.showToast({ title: '账号安全状态加载失败', icon: 'none' });
      });
  },

  isCurrent(key, generation) {
    return !this._disposed && this._active !== false && this[key] === generation;
  },

  invalidateSubmitForInput() {
    this._submitGeneration = (this._submitGeneration || 0) + 1;
    this._submitting = false;
    this._pendingPayload = null;
    this.setData({ submitting: false, recentAuthVisible: false, recentAuthMethods: [] });
  },

  onPasswordInput(event) {
    const password = event.detail.value;
    if (password !== this.data.password) this.invalidateSubmitForInput();
    this.setData({ password });
  },

  onConfirmInput(event) {
    const confirmPassword = event.detail.value;
    if (confirmPassword !== this.data.confirmPassword) this.invalidateSubmitForInput();
    this.setData({ confirmPassword });
  },

  submit() {
    if (!this.data.statusReady || this._submitting) return;
    const password = String(this.data.password || '');
    const length = Array.from(password).length;
    if (length < 6 || length > 64) {
      wx.showToast({ title: '密码需为 6-64 个字符', icon: 'none' });
      return;
    }
    if (password !== String(this.data.confirmPassword || '')) {
      wx.showToast({ title: '两次输入的密码不一致', icon: 'none' });
      return;
    }
    this.runSetPassword({ password }, false);
  },

  runSetPassword(payload, retried) {
    if (this._submitting || this._disposed || this._active === false) return;
    this._submitting = true;
    const generation = (this._submitGeneration || 0) + 1;
    this._submitGeneration = generation;
    this.setData({ submitting: true });
    data.setPassword(payload)
      .then(() => {
        if (!this.isCurrent('_submitGeneration', generation)) return;
        this._submitting = false;
        this._pendingPayload = null;
        this.setData({
          password: '',
          confirmPassword: '',
          submitting: false,
          recentAuthVisible: false,
          recentAuthMethods: []
        });
        wx.showToast({ title: '密码设置成功', icon: 'success' });
        wx.navigateBack();
      })
      .catch((error) => {
        if (!this.isCurrent('_submitGeneration', generation)) return;
        this._submitting = false;
        if (error && error.code === 'RECENT_AUTH_REQUIRED' && !retried) {
          this._submitting = true;
          data.getAccountSecurity()
            .then((status) => {
              if (!this.isCurrent('_submitGeneration', generation)) return;
              this._submitting = false;
              const passwordSet = !!(status && status.passwordSet === true);
              this.setData({
                passwordSet,
                titleText: passwordSet ? '修改登录密码' : '设置登录密码'
              });
              const methods = filterMethods(
                status && status.reauthMethods,
                !passwordSet
              );
              if (methods.length === 0) {
                this._pendingPayload = null;
                this.setData({ submitting: false, recentAuthVisible: false, recentAuthMethods: [] });
                wx.showToast({ title: '暂无可用的身份验证方式', icon: 'none' });
                return;
              }
              this._reauthMethods = methods;
              this._pendingPayload = payload;
              this.setData({ submitting: false, recentAuthVisible: true, recentAuthMethods: methods });
            })
            .catch((statusError) => {
              if (!this.isCurrent('_submitGeneration', generation)) return;
              this._submitting = false;
              this._pendingPayload = null;
              if (statusError && statusError.code === 'AUTH_ATTEMPT_STALE') {
                this.setData({ submitting: false });
                return;
              }
              this.setData({ submitting: false, recentAuthVisible: false, recentAuthMethods: [] });
              wx.showToast({ title: '身份验证方式加载失败，请稍后重试', icon: 'none' });
            });
          return;
        }
        if (error && error.code === 'AUTH_ATTEMPT_STALE') {
          this.setData({ submitting: false });
          return;
        }
        this._pendingPayload = null;
        this.setData({ submitting: false, recentAuthVisible: false, recentAuthMethods: [] });
        wx.showToast({
          title: error && error.code === 'RECENT_AUTH_REQUIRED'
            ? '身份验证已过期，请稍后重试'
            : safeMessage(error),
          icon: 'none'
        });
      });
  },

  onRecentAuthenticated() {
    if (this._disposed || this._active === false) return;
    const payload = this._pendingPayload;
    this._pendingPayload = null;
    this.setData({ recentAuthVisible: false, recentAuthMethods: [] });
    if (payload) this.runSetPassword(payload, true);
  },

  onRecentCancel() {
    this._pendingPayload = null;
    this.setData({ recentAuthVisible: false, recentAuthMethods: [] });
  },

  deactivate() {
    this._active = false;
    this._statusGeneration = (this._statusGeneration || 0) + 1;
    this._submitGeneration = (this._submitGeneration || 0) + 1;
    this._submitting = false;
    this._statusPending = false;
    this._pendingPayload = null;
    this._reauthMethods = [];
    this.setData({
      password: '',
      confirmPassword: '',
      statusReady: false,
      submitting: false,
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
