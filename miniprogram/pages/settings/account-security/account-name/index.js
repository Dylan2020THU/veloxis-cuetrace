const data = require('../../../../services/data');

const ACCOUNT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,19}$/;
const VALID_REAUTH_METHODS = ['password', 'phone', 'email', 'wechat'];
const SAFE_MESSAGES = {
  ACCOUNT_NAME_EXISTS: '该账号名已被占用，请更换',
  AUTH_CONFLICT: '账号状态已变更，请刷新后重试',
  SESSION_REQUIRED: '登录状态已失效，请重新登录',
  SESSION_EXPIRED: '登录状态已失效，请重新登录'
};

function filterMethods(methods) {
  if (!Array.isArray(methods)) return [];
  const seen = Object.create(null);
  return methods.filter((method) => {
    if (VALID_REAUTH_METHODS.indexOf(method) === -1 || seen[method]) return false;
    seen[method] = true;
    return true;
  });
}

function safeMessage(error) {
  return SAFE_MESSAGES[error && error.code] || '账号名设置失败，请稍后重试';
}

Page({
  behaviors: [require('../../../../utils/themeBehavior')],

  data: {
    accountName: '',
    displayOnly: true,
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
        const displayOnly = source.accountNameSet === true;
        this._reauthMethods = filterMethods(source.reauthMethods);
        this.setData({
          accountName: displayOnly && typeof source.account === 'string' ? source.account : '',
          displayOnly,
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
        this.setData({ displayOnly: true, statusReady: false, submitting: false });
        wx.showToast({ title: '账号安全状态加载失败', icon: 'none' });
      });
  },

  isCurrent(key, generation) {
    return !this._disposed && this._active !== false && this[key] === generation;
  },

  onAccountNameInput(event) {
    if (this.data.displayOnly) return;
    const accountName = event.detail.value;
    if (accountName !== this.data.accountName) {
      this._submitGeneration = (this._submitGeneration || 0) + 1;
      this._submitting = false;
      this._pendingPayload = null;
      this.setData({
        accountName,
        submitting: false,
        recentAuthVisible: false,
        recentAuthMethods: []
      });
      return;
    }
    this.setData({ accountName });
  },

  submit() {
    if (this.data.displayOnly || !this.data.statusReady || this._submitting) return;
    const accountName = String(this.data.accountName || '').trim();
    if (!ACCOUNT_NAME_RE.test(accountName)) {
      wx.showToast({ title: '账号名需为 4-20 位，字母开头，仅含字母、数字或下划线', icon: 'none' });
      return;
    }
    this.runSetAccountName({ accountName }, false);
  },

  runSetAccountName(payload, retried) {
    if (this._submitting || this._disposed || this._active === false) return;
    this._submitting = true;
    const generation = (this._submitGeneration || 0) + 1;
    this._submitGeneration = generation;
    this.setData({ submitting: true });
    data.setAccountName(payload)
      .then(() => {
        if (!this.isCurrent('_submitGeneration', generation)) return;
        this._submitting = false;
        this._pendingPayload = null;
        this.setData({ submitting: false, recentAuthVisible: false, recentAuthMethods: [] });
        wx.showToast({ title: '账号名设置成功', icon: 'success' });
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
              if (status && status.accountNameSet === true) {
                this._pendingPayload = null;
                this._reauthMethods = [];
                this.setData({
                  accountName: typeof status.account === 'string' ? status.account : '',
                  displayOnly: true,
                  statusReady: true,
                  submitting: false,
                  recentAuthVisible: false,
                  recentAuthMethods: []
                });
                return;
              }
              const methods = filterMethods(status && status.reauthMethods);
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
    if (payload) this.runSetAccountName(payload, true);
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
      accountName: '',
      displayOnly: true,
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
