const data = require('../../../../services/data');
const { isAdmin } = require('../../../../utils/admin');

const TABS = [
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已驳回' }
];

Page({
  behaviors: [require('../../../../utils/themeBehavior')],

  data: {
    authorized: true,
    tabs: TABS,
    tab: 'pending',
    loading: true,
    list: []
  },

  onLoad() {
    const app = getApp();
    const openid = (app && app.globalData && app.globalData.openid) || '';
    if (!isAdmin(openid)) {
      this.setData({ authorized: false, loading: false });
      return;
    }
    this.load();
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab }, () => this.load());
  },

  load() {
    this.setData({ loading: true });
    data
      .getPendingShopApplications(this.data.tab)
      .then((list) => this.setData({ loading: false, list: list || [] }))
      .catch((e) => {
        // 服务端白名单未包含当前 openid：明确提示无权限，避免误显示「暂无申请」
        if (e && e.code === 'FORBIDDEN') {
          this.setData({ loading: false, authorized: false, list: [] });
        } else {
          this.setData({ loading: false, list: [] });
        }
      });
  },

  // 预览营业执照大图（云存储 fileID 需先换临时链接）
  previewLicense(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    if (url.indexOf('cloud://') === 0 && wx.cloud) {
      wx.cloud.getTempFileURL({ fileList: [url] }).then((res) => {
        const u = res.fileList && res.fileList[0] && res.fileList[0].tempFileURL;
        if (u) wx.previewImage({ urls: [u] });
      });
    } else {
      wx.previewImage({ urls: [url] });
    }
  },

  approve(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '通过审核',
      content: '确认该店主资质核验通过？',
      confirmText: '通过',
      success: (res) => {
        if (res.confirm) this._review(id, true, '');
      }
    });
  },

  reject(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '驳回申请',
      editable: true,
      placeholderText: '请填写驳回原因（店主可见）',
      confirmText: '驳回',
      success: (res) => {
        if (res.confirm) this._review(id, false, (res.content || '').trim() || '资料未通过核验');
      }
    });
  },

  _review(applicationId, approve, reason) {
    wx.showLoading({ title: '提交中', mask: true });
    data
      .reviewShopApplication({ applicationId, approve, reason })
      .then((r) => {
        wx.hideLoading();
        if (r && r.ok === false) {
          return wx.showToast({ title: r.msg || '操作失败', icon: 'none' });
        }
        wx.showToast({ title: approve ? '已通过' : '已驳回', icon: 'success' });
        this.load();
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: '操作失败，请重试', icon: 'none' });
      });
  }
});
