const data = require('../../../services/data');
const { formatDuration } = require('../../../utils/color');

// 简单确定性 hash：演示阶段稳定生成会员的「在线」状态
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    members: [],
    loading: true,
    totalDays: 0,
    totalHoursText: '0',
    stores: [],
    currentStoreId: '',
    currentStoreName: ''
  },

  onLoad() {
    this.load();
  },

  load() {
    this.setData({ loading: true });
    Promise.all([data.getShopStores(), data.getShopProfile()]).then(([stores, shop]) => {
      const currentStoreId = (shop && shop.storeId) ? shop.storeId : (stores.length ? stores[0]._id : '');
      const currentStore = stores.find((s) => s._id === currentStoreId) || {};
      this.setData({ stores, currentStoreId, currentStoreName: currentStore.name || '' });
      return data.getShopMembers(currentStoreId);
    }).then((list) => {
        let totalDays = 0;
        let totalMinutes = 0;
        const members = list.map((m) => {
          totalDays += m.checkinDays || 0;
          totalMinutes += m.totalMinutes || 0;
          return Object.assign({}, m, {
            durationText: formatDuration(m.totalMinutes),
            hoursText: (m.totalMinutes / 60).toFixed(1),
            // TODO: online（是否在线）应由真实业务数据提供；演示阶段用 openid 确定性派生
            online: hashCode(m.openid || '') % 2 === 0
          });
        });
        this.setData({
          members,
          loading: false,
          totalDays,
          totalHoursText: (totalMinutes / 60).toFixed(1)
        });
      })
      .catch((err) => {
        console.error('加载会员统计失败', err);
        this.setData({ loading: false });
      });
  },

  onShow() {
    this.load();
  },

  onStoreChange(e) {
    const idx = e.detail.value;
    const stores = this.data.stores;
    const store = stores[idx];
    this.setData({ currentStoreId: store._id, currentStoreName: store.name });
    this.load();
  },

  // 点击会员名字，跳转至该会员的训练打卡页面
  viewMember(e) {
    const { openid, nickname } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/coach/member/index?openid=${encodeURIComponent(
        openid
      )}&nickname=${encodeURIComponent(nickname)}`
    });
  }
});
