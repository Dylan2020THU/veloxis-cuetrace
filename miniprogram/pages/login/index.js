const data = require('../../services/data');
const adminAuth = require('../../utils/adminAuth');
const { TERMS_VERSION, PRIVACY_VERSION } = require('../../config/auth');

// 三种登录身份，顺序即页面从上至下的展示顺序
const ROLES = [
  { key: 'member', label: '球员', desc: '记录训练 · 追踪成长', img: '/images/login/login-member.jpg' },
  { key: 'coach', label: '教练', desc: '管理学员 · 排课带教', img: '/images/login/login-coach.jpg' },
  { key: 'shop', label: '店主', desc: '门店经营 · 数据看板', img: '/images/login/login-shop.jpg' }
];

const PHONE_RE = /^1\d{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_RE = /^[A-Za-z][A-Za-z0-9_]{3,19}$/;
const ACCOUNT_RULE_TEXT = '账号需 4-20 位，字母开头，仅支持字母、数字、下划线';
const INVALID_CREDENTIALS_TEXT = '账号或密码错误';
const RECOVERY_ERROR_TEXT = '无法重置密码，请确认信息后重试';
const WECHAT_BIND_CONFIRM_TEXT = '是否绑定当前微信？绑定后，后续可直接使用微信登录。';
const WECHAT_BIND_SUCCESS_TEXT = '绑定成功，后续可直接使用微信登录';

const VALID_ROLES = ['member', 'coach', 'shop'];

function roleOptions(roles) {
  const list = Array.isArray(roles) ? roles.filter((r) => VALID_ROLES.indexOf(r) !== -1) : [];
  const unique = Array.from(new Set(list));
  return ROLES.map((item) => Object.assign({}, item, { enabled: unique.indexOf(item.key) !== -1 }));
}

// 各身份登录后的落地首页
const HOME_BY_ROLE = {
  member: '/pages/checkin/index',
  coach: '/pages/checkin/index',
  shop: '/pages/shop/hall-status/index'
};
const SHOP_APPLY_URL = '/pages/shop/apply/index?source=rolePicker';
const ADMIN_HOME = '/pages/admin/stores/index';

// 属于 tabBar 的落地页需用 switchTab，其余用 reLaunch
const TAB_HOMES = ['/pages/checkin/index', '/pages/coach/members/index', '/pages/shop/hall-status/index'];

function isCloudFunctionNotFound(err) {
  const text = `${(err && err.message) || ''} ${(err && err.errMsg) || ''} ${(err && err.code) || ''}`;
  return (err && err.errCode === -501000) || text.indexOf('FUNCTION_NOT_FOUND') !== -1 || text.indexOf('FunctionName parameter could not be found') !== -1;
}

Page({
  behaviors: [require('../../utils/themeBehavior')],

  data: {
    cloudReady: false,
    role: 'member',
    roleLabel: '球员',
    // 页面模式：login | register | recover | wechatPhone | rolePicker
    mode: 'login',
    // 登录方式：sms = 手机验证码，password = 手机号或账号密码
    loginType: 'sms',
    identifier: '',
    password: '',
    phone: '',
    code: '',
    smsChallengeId: '',
    smsChallengePhone: '',
    counting: false,
    sendingCode: false,
    countdown: 60,
    authSubmitting: false,
    roleStatusLoading: false,
    registerSubmitting: false,
    wechatVerifying: false,
    wechatCompleting: false,
    agreementChecked: false,
    accountRuleText: ACCOUNT_RULE_TEXT,
    // 注册表单
    regAccount: '',
    regPassword: '',
    regConfirm: '',
    // 密码找回表单（独立于手机号验证码登录状态）
    recoveryType: 'wechat',
    recoveryEmail: '',
    recoveryCode: '',
    recoveryPassword: '',
    recoveryConfirm: '',
    recoveryCounting: false,
    recoverySending: false,
    recoverySubmitting: false,
    recoveryCountdown: 60,
    pendingAccount: '',
    pendingAccountDisplay: '',
    pendingRoles: [],
    availableRoles: []
  },

  onLoad(options = {}) {
    this._disposed = false;
    this._hidden = false;
    this.syncCloudReady();
    const app = getApp();
    const globalData = app && app.globalData;
    const rolePickerRequired = options.switchRole === '1' ||
      options.rolePicker === '1' ||
      !!(globalData && globalData.authRolePickerRequired);
    if (globalData && globalData.authRolePickerRequired) {
      globalData.authRolePickerRequired = false;
    }
    if (rolePickerRequired) {
      this.openSwitchRolePicker();
    }
    // probeCloud 是异步的，onLoad 时可能尚未完成；补一次延迟同步以纠正按钮文案
    this._cloudTimer = setTimeout(() => this.syncCloudReady(), 1500);
  },

  onShow() {
    this._hidden = false;
    this.syncCloudReady();
  },

  // 以 globalData 的实时云端就绪态为准，避免探测未完成时误判为"未连云"而退回演示表单
  syncCloudReady() {
    const app = getApp();
    const cloudReady = !!(app && app.globalData && app.globalData.cloudReady);
    if (cloudReady !== this.data.cloudReady) this.setData({ cloudReady });
  },

  showRequestLoading(owner, title) {
    this._loadingOwner = owner;
    wx.showLoading({ title, mask: true });
  },

  hideRequestLoading(owner) {
    if (this._loadingOwner !== owner) return;
    this._loadingOwner = null;
    wx.hideLoading();
  },

  cancelAuthRequest() {
    this._authRequestToken = (this._authRequestToken || 0) + 1;
    const current = this._activeAuthRequest;
    this._activeAuthRequest = null;
    if (!current) return;
    data.cancelAuthAttempt(current.attempt);
    this.hideRequestLoading(current.owner);
    if (this.data[current.field]) this.setData({ [current.field]: false });
  },

  beginSessionRequest(kind, field, title) {
    if (this.data[field]) return null;
    this.cancelAuthRequest();
    const token = (this._authRequestToken || 0) + 1;
    this._authRequestToken = token;
    let attempt;
    try {
      attempt = data.beginAuthAttempt(kind);
    } catch (error) {
      wx.showToast({ title: (error && error.message) || '认证服务暂时不可用', icon: 'none' });
      return null;
    }
    const request = { token, attempt, field, owner: { type: 'auth', token } };
    this._activeAuthRequest = request;
    this.setData({ [field]: true });
    this.showRequestLoading(request.owner, title);
    return request;
  },

  isSessionRequestCurrent(request) {
    return !this._disposed && !this._hidden && this._activeAuthRequest === request;
  },

  finishSessionRequest(request, cancelAttempt) {
    if (!this.isSessionRequestCurrent(request)) return false;
    this._activeAuthRequest = null;
    if (cancelAttempt) data.cancelAuthAttempt(request.attempt);
    this.hideRequestLoading(request.owner);
    this.setData({ [request.field]: false });
    return true;
  },

  cancelSmsRequest(resetChallenge = true) {
    this._smsRequestToken = (this._smsRequestToken || 0) + 1;
    const current = this._activeSmsRequest;
    this._activeSmsRequest = null;
    if (current) this.hideRequestLoading(current.owner);
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    const next = {
      sendingCode: false,
      counting: false,
      countdown: 60
    };
    if (resetChallenge) {
      next.smsChallengeId = '';
      next.smsChallengePhone = '';
    }
    this.setData(next);
  },

  isSmsRequestCurrent(request) {
    return !this._disposed && !this._hidden && this._activeSmsRequest === request;
  },

  cancelWechatVerification() {
    this._wechatVerifyToken = (this._wechatVerifyToken || 0) + 1;
    this._wechatDecisionToken = (this._wechatDecisionToken || 0) + 1;
    const current = this._activeWechatVerify;
    this._activeWechatVerify = null;
    if (current) this.hideRequestLoading(current.owner);
    if (this.data.wechatVerifying) this.setData({ wechatVerifying: false });
  },

  cancelRoleStatusRequest() {
    this._roleStatusRequestToken = (this._roleStatusRequestToken || 0) + 1;
    const current = this._activeRoleStatusRequest;
    this._activeRoleStatusRequest = null;
    if (current) this.hideRequestLoading(current.owner);
    if (this.data.roleStatusLoading) this.setData({ roleStatusLoading: false });
  },

  isRoleStatusRequestCurrent(request) {
    return !this._disposed && !this._hidden && this._activeRoleStatusRequest === request;
  },

  finishRoleStatusRequest(request) {
    if (!this.isRoleStatusRequestCurrent(request)) return false;
    this._activeRoleStatusRequest = null;
    this.hideRequestLoading(request.owner);
    this.setData({ roleStatusLoading: false });
    return true;
  },

  invalidateAuthWork() {
    this.cancelAuthRequest();
    this.cancelSmsRequest(true);
    this.cancelWechatVerification();
    this.cancelRoleStatusRequest();
  },

  goHome(role) {
    const url = HOME_BY_ROLE[role] || HOME_BY_ROLE.member;
    if (TAB_HOMES.indexOf(url) !== -1) {
      wx.switchTab({ url });
    } else {
      wx.reLaunch({ url });
    }
  },

  showRolePicker(account, accountDisplay, roles) {
    const pendingRoles = Array.from(new Set(
      Array.isArray(roles) ? roles.filter((role) => VALID_ROLES.indexOf(role) !== -1) : []
    ));
    const availableRoles = roleOptions(pendingRoles);
    const first = availableRoles.find((item) => item.enabled) || null;
    this.setData({
      mode: 'rolePicker',
      pendingAccount: typeof account === 'string' ? account : '',
      pendingAccountDisplay: typeof accountDisplay === 'string' ? accountDisplay : '',
      pendingRoles,
      availableRoles,
      role: first ? first.key : '',
      roleLabel: first ? first.label : '',
      agreementChecked: false
    });
  },

  handleAuthenticated(result) {
    const account = result && typeof result.account === 'string' ? result.account : '';
    const accountDisplay = result && typeof result.accountDisplay === 'string' ? result.accountDisplay : '';
    const roles = result && Array.isArray(result.roles) ? result.roles : [];
    this.showRolePicker(account, accountDisplay, roles);
  },

  handleAuthError(error, fallback) {
    wx.showToast({ title: (error && error.message) || fallback, icon: 'none' });
  },

  handlePasswordLoginError(error) {
    if (error && ['ACCOUNT_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_CREDENTIALS'].indexOf(error.code) !== -1) {
      wx.showToast({ title: INVALID_CREDENTIALS_TEXT, icon: 'none' });
      return;
    }
    wx.showToast({ title: (error && error.message) || INVALID_CREDENTIALS_TEXT, icon: 'none' });
  },

  currentSessionRoles() {
    const app = getApp();
    const gd = (app && app.globalData) || {};
    const roles = Array.isArray(gd.roles) ? gd.roles : [];
    const valid = roles.filter((role) => VALID_ROLES.indexOf(role) !== -1);
    return {
      account: gd.account || '',
      accountDisplay: gd.accountDisplay || '',
      roles: Array.from(new Set(valid))
    };
  },

  openSwitchRolePicker() {
    if (this._activeRoleStatusRequest) return;
    const session = this.currentSessionRoles();
    if (session.account && session.roles.length) {
      this.showRolePicker(session.account, session.accountDisplay, session.roles);
      return;
    }
    if (typeof data.getAccountSecurity !== 'function') {
      this.handleAuthError(null, '登录状态已失效，请重新登录');
      return;
    }
    const token = (this._roleStatusRequestToken || 0) + 1;
    this._roleStatusRequestToken = token;
    const request = { token, owner: { type: 'roleStatus', token } };
    this._activeRoleStatusRequest = request;
    this.setData({ roleStatusLoading: true });
    this.showRequestLoading(request.owner, '加载中');
    data
      .getAccountSecurity()
      .then((result) => {
        if (!this.finishRoleStatusRequest(request)) return;
        this.handleAuthenticated(result);
      })
      .catch((error) => {
        if (!this.finishRoleStatusRequest(request)) return;
        this.handleAuthError(error, '登录状态已失效，请重新登录');
      });
  },

  chooseRole(e) {
    const role = e.currentTarget.dataset.role;
    const found = this.data.availableRoles.find((item) => item.key === role);
    if (!found || !found.enabled) {
      this.promptOpenRole(role);
      return;
    }
    this.setData({ role, roleLabel: found.label });
  },

  enterSelectedRole() {
    const { role, pendingRoles } = this.data;
    if (pendingRoles.indexOf(role) === -1) {
      this.promptOpenRole(role);
      return;
    }
    this.doLogin(role);
  },

  promptOpenRole(role) {
    const found = ROLES.find((item) => item.key === role);
    const label = found ? found.label : '该';
    const isShop = role === 'shop';
    const isCoach = role === 'coach';
    wx.showModal({
      title: `${label}身份未开通`,
      content: isShop ? '开通店主身份需要提交门店资质并通过审核，是否前往提交？' : isCoach ? '开通教练身份需要由已认证店主进行认证，是否了解开通方式？' : '该账号暂未开通此身份，是否了解开通方式？',
      confirmText: isShop ? '去提交' : '了解',
      cancelText: '暂不开通',
      success: (res) => {
        if (!res.confirm) return;
        if (isShop) {
          wx.navigateTo({
            url: SHOP_APPLY_URL,
            fail: () => wx.reLaunch({ url: SHOP_APPLY_URL })
          });
          return;
        }
        wx.showToast({ title: '请联系已认证店主开通教练身份', icon: 'none' });
      }
    });
  },

  wechatLogin() {
    if (!this.ensureAgreementChecked()) return;
    const request = this.beginSessionRequest('loginWechat', 'authSubmitting', '登录中');
    if (!request) return;
    data
      .loginWithWechat({ termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION }, request.attempt)
      .then((result) => {
        if (!this.isSessionRequestCurrent(request)) return;
        if (
          result
          && result.ok === false
          && result.code === 'WECHAT_NOT_BOUND'
          && result.next === 'wechat_phone'
        ) {
          this.finishSessionRequest(request, true);
          this.enterWechatPhone();
          return;
        }
        this.finishSessionRequest(request, false);
        this.handleAuthenticated(result);
      })
      .catch((error) => {
        if (!this.isSessionRequestCurrent(request)) return;
        this.finishSessionRequest(request, true);
        if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
        this.handleAuthError(error, '微信登录失败');
      });
  },

  doAdminLogin(account, password) {
    wx.showLoading({ title: '登录中', mask: true });
    data
      .loginAdmin({ account, password })
      .then(() => {
        wx.hideLoading();
        wx.reLaunch({ url: ADMIN_HOME });
      })
      .catch((error) => {
        wx.hideLoading();
        wx.showToast({
          title: isCloudFunctionNotFound(error)
            ? '请先部署 adminLogin 云函数'
            : ((error && error.message) || '管理员登录失败'),
          icon: 'none'
        });
      });
  },

  doLogin(role) {
    // 店主需先通过营业执照资质审核，单独走带状态网关的登录流程
    if (role === 'shop') {
      this.doShopLogin();
      return;
    }
    wx.showLoading({ title: '登录中', mask: true });
    data
      .selectRole(role)
      .then(() => data.getUserProfile())
      .then(() => data.markFirstLogin(role))
      .then(() => {
        wx.hideLoading();
        this.goHome(role);
      })
      .catch((e) => {
        wx.hideLoading();
        wx.showToast({ title: (e && e.message) || '登录失败，请重试', icon: 'none' });
      });
  },

  // 店主登录网关：登录后查资质状态。approved → 进店主端；其余（未申请/待审核/已驳回）→ 资质核验页。
  doShopLogin() {
    wx.showLoading({ title: '登录中', mask: true });
    data
      .selectRole('shop')
      .then(() => data.getUserProfile())
      .then(() => data.getShopApplicationStatus())
      .then((res) => {
        const status = (res && res.status) || 'none';
        if (status === 'approved') {
          return data.markFirstLogin('shop').then(() => {
            wx.hideLoading();
            this.goHome('shop');
          });
        }
        wx.hideLoading();
        wx.reLaunch({ url: '/pages/shop/apply/index' });
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: '登录失败，请重试', icon: 'none' });
      });
  },

  // 身份选择页返回账号登录页
  goPrev() {
    this.invalidateAuthWork();
    this.cancelRecoveryEmailRequest();
    this.cancelRecoverySubmission();
    this.setData({
      mode: 'login',
      loginType: 'sms',
      agreementChecked: false,
      pendingAccount: '',
      pendingAccountDisplay: '',
      pendingRoles: [],
      availableRoles: []
    });
  },

  // 切换到注册态
  goRegister() {
    this.invalidateAuthWork();
    this.cancelRecoveryEmailRequest();
    this.cancelRecoverySubmission();
    this.setData({ mode: 'register', regAccount: '', regPassword: '', regConfirm: '', agreementChecked: false });
  },

  // 注册态 → 返回登录态
  backToLogin() {
    this.invalidateAuthWork();
    this.cancelRecoveryEmailRequest();
    this.cancelRecoverySubmission();
    this.setData({
      mode: 'login',
      loginType: 'sms',
      agreementChecked: false,
      phone: '',
      code: '',
      smsChallengeId: '',
      smsChallengePhone: ''
    });
  },

  enterWechatPhone() {
    this.invalidateAuthWork();
    this.cancelRecoveryEmailRequest();
    this.cancelRecoverySubmission();
    this.setData({
      mode: 'wechatPhone',
      agreementChecked: false,
      phone: '',
      code: '',
      smsChallengeId: '',
      smsChallengePhone: '',
      wechatVerifying: false,
      wechatCompleting: false
    });
  },

  onBackPress() {
    this.invalidateAuthWork();
    this.cancelRecoveryEmailRequest();
    this.cancelRecoverySubmission();
    return false;
  },

  openRecovery() {
    this.invalidateAuthWork();
    this.cancelRecoveryEmailRequest();
    this.cancelRecoverySubmission();
    this.setData({
      mode: 'recover',
      recoveryType: 'wechat',
      recoveryEmail: '',
      recoveryCode: '',
      recoveryPassword: '',
      recoveryConfirm: '',
      recoveryCounting: false,
      recoverySending: false,
      recoverySubmitting: false,
      recoveryCountdown: 60,
      agreementChecked: false
    });
  },

  switchRecoveryType(e) {
    const type = e.currentTarget.dataset.type === 'email' ? 'email' : 'wechat';
    this.cancelRecoveryEmailRequest();
    this.cancelRecoverySubmission();
    this.setData({
      recoveryType: type,
      recoveryCode: ''
    });
  },

  invalidateRecoveryEmailRequest() {
    this._recoveryEmailRequestToken = (this._recoveryEmailRequestToken || 0) + 1;
    return this._recoveryEmailRequestToken;
  },

  cancelRecoveryEmailRequest() {
    this.invalidateRecoveryEmailRequest();
    this.clearRecoveryCountdown();
    if (this._recoveryEmailOwner) {
      this.hideRequestLoading(this._recoveryEmailOwner);
      this._recoveryEmailOwner = null;
    }
    this.setData({
      recoverySending: false,
      recoveryCounting: false,
      recoveryCountdown: 60
    });
  },

  isCurrentRecoveryEmailRequest(requestToken) {
    return !this._disposed &&
      requestToken === this._recoveryEmailRequestToken &&
      this.data.mode === 'recover' &&
      this.data.recoveryType === 'email';
  },

  beginRecoverySubmission(type) {
    if (this.data.recoverySubmitting) return null;
    const token = (this._recoverySubmissionToken || 0) + 1;
    this._recoverySubmissionToken = token;
    this._recoverySubmissionOwner = { type: `recovery:${type}`, token };
    this.setData({ recoverySubmitting: true });
    return token;
  },

  isRecoverySubmissionCurrent(token, type) {
    return !this._disposed &&
      token === this._recoverySubmissionToken &&
      this.data.recoverySubmitting &&
      this.data.mode === 'recover' &&
      this.data.recoveryType === type;
  },

  cancelRecoverySubmission() {
    const wasSubmitting = this.data.recoverySubmitting;
    this._recoverySubmissionToken = (this._recoverySubmissionToken || 0) + 1;
    if (this._recoverySubmissionOwner) {
      this.hideRequestLoading(this._recoverySubmissionOwner);
      this._recoverySubmissionOwner = null;
    }
    if (wasSubmitting) this.setData({ recoverySubmitting: false });
  },

  clearRecoveryCountdown() {
    if (this._recoveryTimer) {
      clearInterval(this._recoveryTimer);
      this._recoveryTimer = null;
    }
  },

  startRecoveryCountdown() {
    this.clearRecoveryCountdown();
    this.setData({ recoveryCounting: true, recoveryCountdown: 60 });
    this._recoveryTimer = setInterval(() => {
      const next = this.data.recoveryCountdown - 1;
      if (next <= 0) {
        this.clearRecoveryCountdown();
        this.setData({ recoveryCounting: false, recoveryCountdown: 60 });
      } else {
        this.setData({ recoveryCountdown: next });
      }
    }, 1000);
  },

  sendRecoveryEmailCode() {
    if (this.data.recoveryCounting || this.data.recoverySending) return;
    const email = (this.data.recoveryEmail || '').trim();
    if (!EMAIL_RE.test(email)) {
      return wx.showToast({ title: '请输入正确的邮箱', icon: 'none' });
    }
    this.setData({ recoverySending: true });
    const requestToken = this.invalidateRecoveryEmailRequest();
    const owner = { type: 'recoveryEmail', token: requestToken };
    this._recoveryEmailOwner = owner;
    this.showRequestLoading(owner, '发送中');
    data
      .sendEmailCode({ purpose: 'reset', email })
      .then(() => {
        if (!this.isCurrentRecoveryEmailRequest(requestToken)) return;
        this.hideRequestLoading(owner);
        this._recoveryEmailOwner = null;
        this.setData({ recoverySending: false });
        wx.showToast({ title: '若信息匹配，验证码将发送至绑定邮箱', icon: 'none' });
        this.startRecoveryCountdown();
      })
      .catch(() => {
        if (!this.isCurrentRecoveryEmailRequest(requestToken)) return;
        this.hideRequestLoading(owner);
        this._recoveryEmailOwner = null;
        this.setData({ recoverySending: false });
        wx.showToast({ title: '验证码发送失败，请稍后重试', icon: 'none' });
      });
  },

  finishRecovery(result) {
    this.cancelRecoverySubmission();
    this.cancelRecoveryEmailRequest();
    this.setData({
      mode: 'login',
      loginType: 'password',
      identifier: '',
      password: '',
      recoveryCode: '',
      recoveryPassword: '',
      recoveryConfirm: '',
      recoveryCounting: false,
      recoverySending: false,
      recoverySubmitting: false,
      recoveryCountdown: 60,
      agreementChecked: false
    });
    wx.showToast({ title: '密码已重置，请使用新密码登录', icon: 'none' });
  },

  submitRecovery() {
    if (this.data.recoverySubmitting) return;
    const password = this.data.recoveryPassword || '';
    if (password.length < 6) {
      return wx.showToast({ title: '密码至少 6 位', icon: 'none' });
    }
    if (password !== this.data.recoveryConfirm) {
      return wx.showToast({ title: '两次密码不一致', icon: 'none' });
    }

    if (this.data.recoveryType === 'wechat') {
      const requestToken = this.beginRecoverySubmission('wechat');
      if (requestToken === null) return;
      this.showRequestLoading(this._recoverySubmissionOwner, '重置中');
      data
        .resetPasswordByWechat({ password })
        .then((result) => {
          if (!this.isRecoverySubmissionCurrent(requestToken, 'wechat')) return;
          this.finishRecovery(result);
        })
        .catch(() => {
          if (!this.isRecoverySubmissionCurrent(requestToken, 'wechat')) return;
          this.cancelRecoverySubmission();
          wx.showToast({ title: RECOVERY_ERROR_TEXT, icon: 'none' });
        });
      return;
    }

    const email = (this.data.recoveryEmail || '').trim();
    const code = (this.data.recoveryCode || '').trim();
    if (!EMAIL_RE.test(email)) {
      return wx.showToast({ title: '请输入正确的邮箱', icon: 'none' });
    }
    if (!code) {
      return wx.showToast({ title: '请输入验证码', icon: 'none' });
    }
    const requestToken = this.beginRecoverySubmission('email');
    if (requestToken === null) return;
    this.showRequestLoading(this._recoverySubmissionOwner, '重置中');
    data
      .resetPasswordByEmail({ email, code, password })
      .then((result) => {
        if (!this.isRecoverySubmissionCurrent(requestToken, 'email')) return;
        this.finishRecovery(result);
      })
      .catch((error) => {
        if (!this.isRecoverySubmissionCurrent(requestToken, 'email')) return;
        this.cancelRecoverySubmission();
        wx.showToast({ title: RECOVERY_ERROR_TEXT, icon: 'none' });
      });
  },

  toggleAgreement() {
    this.setData({ agreementChecked: !this.data.agreementChecked });
  },

  openAgreement() {
    wx.navigateTo({ url: '/pages/legal/index?type=agreement' });
  },

  openPrivacyPolicy() {
    wx.navigateTo({ url: '/pages/legal/index?type=privacy' });
  },

  ensureAgreementChecked() {
    if (this.data.agreementChecked) return true;
    wx.showToast({ title: '请先阅读并同意协议与隐私政策', icon: 'none' });
    return false;
  },

  isValidRegisterAccount(account) {
    return ACCOUNT_RE.test(account);
  },

  register() {
    if (this.data.registerSubmitting) return;
    if (!this.ensureAgreementChecked()) return;
    const account = (this.data.regAccount || '').trim();
    const { regPassword, regConfirm } = this.data;
    if (!account) {
      return wx.showToast({ title: '请输入账号', icon: 'none' });
    }
    if (!this.isValidRegisterAccount(account)) {
      return wx.showToast({ title: ACCOUNT_RULE_TEXT, icon: 'none' });
    }
    if (!regPassword || regPassword.length < 6) {
      return wx.showToast({ title: '密码至少 6 位', icon: 'none' });
    }
    if (regPassword !== regConfirm) {
      return wx.showToast({ title: '两次密码不一致', icon: 'none' });
    }
    const request = this.beginSessionRequest('registerAccountName', 'registerSubmitting', '注册中');
    if (!request) return;
    data
      .registerAccountName({
        accountName: account,
        password: regPassword,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      }, request.attempt)
      .then((result) => {
        if (!this.isSessionRequestCurrent(request)) return;
        this.finishSessionRequest(request, false);
        this.handleAuthenticated(result);
      })
      .catch((error) => {
        if (!this.isSessionRequestCurrent(request)) return;
        this.finishSessionRequest(request, true);
        if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
        if (error && (error.code === 'ACCOUNT_NAME_EXISTS' || error.code === 'ACCOUNT_EXISTS')) {
          wx.showToast({ title: '该账号已注册', icon: 'none' });
          return;
        }
        this.handleAuthError(error, '注册失败，请重试');
      });
  },

  switchType(e) {
    const loginType = e.currentTarget.dataset.type === 'password' ? 'password' : 'sms';
    if (loginType === this.data.loginType) return;
    this.invalidateAuthWork();
    this.cancelRecoveryEmailRequest();
    this.cancelRecoverySubmission();
    this.setData({
      mode: 'login',
      loginType,
      agreementChecked: false,
      password: '',
      code: '',
      smsChallengeId: '',
      smsChallengePhone: ''
    });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    if (field === 'phone' && value !== this.data.phone) {
      this.invalidateAuthWork();
      this.setData({
        phone: value,
        code: '',
        smsChallengeId: '',
        smsChallengePhone: ''
      });
      return;
    }
    this.setData({ [field]: value });
  },

  startCodeCountdown() {
    if (this._timer) clearInterval(this._timer);
    this.setData({ counting: true, countdown: 60 });
    this._timer = setInterval(() => {
      const next = this.data.countdown - 1;
      if (next <= 0) {
        clearInterval(this._timer);
        this._timer = null;
        this.setData({ counting: false, countdown: 60 });
      } else {
        this.setData({ countdown: next });
      }
    }, 1000);
  },

  // 发送验证码
  sendCode() {
    if (this.data.counting || this.data.sendingCode) return;
    if (!this.ensureAgreementChecked()) return;
    const phone = (this.data.phone || '').trim();
    if (!PHONE_RE.test(phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    this.cancelSmsRequest(true);
    const token = (this._smsRequestToken || 0) + 1;
    this._smsRequestToken = token;
    const purpose = this.data.mode === 'wechatPhone' ? 'wechat_entry' : 'login';
    const request = {
      token,
      phone,
      purpose,
      owner: { type: 'sms', token }
    };
    this._activeSmsRequest = request;
    this.setData({ sendingCode: true });
    this.showRequestLoading(request.owner, '发送中');
    data
      .sendSmsCode({ phone, purpose })
      .then((result) => {
        if (!this.isSmsRequestCurrent(request)) return;
        const challengeId = result && typeof result.challengeId === 'string' ? result.challengeId : '';
        if (!challengeId) throw Object.assign(new Error('验证码发送失败'), { code: 'AUTH_INTERNAL_ERROR' });
        this._activeSmsRequest = null;
        this.hideRequestLoading(request.owner);
        this.setData({
          sendingCode: false,
          smsChallengeId: challengeId,
          smsChallengePhone: phone
        });
        wx.showToast({ title: '验证码已发送', icon: 'none' });
        this.startCodeCountdown();
      })
      .catch((e) => {
        if (!this.isSmsRequestCurrent(request)) return;
        this._activeSmsRequest = null;
        this.hideRequestLoading(request.owner);
        this.setData({ sendingCode: false });
        wx.showToast({ title: (e && e.message) || '验证码发送失败', icon: 'none' });
      });
  },

  verifyWechatEntryPhone() {
    if (this.data.wechatVerifying || this.data.mode !== 'wechatPhone') return;
    if (!this.ensureAgreementChecked()) return;
    const phone = (this.data.phone || '').trim();
    const code = (this.data.code || '').trim();
    if (!PHONE_RE.test(phone)) {
      return wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
    }
    if (!code) return wx.showToast({ title: '请输入验证码', icon: 'none' });
    if (!this.data.smsChallengeId || this.data.smsChallengePhone !== phone) {
      return wx.showToast({ title: '请先获取当前手机号的验证码', icon: 'none' });
    }
    this.cancelWechatVerification();
    const token = (this._wechatVerifyToken || 0) + 1;
    this._wechatVerifyToken = token;
    const request = { token, owner: { type: 'wechatVerify', token } };
    this._activeWechatVerify = request;
    this.setData({ wechatVerifying: true });
    this.showRequestLoading(request.owner, '校验中');
    data
      .verifyWechatEntryPhone({
        phone,
        challengeId: this.data.smsChallengeId,
        code,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
      .then((result) => {
        if (!this._activeWechatVerify || this._activeWechatVerify !== request || this._disposed || this._hidden) return;
        const proofToken = result && typeof result.proofToken === 'string' ? result.proofToken : '';
        if (!proofToken) throw new Error('手机号验证失败');
        this._activeWechatVerify = null;
        this.hideRequestLoading(request.owner);
        this.setData({ wechatVerifying: false });
        const decisionToken = (this._wechatDecisionToken || 0) + 1;
        this._wechatDecisionToken = decisionToken;
        wx.showModal({
          title: '微信登录',
          content: WECHAT_BIND_CONFIRM_TEXT,
          confirmText: '确认绑定',
          cancelText: '暂不绑定',
          success: (choice) => {
            if (
              this._disposed
              || this._hidden
              || this.data.mode !== 'wechatPhone'
              || decisionToken !== this._wechatDecisionToken
            ) return;
            this.completeWechatEntry(proofToken, !!(choice && choice.confirm));
          }
        });
      })
      .catch((error) => {
        if (!this._activeWechatVerify || this._activeWechatVerify !== request || this._disposed || this._hidden) return;
        this._activeWechatVerify = null;
        this.hideRequestLoading(request.owner);
        this.setData({ wechatVerifying: false });
        wx.showToast({ title: (error && error.message) || '手机号验证失败', icon: 'none' });
      });
  },

  completeWechatEntry(proofToken, bindWechat) {
    if (this.data.wechatCompleting || this.data.mode !== 'wechatPhone') return;
    if (!this.ensureAgreementChecked()) return;
    if (typeof proofToken !== 'string' || !proofToken) return;
    const request = this.beginSessionRequest('completeWechatEntry', 'wechatCompleting', '登录中');
    if (!request) return;
    data
      .completeWechatEntry({
        proofToken,
        bindWechat: bindWechat === true,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      }, request.attempt)
      .then((result) => {
        if (!this.isSessionRequestCurrent(request)) return;
        this.finishSessionRequest(request, false);
        if (bindWechat === true) {
          wx.showToast({ title: WECHAT_BIND_SUCCESS_TEXT, icon: 'none' });
        }
        this.handleAuthenticated(result);
      })
      .catch((error) => {
        if (!this.isSessionRequestCurrent(request)) return;
        this.finishSessionRequest(request, true);
        if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
        wx.showToast({ title: (error && error.message) || '微信登录失败', icon: 'none' });
      });
  },

  submit() {
    if (this.data.authSubmitting || this.data.mode !== 'login') return;
    if (!this.ensureAgreementChecked()) return;
    const { loginType } = this.data;
    if (loginType === 'password') {
      const identifier = (this.data.identifier || '').trim();
      if (!identifier) {
        return wx.showToast({ title: '请输入手机号或账号', icon: 'none' });
      }
      if (!this.data.password) {
        return wx.showToast({ title: '请输入密码', icon: 'none' });
      }
      if (adminAuth.isAdminAccount(identifier)) {
        this.doAdminLogin(identifier, this.data.password);
        return;
      }
      const request = this.beginSessionRequest('loginPassword', 'authSubmitting', '登录中');
      if (!request) return;
      data
        .loginWithPassword({
          identifier,
          password: this.data.password,
          termsVersion: TERMS_VERSION,
          privacyVersion: PRIVACY_VERSION
        }, request.attempt)
        .then((result) => {
          if (!this.isSessionRequestCurrent(request)) return;
          this.finishSessionRequest(request, false);
          this.handleAuthenticated(result);
        })
        .catch((error) => {
          if (!this.isSessionRequestCurrent(request)) return;
          this.finishSessionRequest(request, true);
          if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
          this.handlePasswordLoginError(error);
        });
      return;
    } else {
      const phone = (this.data.phone || '').trim();
      if (!PHONE_RE.test(phone)) {
        return wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      }
      if (!(this.data.code || '').trim()) {
        return wx.showToast({ title: '请输入验证码', icon: 'none' });
      }
      if (!this.data.smsChallengeId || this.data.smsChallengePhone !== phone) {
        return wx.showToast({ title: '请先获取当前手机号的验证码', icon: 'none' });
      }
      const request = this.beginSessionRequest('loginSms', 'authSubmitting', '校验中');
      if (!request) return;
      data
        .loginWithSms({
          phone,
          challengeId: this.data.smsChallengeId,
          code: (this.data.code || '').trim(),
          termsVersion: TERMS_VERSION,
          privacyVersion: PRIVACY_VERSION
        }, request.attempt)
        .then((result) => {
          if (!this.isSessionRequestCurrent(request)) return;
          this.finishSessionRequest(request, false);
          this.handleAuthenticated(result);
        })
        .catch((e) => {
          if (!this.isSessionRequestCurrent(request)) return;
          this.finishSessionRequest(request, true);
          if (e && e.code === 'AUTH_ATTEMPT_STALE') return;
          wx.showToast({ title: (e && e.message) || '验证码错误或已过期', icon: 'none' });
        });
      return;
    }
  },

  onHide() {
    this._hidden = true;
    this.invalidateAuthWork();
    this.cancelRecoverySubmission();
    this.cancelRecoveryEmailRequest();
  },

  onUnload() {
    this._disposed = true;
    this._hidden = true;
    this.invalidateAuthWork();
    if (this._cloudTimer) {
      clearTimeout(this._cloudTimer);
      this._cloudTimer = null;
    }
    this.cancelRecoverySubmission();
    this.cancelRecoveryEmailRequest();
  }
});
