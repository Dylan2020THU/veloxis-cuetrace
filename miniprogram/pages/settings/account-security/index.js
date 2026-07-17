const data = require('../../../services/data');

const VALID_REAUTH_METHODS = ['password', 'phone', 'email', 'wechat'];
const AUTH_METHOD_LABELS = {
  password: '密码验证',
  phone: '手机号验证',
  email: '邮箱验证',
  wechat: '微信验证',
  sms: '短信验证'
};
const SAFE_ACTION_MESSAGES = {
  ACCOUNT_WECHAT_ALREADY_BOUND: '当前账号已绑定微信',
  WECHAT_ALREADY_BOUND: '当前微信已绑定其他账号',
  AUTH_CONFLICT: '账号状态已变更，请刷新后重试',
  SESSION_REQUIRED: '登录状态已失效，请重新登录',
  SESSION_EXPIRED: '登录状态已失效，请重新登录'
};

function filterMethods(methods, excludedMethod) {
  if (!Array.isArray(methods)) return [];
  const seen = Object.create(null);
  return methods.filter((method) => {
    if (
      method === excludedMethod
      || VALID_REAUTH_METHODS.indexOf(method) === -1
      || seen[method]
    ) return false;
    seen[method] = true;
    return true;
  });
}

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatEpoch(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function currentSessionText(currentSession) {
  if (!currentSession || typeof currentSession !== 'object' || Array.isArray(currentSession)) {
    return '本机会话';
  }
  const method = AUTH_METHOD_LABELS[currentSession.authenticationMethod] || '已验证';
  const lastSeen = formatEpoch(currentSession.lastSeenAt);
  return lastSeen ? `本机 · ${method} · ${lastSeen}` : `本机 · ${method}`;
}

function safeActionMessage(error, fallback) {
  return SAFE_ACTION_MESSAGES[error && error.code] || fallback;
}

Page({
  behaviors: [require('../../../utils/themeBehavior')],

  data: {
    accountText: '未设置',
    accountNameSet: false,
    passwordText: '未设置',
    passwordSet: false,
    qrText: '查看',
    phoneText: '未绑定',
    phoneBound: false,
    emailText: '未绑定',
    emailBound: false,
    wechatText: '未绑定',
    wechatBound: false,
    reauthMethods: [],
    currentSessionText: '本机会话',
    otherSessionCount: 0,
    otherSessionText: '无其他设备',
    statusReady: false,
    actionPending: false,
    recentAuthVisible: false,
    recentAuthMethods: []
  },

  onLoad() {
    this._disposed = false;
    this._active = true;
    this._actionPending = false;
    this._wechatPromptOpen = false;
    this._statusPending = false;
  },

  onShow() {
    this._active = true;
    this._wechatPromptOpen = false;
    this.refresh();
  },

  refresh() {
    if (this._statusPending) return;
    this._statusPending = true;
    const requestToken = this.invalidateRefreshRequest();
    data.getAccountSecurity()
      .then((status) => {
        if (!this.isCurrentRefreshRequest(requestToken)) return;
        this._statusPending = false;
        const source = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
        const accountNameSet = source.accountNameSet === true;
        const passwordSet = source.passwordSet === true;
        const phoneBound = source.phoneBound === true;
        const emailBound = source.emailBound === true;
        const wechatBound = source.wechatBound === true;
        const otherSessionCount = Number.isSafeInteger(source.otherSessionCount) && source.otherSessionCount > 0
          ? source.otherSessionCount
          : 0;
        this.setData({
          accountText: accountNameSet ? (safeString(source.account) || '已设置') : '未设置',
          accountNameSet,
          passwordText: passwordSet ? '已设置' : '未设置',
          passwordSet,
          phoneText: phoneBound ? (safeString(source.phoneMasked) || '已绑定') : '未绑定',
          phoneBound,
          emailText: emailBound ? (safeString(source.emailMasked) || '已绑定') : '未绑定',
          emailBound,
          wechatText: wechatBound ? '已绑定' : '未绑定',
          wechatBound,
          reauthMethods: filterMethods(source.reauthMethods),
          currentSessionText: currentSessionText(source.currentSession),
          otherSessionCount,
          otherSessionText: otherSessionCount > 0 ? `${otherSessionCount} 台其他设备` : '无其他设备',
          statusReady: true,
          actionPending: false,
          recentAuthVisible: false,
          recentAuthMethods: []
        });
      })
      .catch((error) => {
        if (!this.isCurrentRefreshRequest(requestToken)) return;
        this._statusPending = false;
        if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
        this.setData({
          accountText: '未登录',
          accountNameSet: false,
          passwordText: '未设置',
          passwordSet: false,
          phoneText: '未绑定',
          phoneBound: false,
          emailText: '未绑定',
          emailBound: false,
          wechatText: '未绑定',
          wechatBound: false,
          reauthMethods: [],
          currentSessionText: '本机会话',
          otherSessionCount: 0,
          otherSessionText: '无其他设备',
          statusReady: false,
          actionPending: false,
          recentAuthVisible: false,
          recentAuthMethods: []
        });
      });
  },

  invalidateRefreshRequest() {
    this._refreshRequestToken = (this._refreshRequestToken || 0) + 1;
    return this._refreshRequestToken;
  },

  isCurrentRefreshRequest(requestToken) {
    return !this._disposed && this._active !== false && requestToken === this._refreshRequestToken;
  },

  deactivate() {
    this._active = false;
    this.invalidateRefreshRequest();
    this._actionGeneration = (this._actionGeneration || 0) + 1;
    this._modalGeneration = (this._modalGeneration || 0) + 1;
    this._actionPending = false;
    this._statusPending = false;
    this._pendingSensitiveAction = null;
    this._wechatPromptOpen = false;
    this.setData({
      statusReady: false,
      actionPending: false,
      reauthMethods: [],
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
  },

  isCurrentAction(generation) {
    return !this._disposed && this._active !== false && generation === this._actionGeneration;
  },

  performSensitiveAction(run, options, retried) {
    if (
      !this.data.statusReady
      || this._actionPending
      || this._disposed
      || this._active === false
    ) return;
    this._actionPending = true;
    const generation = (this._actionGeneration || 0) + 1;
    this._actionGeneration = generation;
    this.setData({ actionPending: true });
    let request;
    try {
      request = run();
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request)
      .then(() => {
        if (!this.isCurrentAction(generation)) return;
        this._actionPending = false;
        this._pendingSensitiveAction = null;
        this.setData({ actionPending: false, recentAuthVisible: false, recentAuthMethods: [] });
        if (options.successMessage) {
          wx.showToast({ title: options.successMessage, icon: 'success' });
        }
        this.refresh();
      })
      .catch((error) => {
        if (!this.isCurrentAction(generation)) return;
        this._actionPending = false;
        if (error && error.code === 'RECENT_AUTH_REQUIRED' && !retried) {
          this._actionPending = true;
          data.getAccountSecurity()
            .then((status) => {
              if (!this.isCurrentAction(generation)) return;
              this._actionPending = false;
              if (options.boundField && status && status[options.boundField] === true) {
                this._pendingSensitiveAction = null;
                const completedState = {
                  actionPending: false,
                  recentAuthVisible: false,
                  recentAuthMethods: []
                };
                completedState[options.boundField] = true;
                if (options.boundField === 'wechatBound') completedState.wechatText = '\u5df2\u7ed1\u5b9a';
                this.setData(completedState);
                return;
              }
              const methods = filterMethods(
                status && status.reauthMethods,
                options.excludedMethod
              );
              if (methods.length === 0) {
                this._pendingSensitiveAction = null;
                this.setData({ actionPending: false, recentAuthVisible: false, recentAuthMethods: [] });
                wx.showToast({ title: '暂无可用的身份验证方式', icon: 'none' });
                return;
              }
              this._pendingSensitiveAction = { run, options };
              this.setData({
                reauthMethods: filterMethods(status.reauthMethods),
                actionPending: false,
                recentAuthVisible: true,
                recentAuthMethods: methods
              });
            })
            .catch((statusError) => {
              if (!this.isCurrentAction(generation)) return;
              this._actionPending = false;
              this._pendingSensitiveAction = null;
              if (statusError && statusError.code === 'AUTH_ATTEMPT_STALE') {
                this.setData({ actionPending: false });
                return;
              }
              this.setData({ actionPending: false, recentAuthVisible: false, recentAuthMethods: [] });
              wx.showToast({ title: '身份验证方式加载失败，请稍后重试', icon: 'none' });
            });
          return;
        }
        if (error && error.code === 'AUTH_ATTEMPT_STALE') {
          this.setData({ actionPending: false });
          return;
        }
        this._pendingSensitiveAction = null;
        this.setData({ actionPending: false, recentAuthVisible: false, recentAuthMethods: [] });
        wx.showToast({
          title: error && error.code === 'RECENT_AUTH_REQUIRED'
            ? '身份验证已过期，请稍后重试'
            : safeActionMessage(error, options.failureMessage),
          icon: 'none'
        });
      });
  },

  onRecentAuthenticated() {
    if (this._disposed || this._active === false) return;
    const pending = this._pendingSensitiveAction;
    this._pendingSensitiveAction = null;
    this.setData({ recentAuthVisible: false, recentAuthMethods: [] });
    if (pending) this.performSensitiveAction(pending.run, pending.options, true);
  },

  onRecentCancel() {
    this._pendingSensitiveAction = null;
    this.setData({ recentAuthVisible: false, recentAuthMethods: [] });
  },

  onAccountName() {
    if (this.data.statusReady && !this.data.accountNameSet) {
      wx.navigateTo({ url: '/pages/settings/account-security/account-name/index' });
    }
  },

  onPassword() {
    if (this.data.statusReady) {
      wx.navigateTo({ url: '/pages/settings/account-security/password/index' });
    }
  },

  goMyQrcode() {
    wx.navigateTo({ url: '/pages/profile/qrcode/index' });
  },

  onPhone() {
    if (this.data.statusReady && !this.data.phoneBound) {
      wx.navigateTo({ url: '/pages/settings/account-security/phone-binding/index' });
    }
  },

  onEmail() {
    if (this.data.statusReady && !this.data.emailBound) {
      wx.navigateTo({ url: '/pages/settings/email-binding/index' });
    }
  },

  onWechat() {
    if (
      !this.data.statusReady
      || this.data.wechatBound
      || this._wechatPromptOpen
      || this._actionPending
    ) return;
    this._wechatPromptOpen = true;
    const generation = (this._modalGeneration || 0) + 1;
    this._modalGeneration = generation;
    wx.showModal({
      title: '绑定微信',
      content: '是否绑定当前微信？绑定后，后续可直接使用微信登录。',
      confirmText: '确认绑定',
      success: (result) => {
        if (
          this._disposed
          || this._active === false
          || generation !== this._modalGeneration
        ) return;
        this._wechatPromptOpen = false;
        if (!result.confirm) return;
        this.performSensitiveAction(
          () => data.bindWechat(),
          {
            excludedMethod: 'wechat',
            boundField: 'wechatBound',
            successMessage: '微信绑定成功',
            failureMessage: '微信绑定失败，请稍后重试'
          },
          false
        );
      }
    });
  },

  onLogoutOtherSessions() {
    if (!this.data.statusReady || this.data.otherSessionCount <= 0) return;
    this.performSensitiveAction(
      () => data.logoutOtherSessions(),
      {
        successMessage: '其他设备已退出',
        failureMessage: '退出其他设备失败，请稍后重试'
      },
      false
    );
  }
});
