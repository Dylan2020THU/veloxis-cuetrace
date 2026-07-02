const data = require('../../../services/data');

const HOME_SHOP = '/pages/shop/hall-status/index';
const PHONE_RE = /^1\d{10}$/;

Page({
  behaviors: [require('../../../utils/themeBehavior')],

  data: {
    loading: true,
    status: 'none', // none | pending | rejected（approved 会直接跳店主主页）
    reason: '',
    // 表单：营业执照 + 店主联系方式（电话必填，其余选填）
    ownerPhone: '',
    ownerWechat: '',
    ownerQQ: '',
    ownerEmail: '',
    licenseFileID: '',
    submitting: false,
    // 当前用户是否为系统管理员（仅其可见"前往审核后台"快捷入口）
    isAdmin: false
  },

  onLoad() {
    this.refreshAdminStatus();
    this.refresh();
  },

  refreshAdminStatus() {
    data
      .getAdminStatus()
      .then((r) => this.setData({ isAdmin: !!(r && r.isAdmin) }))
      .catch(() => this.setData({ isAdmin: false }));
  },

  // 拉取权威状态：approved 直接进店主端；其余渲染对应态（驳回时回填上次资料）
  refresh() {
    this.setData({ loading: true });
    data
      .getShopApplicationStatus()
      .then((res) => {
        const status = (res && res.status) || 'none';
        if (status === 'approved') {
          wx.reLaunch({ url: HOME_SHOP });
          return;
        }
        const app = (res && res.application) || {};
        this.setData({
          loading: false,
          status,
          reason: app.reason || '',
          ownerPhone: app.ownerPhone || '',
          ownerWechat: app.ownerWechat || '',
          ownerQQ: app.ownerQQ || '',
          ownerEmail: app.ownerEmail || '',
          licenseFileID: app.licenseFileID || ''
        });
      })
      .catch(() => this.setData({ loading: false, status: 'none' }));
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  chooseLicense() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const p = res.tempFiles[0].tempFilePath;
        wx.showLoading({ title: '上传中', mask: true });
        data
          .uploadFile(p, 'license')
          .then((id) => this.setData({ licenseFileID: id }))
          .catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
          .finally(() => wx.hideLoading());
      }
    });
  },

  submit() {
    if (this.data.submitting) return;
    const ownerPhone = (this.data.ownerPhone || '').trim();
    const ownerWechat = (this.data.ownerWechat || '').trim();
    const ownerQQ = (this.data.ownerQQ || '').trim();
    const ownerEmail = (this.data.ownerEmail || '').trim();
    const { licenseFileID } = this.data;

    if (!licenseFileID) return wx.showToast({ title: '请上传营业执照', icon: 'none' });
    if (!PHONE_RE.test(ownerPhone)) return wx.showToast({ title: '请输入正确的店主联系电话（11位手机号）', icon: 'none' });

    this.setData({ submitting: true });
    data
      .submitShopApplication({ ownerPhone, ownerWechat, ownerQQ, ownerEmail, licenseFileID })
      .then((r) => {
        this.setData({ submitting: false });
        if (r && r.ok === false) {
          return wx.showToast({ title: r.msg || '提交失败', icon: 'none' });
        }
        wx.showToast({ title: '已提交，等待审核', icon: 'success' });
        this.setData({ status: 'pending', reason: '' });
      })
      .catch(() => {
        this.setData({ submitting: false });
        wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      });
  },

  // 驳回态 → 重新填写（回到表单）
  reapply() {
    this.setData({ status: 'rejected' });
  },

  // 管理员快捷入口：直达资质审核后台（仅管理员 openid 可见；方便审核自己/他人的申请）
  goReview() {
    wx.navigateTo({ url: '/pages/shop/admin/review/index' });
  },

  // 退出申请流程，回到登录页
  backToLogin() {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.openid = '';
      app.globalData.role = '';
    }
    try {
      wx.removeStorageSync('dc_role');
    } catch (e) {}
    wx.reLaunch({ url: '/pages/login/index' });
  }
});
