const data = require('../../../services/data');

const PHONE_RE = /^1\d{10}$/;

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
    emailText: '未绑定',
    wechatText: '未绑定'
  },

  onLoad() {
    this._disposed = false;
    this._active = true;
  },

  onShow() {
    this._active = true;
    this.refresh();
  },

  refresh() {
    const requestToken = this.invalidateRefreshRequest();
    data.getAccountSecurity()
      .then((status) => {
        if (!this.isCurrentRefreshRequest(requestToken)) return;
        this.setData({
          accountText: status.account || '未设置',
          passwordText: status.passwordSet ? '已设置' : '未设置',
          phoneText: maskPhone(status.phone) || '未绑定',
          emailText: status.emailBound && status.emailMasked ? status.emailMasked : '未绑定',
          wechatText: status.wechatBound ? '已绑定' : '未绑定'
        });
      })
      .catch(() => {
        if (!this.isCurrentRefreshRequest(requestToken)) return;
        this.setData({
          accountText: '未登录',
          passwordText: '未设置',
          phoneText: '未绑定',
          emailText: '未绑定',
          wechatText: '未绑定'
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
  },

  onHide() {
    this.deactivate();
  },

  onUnload() {
    this._disposed = true;
    this.deactivate();
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

  onEmail() {
    wx.navigateTo({ url: '/pages/settings/email-binding/index' });
  },

  onWechat() {
    wx.showToast({ title: '请在登录页使用微信登录完成绑定', icon: 'none' });
  }
});
