const data = require('../../services/data');
const mock = require('../../utils/mock');

// 三种登录身份，顺序即页面从上至下的展示顺序
const ROLES = [
  { key: 'member', label: '球员', desc: '记录训练 · 追踪成长', img: '/images/login/login-member.png' },
  { key: 'coach', label: '教练', desc: '管理学员 · 排课带教', img: '/images/login/login-coach.png' },
  { key: 'shop', label: '店主', desc: '门店经营 · 数据看板', img: '/images/login/login-shop.png' }
];

const PHONE_RE = /^1\d{10}$/;

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
    role: 'member',
    roleLabel: '球员',
    // 登录步骤：1 = 选择身份，2 = 填写账号
    step: 1,
    // 登录方式：password = 账号密码，sms = 手机验证码
    loginType: 'password',
    account: '',
    password: '',
    phone: '',
    code: '',
    counting: false,
    countdown: 60
  },

  selectRole(e) {
    const role = e.currentTarget.dataset.role;
    const found = ROLES.find((r) => r.key === role);
    this.setData({ role, roleLabel: found ? found.label : '' });
  },

  // 第一步 → 第二步
  goNext() {
    this.setData({ step: 2 });
  },

  // 第二步 → 第一步（重选身份）
  goPrev() {
    this.setData({ step: 1 });
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
    const { loginType, role } = this.data;
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

    wx.showLoading({ title: '登录中', mask: true });
    // 演示阶段直接以所选身份登录；接入真实账号体系时在此调用云函数校验
    data.setRole(role).then(() => {
      const app = getApp();
      if (app && app.globalData) app.globalData.openid = mock.MOCK_OPENID;
      wx.hideLoading();
      const url = HOME_BY_ROLE[role] || HOME_BY_ROLE.member;
      if (TAB_HOMES.indexOf(url) !== -1) {
        wx.switchTab({ url });
      } else {
        wx.reLaunch({ url });
      }
    });
  },

  onUnload() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
});
