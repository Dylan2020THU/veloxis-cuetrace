const data = require('../../../services/data');

// 与约球桌一致的"在店内"半径（km）。生产建议 0.2~0.5。
const CHECKIN_RADIUS_KM = 1;

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    longitude: 116.404,
    latitude: 39.908,
    scale: 12,
    markers: [],
    stores: [],
    showLoc: true,
    selected: null
  },

  onLoad() {
    this._load();
  },

  _load() {
    Promise.all([data.getUserLatLng(), data.getBookableTables()]).then(([loc, stores]) => {
      this._userLoc = loc;
      const first = stores[0] || {};
      const center = loc || { lat: first.lat || 39.908, lng: first.lng || 116.404 };
      const withMeta = stores.map((s) => {
        const prices = (s.tableTypes || []).map((tt) => tt.pricePerHour).filter((p) => p > 0);
        const minPricePerHour = prices.length ? Math.min.apply(null, prices) : 0;
        const distance = loc ? data.distanceKm(loc.lat, loc.lng, s.lat, s.lng) : null;
        const distanceText = distance == null ? ''
          : (distance < 1 ? Math.round(distance * 1000) + 'm' : distance + 'km');
        return Object.assign({}, s, { minPricePerHour, distance, distanceText });
      });
      const markers = withMeta.map((s, i) => ({
        id: i,
        latitude: s.lat,
        longitude: s.lng,
        width: 30,
        height: 30,
        callout: {
          content: s.name + (s.distanceText ? ('  ' + s.distanceText) : ''),
          display: 'BYCLICK',
          padding: 8,
          borderRadius: 8,
          fontSize: 12,
          color: '#1f2329',
          bgColor: '#ffffff'
        }
      }));
      this.setData({ latitude: center.lat, longitude: center.lng, markers, stores: withMeta });
    });
  },

  onMarkerTap(e) {
    const id = e.detail.markerId;
    const store = this.data.stores[id];
    if (store) this.setData({ selected: store });
  },

  closeSel() {
    this.setData({ selected: null });
  },

  noop() {},

  checkinSelected() {
    const store = this.data.selected;
    if (!store) return;
    const loc = this._userLoc;
    const dist = (loc && typeof store.lat === 'number')
      ? data.distanceKm(loc.lat, loc.lng, store.lat, store.lng) : null;
    const submit = () => {
      const app = getApp();
      const prof = (app && app.globalData && app.globalData.userProfile) || {};
      data.requestCheckin({
        storeId: store._id, storeName: store.name,
        nickname: prof.nickname || '大川会员', avatar: prof.avatar || '',
        lat: loc && loc.lat, lng: loc && loc.lng, dist
      }).then(() => {
        this.setData({ selected: null });
        wx.showModal({
          title: '到店打卡已发起',
          content: `已通知「${store.name}」前台，确认开台后开始计时。`,
          showCancel: false, confirmText: '知道了'
        });
      }).catch(() => wx.showToast({ title: '打卡失败', icon: 'none' }));
    };
    if (!loc) {
      wx.showModal({ title: '未获取到定位', content: '无法核验是否在店内，仍要打卡吗？', confirmText: '仍要打卡', success: (r) => { if (r.confirm) submit(); } });
      return;
    }
    if (dist != null && dist > CHECKIN_RADIUS_KM) {
      wx.showModal({ title: '似乎不在店内', content: `您距「${store.name}」约 ${dist}km，确认打卡？`, confirmText: '确认打卡', success: (r) => { if (r.confirm) submit(); } });
      return;
    }
    submit();
  },

  bookSelected() {
    // 地图以"到店打卡"为主；预约回到约球桌列表操作
    wx.navigateBack();
  }
});
