const data = require('../../services/data');
const mock = require('../../utils/mock');

// 三种登录身份，顺序即页面从上至下的展示顺序
const ROLES = [
  { key: 'member', label: '球员', desc: '记录训练 · 追踪成长', img: '/images/login/login-member.png' },
  { key: 'coach', label: '教练', desc: '管理学员 · 排课带教', img: '/images/login/login-coach.png' },
  { key: 'shop', label: '店主', desc: '门店经营 · 数据看板', img: '/images/login/login-shop.png' }
];

const PHONE_RE = /^1\d{10}$/;

// 本地注册账号存储（演示阶段）
const ACCOUNTS_KEY = 'dc_accounts';

// 各身份登录后的落地首页
const HOME_BY_ROLE = {
  member: '/pages/checkin/index',
  coach: '/pages/checkin/index',
  shop: '/pages/shop/dashboard/index'
};

// 属于 tabBar 的落地页需用 switchTab，其余用 reLaunch
const TAB_HOMES = ['/pages/checkin/index', '/pages/coach/members/index'];

Page({
  behaviors: [require('../../utils/themeBehavior')],

  data: {
    roles: ROLES,
    cloudReady: false,
    role: 'member',
    roleLabel: '球员',
    // 登录步骤：1 = 选择身份，2 = 填写账号
    step: 1,
    // 第二步的模式：login = 登录，register = 注册
    mode: 'login',
    // 登录方式：password = 账号密码，sms = 手机验证码
    loginType: 'password',
    account: '',
    password: '',
    phone: '',
    code: '',
    counting: false,
    countdown: 60,
    // 注册表单
    regAccount: '',
    regPassword: '',
    regConfirm: ''
  },

  onLoad() {
    const app = getApp();
    const cloudReady = !!(app && app.globalData && app.globalData.cloudReady);
    this.setData({ cloudReady });
    const ready = (app && app.sessionReady) || Promise.resolve();
    ready.then(() => {
      if (!cloudReady || !app.globalData.openid) return;
      let role = 'member';
      try {
        role = wx.getStorageSync('dc_role') || app.globalData.role || 'member';
      } catch (e) {}
      this.goHome(role);
    });
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

  // 第一步 → 第二步（云端模式直接微信登录，跳过演示账号表单）
  goNext() {
    if (this.data.cloudReady) {
      this.doLogin(this.data.role);
      return;
    }
    this.setData({ step: 2 });
  },

  doLogin(role) {
    wx.showLoading({ title: '登录中', mask: true });
    data
      .login(role)
      .then(() => data.getUserProfile())
      .then(() => {
        wx.hideLoading();
        this.goHome(role);
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: '登录失败，请重试', icon: 'none' });
      });
  },

  // 第二步 → 第一步（重选身份）
  goPrev() {
    this.setData({ step: 1, mode: 'login' });
  },

  // 切换到注册态
  goRegister() {
    this.setData({ mode: 'register', regAccount: '', regPassword: '', regConfirm: '' });
  },

  // 注册态 → 返回登录态
  backToLogin() {
    this.setData({ mode: 'login' });
  },

  // 注册（演示阶段：本地校验并保存账号，成功后返回登录态）
  register() {
    const account = (this.data.regAccount || '').trim();
    const { regPassword, regConfirm, role } = this.data;
    if (!account) {
      return wx.showToast({ title: '请输入账号', icon: 'none' });
    }
    if (!regPassword || regPassword.length < 6) {
      return wx.showToast({ title: '密码至少 6 位', icon: 'none' });
    }
    if (regPassword !== regConfirm) {
      return wx.showToast({ title: '两次密码不一致', icon: 'none' });
    }

    let accounts = [];
    try {
      accounts = wx.getStorageSync(ACCOUNTS_KEY) || [];
    } catch (e) {
      accounts = [];
    }
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

  // 发送验证码（演示：本地校验 + 60s 倒计时）
  sendCode() {
    if (this.data.counting) return;
    const phone = (this.data.phone || '').trim();
    if (!PHONE_RE.test(phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    this.setData({ counting: true, countdown: 60 });
    wx.showToast({ title: '验证码已发送', icon: 'none' });
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

  submit() {
    const { loginType, role, cloudReady } = this.data;
    if (!cloudReady) {
      if (loginType === 'password') {
        if (!(this.data.account || '').trim()) {
          return wx.showToast({ title: '请输入账号', icon: 'none' });
        }
        if (!this.data.password) {
          return wx.showToast({ title: '请输入密码', icon: 'none' });
        }
      } else {
        if (!PHONE_RE.test((this.data.phone || '').trim())) {
          return wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
        }
        if (!(this.data.code || '').trim()) {
          return wx.showToast({ title: '请输入验证码', icon: 'none' });
        }
      }
    }
    this.doLogin(role);
  },

  onUnload() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
});
