const data = require('../../services/data');
const adminAuth = require('../../utils/adminAuth');

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

const VALID_ROLES = ['member', 'coach', 'shop'];

function roleOptions(roles) {
  const list = Array.isArray(roles) ? roles.filter((r) => VALID_ROLES.indexOf(r) !== -1) : ['member'];
  const unique = Array.from(new Set(list.length ? list : ['member']));
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
    // 登录步骤：auth = 账号登录/注册，role = 验证账号后选择身份
    step: 'auth',
    // 账号页模式：login = 登录，wechatBind = 微信绑定，register = 注册，recover = 找回密码
    mode: 'login',
    // 登录方式：password = 账号密码，sms = 手机验证码
    loginType: 'password',
    account: '',
    password: '',
    phone: '',
    code: '',
    counting: false,
    sendingCode: false,
    countdown: 60,
    agreementChecked: false,
    accountRuleText: ACCOUNT_RULE_TEXT,
    // 注册表单
    regAccount: '',
    regPassword: '',
    regConfirm: '',
    // 密码找回表单（独立于手机号验证码登录状态）
    recoveryType: 'wechat',
    recoveryAccount: '',
    recoveryEmail: '',
    recoveryCode: '',
    recoveryPassword: '',
    recoveryConfirm: '',
    recoveryCounting: false,
    recoverySending: false,
    recoverySubmitting: false,
    recoveryCountdown: 60,
    pendingAccount: '',
    pendingRoles: [],
    availableRoles: []
  },

  onLoad(options = {}) {
    this._disposed = false;
    this.syncCloudReady();
    if (options.switchRole === '1') {
      this.openSwitchRolePicker();
    }
    // probeCloud 是异步的，onLoad 时可能尚未完成；补一次延迟同步以纠正按钮文案
    this._cloudTimer = setTimeout(() => this.syncCloudReady(), 1500);
  },

  onShow() {
    this.syncCloudReady();
  },

  // 以 globalData 的实时云端就绪态为准，避免探测未完成时误判为"未连云"而退回演示表单
  syncCloudReady() {
    const app = getApp();
    const cloudReady = !!(app && app.globalData && app.globalData.cloudReady);
    if (cloudReady !== this.data.cloudReady) this.setData({ cloudReady });
  },

  goHome(role) {
    const url = HOME_BY_ROLE[role] || HOME_BY_ROLE.member;
    if (TAB_HOMES.indexOf(url) !== -1) {
      wx.switchTab({ url });
    } else {
      wx.reLaunch({ url });
    }
  },

  showRolePicker(loginName, roles) {
    const pendingRoles = Array.isArray(roles) && roles.length ? Array.from(new Set(roles)) : ['member'];
    const availableRoles = roleOptions(pendingRoles);
    const first = availableRoles.find((item) => item.enabled) || availableRoles[0] || ROLES[0];
    this.setData({
      step: 'role',
      pendingAccount: loginName || '',
      pendingRoles,
      availableRoles,
      role: first.key,
      roleLabel: first.label,
      agreementChecked: false
    });
  },

  handleAuthenticated(result) {
    const account = (result && result.account) || '';
    const roles = (result && Array.isArray(result.roles) && result.roles.length)
      ? result.roles
      : ['member'];
    try {
      wx.removeStorageSync('dc_accounts');
      wx.removeStorageSync('dc_wechat_bindings');
    } catch (e) {}
    this.showRolePicker(account, roles);
  },

  handleAuthError(error, fallback) {
    wx.hideLoading();
    wx.showToast({ title: (error && error.message) || fallback, icon: 'none' });
  },

  handlePasswordLoginError(error) {
    wx.hideLoading();
    if (error && error.code === 'ACCOUNT_NOT_FOUND') {
      wx.showModal({
        title: '账号未注册',
        content: '未找到该账号，是否现在注册？',
        success: (res) => {
          if (!res.confirm) return;
          this.setData({
            mode: 'register',
            regAccount: this.data.account,
            regPassword: '',
            regConfirm: ''
          });
        }
      });
      return;
    }
    if (error && error.code === 'INVALID_PASSWORD') {
      wx.showToast({ title: '账号密码错误', icon: 'none' });
      return;
    }
    wx.showToast({ title: (error && error.message) || '账号或密码错误', icon: 'none' });
  },

  currentSessionRoles() {
    const app = getApp();
    const gd = (app && app.globalData) || {};
    const roles = Array.isArray(gd.roles) ? gd.roles : [];
    const valid = roles.filter((role) => VALID_ROLES.indexOf(role) !== -1);
    return {
      account: gd.account || '',
      roles: Array.from(new Set(valid))
    };
  },

  openSwitchRolePicker() {
    const session = this.currentSessionRoles();
    if (session.account && session.roles.length) {
      this.showRolePicker(session.account, session.roles);
      return;
    }
    if (typeof data.getAccountSecurity !== 'function') {
      this.handleAuthError(null, '登录状态已失效，请重新登录');
      return;
    }
    wx.showLoading({ title: '加载中', mask: true });
    data
      .getAccountSecurity()
      .then((result) => {
        wx.hideLoading();
        this.handleAuthenticated(result);
      })
      .catch((error) => this.handleAuthError(error, '登录状态已失效，请重新登录'));
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
    wx.showLoading({ title: '登录中', mask: true });
    data
      .loginWithWechat()
      .then((result) => {
        wx.hideLoading();
        this.handleAuthenticated(result);
      })
      .catch((error) => {
        wx.hideLoading();
        if (error && error.code === 'WECHAT_NOT_BOUND') {
          this.setData({ step: 'auth', mode: 'wechatBind', loginType: 'password', password: '', code: '' });
          return;
        }
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
      .login(role)
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
      .login('shop')
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
    this.setData({
      step: 'auth',
      mode: 'login',
      agreementChecked: false,
      pendingAccount: '',
      pendingRoles: [],
      availableRoles: []
    });
  },

  // 切换到注册态
  goRegister() {
    this.cancelRecoveryEmailRequest();
    this.cancelRecoverySubmission();
    this.setData({ mode: 'register', regAccount: '', regPassword: '', regConfirm: '', agreementChecked: false });
  },

  // 注册态 → 返回登录态
  backToLogin() {
    this.cancelRecoveryEmailRequest();
    this.cancelRecoverySubmission();
    this.setData({ mode: 'login', agreementChecked: false });
  },

  openRecovery() {
    this.invalidateRecoveryEmailRequest();
    this.cancelRecoverySubmission();
    this.setData({
      mode: 'recover',
      recoveryType: 'wechat',
      recoveryAccount: (this.data.account || '').trim(),
      recoveryEmail: '',
      recoveryCode: '',
      recoveryPassword: '',
      recoveryConfirm: '',
      recoveryCounting: false,
      recoverySending: false,
      recoverySubmitting: false,
      recoveryCountdown: 60
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
    const wasSending = this.data.recoverySending;
    this.invalidateRecoveryEmailRequest();
    this.clearRecoveryCountdown();
    if (wasSending) wx.hideLoading();
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
    if (wasSubmitting) wx.hideLoading();
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
    const account = (this.data.recoveryAccount || '').trim();
    const email = (this.data.recoveryEmail || '').trim();
    if (!account) {
      return wx.showToast({ title: '请输入账号', icon: 'none' });
    }
    if (!EMAIL_RE.test(email)) {
      return wx.showToast({ title: '请输入正确的邮箱', icon: 'none' });
    }
    this.setData({ recoverySending: true });
    wx.showLoading({ title: '发送中', mask: true });
    const requestToken = this.invalidateRecoveryEmailRequest();
    data
      .sendEmailCode({ purpose: 'reset', account, email })
      .then((result) => {
        if (!this.isCurrentRecoveryEmailRequest(requestToken)) return;
        wx.hideLoading();
        this.setData({ recoverySending: false });
        wx.showToast({
          title: (result && result.msg) || '若信息匹配，验证码将发送至绑定邮箱',
          icon: 'none'
        });
        this.startRecoveryCountdown();
      })
      .catch((error) => {
        if (!this.isCurrentRecoveryEmailRequest(requestToken)) return;
        wx.hideLoading();
        this.setData({ recoverySending: false });
        wx.showToast({ title: (error && error.message) || '验证码发送失败', icon: 'none' });
      });
  },

  finishRecovery(result) {
    this.cancelRecoverySubmission();
    this.cancelRecoveryEmailRequest();
    this.setData({
      mode: 'login',
      loginType: 'password',
      account: (result && result.account) || '',
      password: '',
      recoveryCode: '',
      recoveryPassword: '',
      recoveryConfirm: '',
      recoveryCounting: false,
      recoverySending: false,
      recoverySubmitting: false,
      recoveryCountdown: 60
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
      wx.showLoading({ title: '重置中', mask: true });
      data
        .resetPasswordByWechat({ password })
        .then((result) => {
          if (!this.isRecoverySubmissionCurrent(requestToken, 'wechat')) return;
          this.finishRecovery(result);
        })
        .catch((error) => {
          if (!this.isRecoverySubmissionCurrent(requestToken, 'wechat')) return;
          this.cancelRecoverySubmission();
          if (error && error.code === 'WECHAT_NOT_BOUND') {
            this.setData({ recoveryType: 'email' });
            wx.showToast({ title: '当前微信未绑定账号，请使用已绑定邮箱找回', icon: 'none' });
            return;
          }
          wx.showToast({ title: (error && error.message) || '密码重置失败', icon: 'none' });
        });
      return;
    }

    const account = (this.data.recoveryAccount || '').trim();
    const email = (this.data.recoveryEmail || '').trim();
    const code = (this.data.recoveryCode || '').trim();
    if (!account) {
      return wx.showToast({ title: '请输入账号', icon: 'none' });
    }
    if (!EMAIL_RE.test(email)) {
      return wx.showToast({ title: '请输入正确的邮箱', icon: 'none' });
    }
    if (!code) {
      return wx.showToast({ title: '请输入验证码', icon: 'none' });
    }
    const requestToken = this.beginRecoverySubmission('email');
    if (requestToken === null) return;
    wx.showLoading({ title: '重置中', mask: true });
    data
      .resetPasswordByEmail({ account, email, code, password })
      .then((result) => {
        if (!this.isRecoverySubmissionCurrent(requestToken, 'email')) return;
        this.finishRecovery(result);
      })
      .catch((error) => {
        if (!this.isRecoverySubmissionCurrent(requestToken, 'email')) return;
        this.cancelRecoverySubmission();
        wx.showToast({
          title: error && error.code === 'EMAIL_NOT_BOUND'
            ? '该邮箱未绑定账号，请联系管理员'
            : ((error && error.message) || '密码重置失败'),
          icon: 'none'
        });
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
    wx.showLoading({ title: '注册中', mask: true });
    data
      .registerAccount({ account, password: regPassword })
      .then((result) => {
        wx.hideLoading();
        this.handleAuthenticated(result);
      })
      .catch((error) => this.handleAuthError(error, '注册失败，请重试'));
  },

  switchType(e) {
    this.setData({ loginType: e.currentTarget.dataset.type });
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  startCodeCountdown() {
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
    const phone = (this.data.phone || '').trim();
    if (!PHONE_RE.test(phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    this.setData({ sendingCode: true });
    wx.showLoading({ title: '发送中', mask: true });
    data
      .sendSmsCode(phone)
      .then(() => {
        wx.hideLoading();
        this.setData({ sendingCode: false });
        wx.showToast({ title: '验证码已发送', icon: 'none' });
        this.startCodeCountdown();
      })
      .catch((e) => {
        wx.hideLoading();
        this.setData({ sendingCode: false });
        wx.showToast({ title: (e && e.message) || '验证码发送失败', icon: 'none' });
      });
  },

  submit() {
    if (!this.ensureAgreementChecked()) return;
    const { loginType } = this.data;
    if (loginType === 'password') {
      const account = (this.data.account || '').trim();
      if (!account) {
        return wx.showToast({ title: '请输入账号', icon: 'none' });
      }
      if (!this.data.password) {
        return wx.showToast({ title: '请输入密码', icon: 'none' });
      }
      if (adminAuth.isAdminAccount(account)) {
        this.doAdminLogin(account, this.data.password);
        return;
      }
      wx.showLoading({ title: '登录中', mask: true });
      data
        .loginWithPassword({ account, password: this.data.password })
        .then((result) => {
          wx.hideLoading();
          this.handleAuthenticated(result);
        })
        .catch((error) => this.handlePasswordLoginError(error));
      return;
    } else {
      const phone = (this.data.phone || '').trim();
      if (!PHONE_RE.test(phone)) {
        return wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      }
      if (!(this.data.code || '').trim()) {
        return wx.showToast({ title: '请输入验证码', icon: 'none' });
      }
      wx.showLoading({ title: '校验中', mask: true });
      data
        .verifySmsCode(phone, (this.data.code || '').trim())
        .then((result) => {
          wx.hideLoading();
          this.handleAuthenticated(result);
        })
        .catch((e) => {
          wx.hideLoading();
          wx.showToast({ title: (e && e.message) || '验证码错误或已过期', icon: 'none' });
        });
      return;
    }
  },

  onUnload() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._cloudTimer) {
      clearTimeout(this._cloudTimer);
      this._cloudTimer = null;
    }
    this.cancelRecoverySubmission();
    this.cancelRecoveryEmailRequest();
    this._disposed = true;
  }
});
