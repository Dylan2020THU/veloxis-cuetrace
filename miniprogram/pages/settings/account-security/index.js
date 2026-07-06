const data = require('../../../services/data');
const mock = require('../../../utils/mock');

const ACCOUNTS_KEY = 'dc_accounts';
const WECHAT_BINDINGS_KEY = 'dc_wechat_bindings';
const LOGIN_DEFAULT_NICKNAME_KEY = 'dc_login_default_nickname';
const PHONE_RE = /^1\d{10}$/;

function readArray(key) {
  try {
    const value = wx.getStorageSync(key) || [];
    return Array.isArray(value) ? value : [];
  } catch (e) {
    return [];
  }
}

function readLoginName(role) {
  try {
    return wx.getStorageSync(`${LOGIN_DEFAULT_NICKNAME_KEY}_${role || 'member'}`) || '';
  } catch (e) {
    return '';
  }
}

function maskPhone(phone) {
  const raw = String(phone || '').trim();
  if (!PHONE_RE.test(raw)) return '';
  return `${raw.slice(0, 3)}****${raw.slice(7)}`;
}

Page({
  behaviors: [require('../../../utils/themeBehavior')],

  data: {
    accountText: '未设置',
    passwordText: '未设置',
    qrText: '查看',
    phoneText: '未绑定',
    wechatText: '未绑定'
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const role = mock.getRole();
    const app = getApp();
    const profile = (app.globalData && app.globalData.userProfile) || {};
    const loginName = readLoginName(role);
    const accounts = readArray(ACCOUNTS_KEY);
    const matched = accounts.find((item) => item && item.role === role && item.account === loginName)
      || accounts.find((item) => item && item.role === role);
    const accountName = loginName || (matched && matched.account) || profile.nickname || '';
    const phone = profile.phone || (PHONE_RE.test(accountName) ? accountName : '');
    const bindings = readArray(WECHAT_BINDINGS_KEY);
    const hasWechatBinding = !!(
      (matched && matched.wechatBound)
      || bindings.some((item) => item && item.role === role && item.account === accountName)
    );

    this.setData({
      accountText: accountName || '未设置',
      passwordText: matched && matched.password ? '已设置' : '未设置',
      phoneText: maskPhone(phone) || '未绑定',
      wechatText: hasWechatBinding ? '已绑定' : '未绑定'
    });

    data.getUserProfile().then((user) => {
      if (!user) return;
      const nextPhone = user.phone || phone;
      this.setData({
        phoneText: maskPhone(nextPhone) || '未绑定'
      });
    }).catch(() => {});
  },

  copyAccount() {
    if (!this.data.accountText || this.data.accountText === '未设置') return;
    wx.setClipboardData({
      data: this.data.accountText,
      success: () => wx.showToast({ title: '账号已复制', icon: 'success' })
    });
  },

  onPassword() {
    wx.showToast({ title: '暂不支持修改密码', icon: 'none' });
  },

  goMyQrcode() {
    wx.navigateTo({ url: '/pages/profile/qrcode/index' });
  },

  onPhone() {
    wx.showToast({ title: '请在登录页使用手机号完成绑定', icon: 'none' });
  },

  onWechat() {
    wx.showToast({ title: '请在登录页使用微信登录完成绑定', icon: 'none' });
  }
});
