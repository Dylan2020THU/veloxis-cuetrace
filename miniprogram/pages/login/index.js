const data = require('../../services/data');
const mock = require('../../utils/mock');

// 三种登录身份，顺序即页面从上至下的展示顺序
const ROLES = [
  { key: 'member', label: '球员', desc: '记录训练 · 追踪成长', img: '/images/login/login-member.jpg' },
  { key: 'coach', label: '教练', desc: '管理学员 · 排课带教', img: '/images/login/login-coach.jpg' },
  { key: 'shop', label: '店主', desc: '门店经营 · 数据看板', img: '/images/login/login-shop.jpg' }
];

const PHONE_RE = /^1\d{10}$/;
const ACCOUNT_RE = /^[A-Za-z][A-Za-z0-9_]{3,19}$/;
const ACCOUNT_RULE_TEXT = '账号需 4-20 位，字母开头，仅支持字母、数字、下划线';

// 本地注册账号存储（演示阶段）
const ACCOUNTS_KEY = 'dc_accounts';
const WECHAT_BINDINGS_KEY = 'dc_wechat_bindings';

// 各身份登录后的落地首页
const HOME_BY_ROLE = {
  member: '/pages/checkin/index',
  coach: '/pages/checkin/index',
  shop: '/pages/shop/hall-status/index'
};

// 属于 tabBar 的落地页需用 switchTab，其余用 reLaunch
const TAB_HOMES = ['/pages/checkin/index', '/pages/coach/members/index', '/pages/shop/hall-status/index'];

Page({
  behaviors: [require('../../utils/themeBehavior')],

  data: {
    roles: ROLES,
    cloudReady: false,
    role: 'member',
    roleLabel: '球员',
    // 登录步骤：1 = 选择身份，2 = 填写账号
    step: 1,
    // 第二步的模式：login = 登录，wechatBind = 微信绑定，register = 注册
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
    regConfirm: ''
  },

  onLoad() {
    this.syncCloudReady();
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

  selectRole(e) {
    const role = e.currentTarget.dataset.role;
    const found = ROLES.find((r) => r.key === role);
    this.setData({ role, roleLabel: found ? found.label : '' });
  },

  // 第一步 → 第二步：所有身份都先进入账号/手机号登录
  goNext() {
    this.setData({ step: 2, agreementChecked: false });
  },

  wechatLogin() {
    this.setData({ mode: 'wechatBind', loginType: 'password', password: '', code: '', agreementChecked: false });
  },

  doLogin(role, loginName) {
    // 店主需先通过营业执照资质审核，单独走带状态网关的登录流程
    if (role === 'shop') {
      this.doShopLogin(loginName);
      return;
    }
    wx.showLoading({ title: '登录中', mask: true });
    data
      .login(role)
      .then(() => {
        if (loginName) data.rememberLoginNickname(loginName, role);
        return data.getUserProfile();
      })
      .then(() => data.markFirstLogin(role))
      .then(() => {
        wx.hideLoading();
        this.goHome(role);
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: '登录失败，请重试', icon: 'none' });
      });
  },

  // 店主登录网关：登录后查资质状态。approved → 进店主端；其余（未申请/待审核/已驳回）→ 资质核验页。
  doShopLogin(loginName) {
    wx.showLoading({ title: '登录中', mask: true });
    data
      .login('shop')
      .then(() => {
        if (loginName) data.rememberLoginNickname(loginName, 'shop');
        return data.getUserProfile();
      })
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

  // 第二步 → 第一步（重选身份）
  goPrev() {
    this.setData({ step: 1, mode: 'login', agreementChecked: false });
  },

  // 切换到注册态
  goRegister() {
    this.setData({ mode: 'register', regAccount: '', regPassword: '', regConfirm: '', agreementChecked: false });
  },

  // 注册态 → 返回登录态
  backToLogin() {
    this.setData({ mode: 'login', agreementChecked: false });
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

  readRegisteredAccounts() {
    try {
      const accounts = wx.getStorageSync(ACCOUNTS_KEY) || [];
      return Array.isArray(accounts) ? accounts : [];
    } catch (e) {
      return [];
    }
  },

  findRegisteredAccount(account, role) {
    const key = (account || '').trim();
    if (!key) return null;
    return this.readRegisteredAccounts().find((a) => a && a.account === key && a.role === role) || null;
  },

  isValidRegisterAccount(account) {
    return ACCOUNT_RE.test(account);
  },

  saveWechatBinding(account, role) {
    const key = (account || '').trim();
    if (!key) return;
    const now = Date.now();
    try {
      const bindings = wx.getStorageSync(WECHAT_BINDINGS_KEY) || [];
      const list = Array.isArray(bindings) ? bindings : [];
      const idx = list.findIndex((item) => item && item.account === key && item.role === role);
      const record = { account: key, role, boundAt: now };
      if (idx >= 0) list[idx] = Object.assign({}, list[idx], record);
      else list.push(record);
      wx.setStorageSync(WECHAT_BINDINGS_KEY, list);
    } catch (e) {}

    const accounts = this.readRegisteredAccounts();
    const accountIdx = accounts.findIndex((item) => item && item.account === key && item.role === role);
    if (accountIdx >= 0) {
      accounts[accountIdx] = Object.assign({}, accounts[accountIdx], {
        wechatBound: true,
        wechatBoundAt: now
      });
      try {
        wx.setStorageSync(ACCOUNTS_KEY, accounts);
      } catch (e) {}
    }
  },

  // 注册（演示阶段：本地校验并保存账号，成功后返回登录态）
  register() {
    if (!this.ensureAgreementChecked()) return;
    const account = (this.data.regAccount || '').trim();
    const { regPassword, regConfirm, role } = this.data;
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

    const accounts = this.readRegisteredAccounts();
    if (accounts.some((a) => a.account === account && a.role === role)) {
      return wx.showToast({ title: '该账号已注册', icon: 'none' });
    }
    accounts.push({ role, account, password: regPassword, createdAt: Date.now() });
    try {
      wx.setStorageSync(ACCOUNTS_KEY, accounts);
    } catch (e) {}

    wx.showToast({ title: '注册成功，请登录', icon: 'none' });
    // 返回登录态并回填账号，方便直接登录
    this.setData({
      mode: 'login',
      loginType: 'password',
      account,
      password: '',
      regAccount: '',
      regPassword: '',
      regConfirm: ''
    });
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
    if (!this.findRegisteredAccount(phone, this.data.role)) {
      wx.showToast({ title: '手机号未注册，请先注册', icon: 'none' });
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
    const { loginType, role } = this.data;
    if (loginType === 'password') {
      const account = (this.data.account || '').trim();
      if (!account) {
        return wx.showToast({ title: '请输入账号', icon: 'none' });
      }
      if (!this.data.password) {
        return wx.showToast({ title: '请输入密码', icon: 'none' });
      }
      const registered = this.findRegisteredAccount(account, role);
      if (!registered) {
        return wx.showToast({ title: '账号未注册，请先注册', icon: 'none' });
      }
      if (registered.password !== this.data.password) {
        return wx.showToast({ title: '密码错误', icon: 'none' });
      }
      this.doLogin(role, account);
      return;
    } else {
      const phone = (this.data.phone || '').trim();
      if (!PHONE_RE.test(phone)) {
        return wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      }
      if (!(this.data.code || '').trim()) {
        return wx.showToast({ title: '请输入验证码', icon: 'none' });
      }
      if (!this.findRegisteredAccount(phone, role)) {
        return wx.showToast({ title: '手机号未注册，请先注册', icon: 'none' });
      }
      wx.showLoading({ title: '校验中', mask: true });
      data
        .verifySmsCode(phone, (this.data.code || '').trim())
        .then(() => {
          wx.hideLoading();
          this.doLogin(role, phone);
        })
        .catch((e) => {
          wx.hideLoading();
          wx.showToast({ title: (e && e.message) || '验证码错误或已过期', icon: 'none' });
        });
      return;
    }
  },

  bindWechat() {
    if (!this.ensureAgreementChecked()) return;
    const { loginType, role } = this.data;
    if (loginType === 'password') {
      const account = (this.data.account || '').trim();
      if (!account) {
        return wx.showToast({ title: '请输入账号', icon: 'none' });
      }
      if (!this.data.password) {
        return wx.showToast({ title: '请输入密码', icon: 'none' });
      }
      const registered = this.findRegisteredAccount(account, role);
      if (!registered) {
        return wx.showToast({ title: '账号未注册，请先注册', icon: 'none' });
      }
      if (registered.password !== this.data.password) {
        return wx.showToast({ title: '密码错误', icon: 'none' });
      }
      this.saveWechatBinding(account, role);
      this.doLogin(role, account);
      return;
    }

    const phone = (this.data.phone || '').trim();
    if (!PHONE_RE.test(phone)) {
      return wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
    }
    if (!(this.data.code || '').trim()) {
      return wx.showToast({ title: '请输入验证码', icon: 'none' });
    }
    if (!this.findRegisteredAccount(phone, role)) {
      return wx.showToast({ title: '手机号未注册，请先注册', icon: 'none' });
    }
    wx.showLoading({ title: '校验中', mask: true });
    data
      .verifySmsCode(phone, (this.data.code || '').trim())
      .then(() => {
        wx.hideLoading();
        this.saveWechatBinding(phone, role);
        this.doLogin(role, phone);
      })
      .catch((e) => {
        wx.hideLoading();
        wx.showToast({ title: (e && e.message) || '验证码错误或已过期', icon: 'none' });
      });
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
  }
});
