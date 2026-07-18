const data = require('../../../services/data');

Page({
  behaviors: [require('../../../utils/themeBehavior')],

  data: {
    avatar: '',
    nickname: '',
    intro: '',
    stores: [],
    selectedStoreId: '',
    selectedStoreName: '',
    selectedStoreIndex: 0,
    status: 'none',
    reason: '',
    submitting: false,
    loading: true
  },

  onLoad() {
    this.loadInitial();
  },

  loadInitial() {
    Promise.all([
      data.getUserProfile().catch(() => null),
      data.getStores().catch(() => []),
      this.loadStatus()
    ]).then(([profile, stores, binding]) => {
      const application = (binding && binding.application) || null;
      const link = (binding && binding.link) || null;
      const selectedStoreId = link ? link.storeId : (application ? application.storeId : '');
      const selectedStoreName = link ? link.storeName : (application ? application.storeName : '');
      const list = (stores || []).filter((store) => store && store._openid);
      const selectedIdx = list.findIndex((store) => store._id === selectedStoreId);
      this.setData({
        avatar: (application && application.coachAvatar) || (profile && profile.avatar) || '',
        nickname: (application && application.coachNickname) || (profile && profile.nickname) || '',
        intro: (application && application.intro) || '',
        stores: list,
        selectedStoreId,
        selectedStoreName,
        selectedStoreIndex: selectedIdx >= 0 ? selectedIdx : 0,
        status: (binding && binding.status) || 'none',
        reason: application ? (application.reason || '') : '',
        loading: false
      });
    }).catch(() => this.setData({ loading: false }));
  },

  loadStatus() {
    return data.getMyCoachShopBindingStatus().catch(() => ({ status: 'none' }));
  },

  chooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const tempPath = res.tempFiles[0].tempFilePath;
        wx.showLoading({ title: '上传中' });
        data
          .uploadImage(tempPath)
          .then((url) => this.setData({ avatar: url }))
          .finally(() => wx.hideLoading());
      }
    });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  onStoreChange(e) {
    const idx = Number(e.detail.value);
    const store = this.data.stores[idx];
    if (!store) return;
    this.setData({
      selectedStoreIndex: idx,
      selectedStoreId: store._id || '',
      selectedStoreName: store.name || ''
    });
  },

  submitApplication() {
    if (this.data.submitting || this.data.status === 'pending' || this.data.status === 'approved') return;
    const nickname = (this.data.nickname || '').trim();
    const intro = (this.data.intro || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请填写教练昵称', icon: 'none' });
      return;
    }
    if (!this.data.selectedStoreId) {
      wx.showToast({ title: '请选择申请球厅', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    data.applyCoachShopBinding({
        storeId: this.data.selectedStoreId,
        coachNickname: nickname,
        coachAvatar: this.data.avatar,
        intro
      })
      .then((r) => {
        if (r && r.ok === false) {
          wx.showToast({ title: r.msg || '提交失败', icon: 'none' });
          return;
        }
        wx.showToast({ title: '已提交申请', icon: 'success' });
        this.loadInitial();
      })
      .catch(() => wx.showToast({ title: '提交失败', icon: 'none' }))
      .finally(() => this.setData({ submitting: false }));
  },

  goCoachProfile() {
    wx.navigateTo({ url: '/pages/coach/profile/index' });
  }
});
