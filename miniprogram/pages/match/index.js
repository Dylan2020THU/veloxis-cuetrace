const data = require('../../services/data.js');
const billing = require('../../utils/billing.js');

// 线性描边图标（与店主端底栏一致），通过 CSS mask 渲染，颜色由样式控制
const SVG = {
  // 会员 → 约球友
  students: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><path d='M23 21v-2a4 4 0 0 0-3-3.87'/><path d='M16 3.13a4 4 0 0 1 0 7.75'/></svg>",
  // 教练 → 约教练（领带）
  necktie: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10 3 L14 3 L13 7 L15 16 L12 21 L9 16 L11 7 Z'/></svg>",
  // 球桌 → 约球桌（2×2 网格）
  layoutgrid: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='3' width='7' height='7' rx='1'/><rect x='14' y='14' width='7' height='7' rx='1'/><rect x='3' y='14' width='7' height='7' rx='1'/></svg>",
  // 扫码到店
  scan: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2'/><line x1='4' y1='12' x2='20' y2='12'/></svg>",
  // 地图找店（折叠地图）
  map: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M9 4 L3 6 V20 L9 18 L15 20 L21 18 V4 L15 6 Z'/><line x1='9' y1='4' x2='9' y2='18'/><line x1='15' y1='6' x2='15' y2='20'/></svg>"
};

function icon(name) {
  return 'data:image/svg+xml,' + encodeURIComponent(SVG[name]).replace(/'/g, '%27');
}

const TABS = [
  { key: 'friend', text: '约球友', icon: icon('students') },
  { key: 'coach', text: '约教练', icon: icon('necktie') },
  { key: 'table', text: '约球桌', icon: icon('layoutgrid') }
];

// 今天起 7 天，供预约选择
function buildDateOptions() {
  const week = ['日', '一', '二', '三', '四', '五', '六'];
  const out = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    const label = i === 0 ? `今天 ${md}` : i === 1 ? `明天 ${md}` : `周${week[d.getDay()]} ${md}`;
    out.push(label);
  }
  return out;
}

const TIME_OPTIONS = ['00:00','01:00','02:00','03:00','04:00','05:00','06:00','07:00','08:00','09:00','10:00','11:00','12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'];

// 到店打卡的"在店内"半径（km）。生产建议 0.2~0.5；演示坐标为城市级抖动，超出则二次确认放行。
const CHECKIN_RADIUS_KM = 1;

// 城市选择（首项为自动定位，其余复用 14 个主要城市）
const CITY_OPTIONS = ['自动定位', '北京', '上海', '广州', '深圳', '成都', '杭州', '青岛', '昆明', '武汉', '西安', '重庆', '南京', '天津', '沈阳'];

function uniq(arr) {
  const seen = {};
  const out = [];
  (arr || []).forEach((v) => { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
  return out;
}

Page({
  behaviors: [require('../../utils/themeBehavior')],
  data: {
    tabs: TABS,
    scanIcon: icon('scan'),
    mapIcon: icon('map'),
    active: 'friend',
    loading: true,
    matches: [],
    coaches: [],
    tables: [],
    // 搜索 / 城市 / 筛选 工具区（三子页共用搜索+城市，筛选 chip 按子页变化）
    city: '北京',
    cityOptions: CITY_OPTIONS,
    searchText: '',
    filters: {
      friend: { gameType: '', targetLevel: '', gender: '', sort: 'new' },
      coach: { sort: 'new' },
      table: { tableType: '', sort: 'distance' }
    },
    sortLabels: { new: '最新', level: '段位匹配', priceAsc: '价格低→高', priceDesc: '价格高→低', exp: '教龄优先', distance: '离我最近' },
    // 从数据派生的可选项（保证选项与数据一致、不会筛空）
    optGameTypes: [],
    optTargetLevels: [],
    optGenders: [],
    optTableTypes: [],
    filterSheet: null,
    // 预约弹窗
    booking: null,
    dateOptions: buildDateOptions(),
    timeOptions: TIME_OPTIONS,
    dateIndex: 0,
    timeIndex: 4,
    tableTypeIndex: 0
  },

  onLoad() {
    this.loadAll();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().refresh();
    }
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh());
  },

  // 仅首次拉取一次用户定位并缓存，避免每次 onShow 重复弹授权
  _ensureLoc() {
    if (this._locTried) return Promise.resolve(this._userLoc);
    this._locTried = true;
    return data.getUserLatLng().then((loc) => { this._userLoc = loc; return loc; });
  },

  loadAll() {
    this.setData({ loading: true });
    return this._ensureLoc().then(() => Promise.all([
      data.getMatchPosts(),
      data.getBookableCoaches(),
      data.getBookableTables()
    ])).then(([matches, coaches, tables]) => {
      const loc = this._userLoc;
      const tablesWithMin = tables.map((t) => {
        let min;
        if (t.tableTypes && t.tableTypes.length) {
          const prices = t.tableTypes.map((tt) => tt.pricePerHour).filter((p) => p > 0);
          min = prices.length ? Math.min(...prices) : 0;
        } else {
          min = t.pricePerHour || 0;
        }
        const distance = (loc && typeof t.lat === 'number')
          ? data.distanceKm(loc.lat, loc.lng, t.lat, t.lng) : null;
        const distanceText = distance == null ? ''
          : (distance < 1 ? Math.round(distance * 1000) + 'm' : distance + 'km');
        return Object.assign({}, t, { minPricePerHour: min || 0, distance, distanceText });
      });
      // 原始数据缓存在实例上，显示列表由 _applyView() 按 搜索/筛选/排序 计算
      this._raw = { matches, coaches, tables: tablesWithMin };
      const tableTypeNames = [];
      tablesWithMin.forEach((t) => (t.tableTypes || []).forEach((tt) => tableTypeNames.push(tt.name)));
      this.setData({
        loading: false,
        optGameTypes: uniq(matches.map((m) => m.gameType)),
        optTargetLevels: uniq(matches.map((m) => m.targetLevel)),
        optGenders: uniq(matches.map((m) => m.gender)),
        optTableTypes: uniq(tableTypeNames)
      });
      this._applyView();
    });
  },

  // 按 搜索词 + 当前筛选 计算三个子页的显示列表
  _applyView() {
    const raw = this._raw || { matches: [], coaches: [], tables: [] };
    const kw = (this.data.searchText || '').trim().toLowerCase();
    const inc = (s) => (s || '').toLowerCase().indexOf(kw) !== -1;
    const f = this.data.filters;

    // 约球友
    let ml = raw.matches.slice();
    if (kw) ml = ml.filter((m) => inc(m.authorName) || inc(m.hallName) || inc(m.note) || inc(m.gameType));
    if (f.friend.gameType) ml = ml.filter((m) => m.gameType === f.friend.gameType);
    if (f.friend.targetLevel) ml = ml.filter((m) => m.targetLevel === f.friend.targetLevel);
    if (f.friend.gender) ml = ml.filter((m) => m.gender === f.friend.gender);
    if (f.friend.sort === 'level') ml.sort((a, b) => (a.targetLevel || '').localeCompare(b.targetLevel || ''));

    // 约教练
    let cl = raw.coaches.slice();
    if (kw) cl = cl.filter((c) => inc(c.nickname) || inc(c.intro));
    if (f.coach.sort === 'priceAsc') cl.sort((a, b) => (a.pricePerMinute || 0) - (b.pricePerMinute || 0));
    else if (f.coach.sort === 'priceDesc') cl.sort((a, b) => (b.pricePerMinute || 0) - (a.pricePerMinute || 0));
    else if (f.coach.sort === 'exp') cl.sort((a, b) => (b.coachYears || 0) - (a.coachYears || 0));

    // 约球桌
    let tl = raw.tables.slice();
    if (kw) tl = tl.filter((t) => inc(t.name) || inc(t.address));
    if (f.table.tableType) tl = tl.filter((t) => (t.tableTypes || []).some((tt) => tt.name === f.table.tableType));
    if (f.table.sort === 'priceAsc') tl.sort((a, b) => (a.minPricePerHour || 0) - (b.minPricePerHour || 0));
    else tl.sort((a, b) => (a.distance == null ? Infinity : a.distance) - (b.distance == null ? Infinity : b.distance));

    this.setData({ matches: ml, coaches: cl, tables: tl });
  },

  // ---- 搜索 ----
  onSearchInput(e) {
    this.setData({ searchText: e.detail.value });
    this._applyView();
  },
  clearSearch() {
    this.setData({ searchText: '' });
    this._applyView();
  },

  // ---- 城市定位/选择 ----
  onCityChange(e) {
    const idx = Number(e.detail.value);
    if (idx === 0) {
      // 自动定位：重新取经纬度（刷新距离）+ 反解城市名
      this._locTried = false;
      this._ensureLoc().then(() => this.loadAll());
      data.resolveCity().then((city) => { if (city) this.setData({ city }); });
      return;
    }
    this.setData({ city: this.data.cityOptions[idx] });
  },

  // ---- 筛选弹层 ----
  openFilter() {
    const tab = this.data.active;
    this.setData({ filterSheet: { tab, draft: Object.assign({}, this.data.filters[tab]) } });
  },
  closeFilter() {
    this.setData({ filterSheet: null });
  },
  pickFilter(e) {
    const { dim, val } = e.currentTarget.dataset;
    const cur = this.data.filterSheet.draft[dim];
    // 再次点同值=取消（排序为单选不可取消）
    const next = (dim !== 'sort' && cur === val) ? '' : val;
    this.setData({ ['filterSheet.draft.' + dim]: next });
  },
  resetFilter() {
    const tab = this.data.filterSheet.tab;
    const defaults = {
      friend: { gameType: '', targetLevel: '', gender: '', sort: 'new' },
      coach: { sort: 'new' },
      table: { tableType: '', sort: 'distance' }
    };
    this.setData({ 'filterSheet.draft': Object.assign({}, defaults[tab]) });
  },
  applyFilter() {
    const s = this.data.filterSheet;
    if (!s) return;
    this.setData({ ['filters.' + s.tab]: s.draft, filterSheet: null });
    this._applyView();
  },

  // 地图找店
  goMap() {
    wx.navigateTo({ url: '/pages/match/map/index' });
  },

  // 扫桌位码到店（真机：扫 5 期生成的桌位码；devtools 可用每张卡片的"到店打卡"代替）
  onScanCheckin() {
    wx.scanCode({
      scanType: ['qrCode'],
      success: (res) => {
        const payload = this._parseCheckinPayload(res.result || res.path || '');
        if (!payload || !payload.storeId) {
          wx.showToast({ title: '无法识别桌位码', icon: 'none' });
          return;
        }
        data.getStoreById(payload.storeId).then((store) => {
          if (!store) { wx.showToast({ title: '门店不存在或未开通', icon: 'none' }); return; }
          this._doCheckin(Object.assign({}, store, {
            _scanTableId: payload.tableId || '',
            _scanTableName: payload.tableName || ''
          }));
        });
      },
      fail: () => {}
    });
  },

  // 解析桌位码：支持 "s=<storeId>&t=<tableId>"、含 ? 的小程序码 path、或 JSON
  _parseCheckinPayload(raw) {
    if (!raw) return null;
    let str = String(raw);
    if (str.charAt(0) === '{') {
      try { const o = JSON.parse(str); return { storeId: o.store || o.storeId, tableId: o.table || o.tableId, tableName: o.tableName }; } catch (e) {}
    }
    const qi = str.indexOf('?');
    if (qi >= 0) str = str.slice(qi + 1);
    const m = {};
    str.split('&').forEach((kv) => { const p = kv.split('='); if (p[0] && p[1] !== undefined) m[p[0]] = decodeURIComponent(p[1]); });
    const storeId = m.s || m.store || m.storeId;
    if (!storeId) return null;
    return { storeId, tableId: m.t || m.table || m.tableId || '', tableName: m.tn || m.tableName || '' };
  },

  // 卡片"到店打卡"
  checkinHere(e) {
    const t = this.data.tables[e.currentTarget.dataset.index];
    if (t) this._doCheckin(t);
  },

  _doCheckin(store) {
    const loc = this._userLoc;
    const dist = (loc && typeof store.lat === 'number')
      ? data.distanceKm(loc.lat, loc.lng, store.lat, store.lng) : null;
    const proceed = () => this._submitCheckin(store, dist);
    if (!loc) {
      wx.showModal({
        title: '未获取到定位', content: '无法核验是否在店内，仍要发起到店打卡吗？',
        confirmText: '仍要打卡', success: (r) => { if (r.confirm) proceed(); }
      });
      return;
    }
    if (dist != null && dist > CHECKIN_RADIUS_KM) {
      wx.showModal({
        title: '似乎不在店内', content: `您距「${store.name}」约 ${dist}km，确认到店打卡？`,
        confirmText: '确认打卡', success: (r) => { if (r.confirm) proceed(); }
      });
      return;
    }
    proceed();
  },

  _submitCheckin(store, dist) {
    const app = getApp();
    const prof = (app && app.globalData && app.globalData.userProfile) || {};
    const loc = this._userLoc || {};
    data.requestCheckin({
      storeId: store._id,
      storeName: store.name,
      tableId: store._scanTableId || '',
      tableName: store._scanTableName || '',
      nickname: prof.nickname || '大川会员',
      avatar: prof.avatar || '',
      lat: loc.lat, lng: loc.lng, dist
    }).then(() => {
      wx.showModal({
        title: '到店打卡已发起',
        content: `已通知「${store.name}」前台，前台确认开台后开始计时，结账后自动记入你的训练时长。`,
        showCancel: false, confirmText: '知道了'
      });
    }).catch(() => wx.showToast({ title: '打卡失败', icon: 'none' }));
  },

  switchTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key !== this.data.active) this.setData({ active: key });
  },

  goMine() {
    wx.navigateTo({ url: '/pages/match/mine' });
  },

  // ---- 约球友 ----
  goPost() {
    wx.navigateTo({ url: '/pages/match/post' });
  },

  joinMatch(e) {
    const id = e.currentTarget.dataset.id;
    // 约球友的"报名"暂不纳入付费墙（创建/回复帖子已加拦截）；后续若需独立权限可改为 requirePlan({ feature: 'member.joinMatch' })
    data.joinMatch(id).then((r) => {
      wx.showToast({ title: '报名成功', icon: 'success' });
      const matches = this.data.matches.map((m) =>
        m._id === id ? Object.assign({}, m, { joinCount: r.joinCount != null ? r.joinCount : (m.joinCount || 0) + 1 }) : m
      );
      this.setData({ matches });
    });
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id;
    console.log('[match] openDetail id:', id);
    if (!id) { console.warn('openDetail: id 为空'); return; }
    wx.navigateTo({ url: `/pages/match/detail/index?id=${encodeURIComponent(id)}` });
  },

  // ---- 预约弹窗（约教练 / 约球桌通用）----
  openCoachBooking(e) {
    const c = this.data.coaches[e.currentTarget.dataset.index];
    this.setData({
      booking: {
        type: 'coach',
        targetId: c.openid || c._openid || '',
        targetName: c.nickname || '教练',
        hallName: '',
        price: c.pricePerMinute || 0,
        priceLabel: c.pricePerMinute ? `${c.pricePerMinute} 元/分钟` : '面议'
      }
    });
  },

  openTableBooking(e) {
    const t = this.data.tables[e.currentTarget.dataset.index];
    const typeOptions = (t.tableTypes && t.tableTypes.length) ? t.tableTypes : [];
    const firstType = typeOptions[0] || {};
    this.setData({
      tableTypeIndex: 0,
      booking: {
        type: 'table',
        targetId: t._id,
        targetName: t.name,
        hallName: t.name,
        price: firstType.pricePerHour || t.pricePerHour || 0,
        priceLabel: firstType.pricePerHour ? `${firstType.pricePerHour} 元/小时` : '面议',
        tableTypeOptions: typeOptions,
        tableTypeIndex: 0
      }
    });
  },

  onTableTypeChange(e) {
    const idx = Number(e.detail.value);
    const opts = this.data.booking.tableTypeOptions;
    const selected = opts[idx] || {};
    this.setData({
      tableTypeIndex: idx,
      booking: Object.assign({}, this.data.booking, {
        tableTypeIndex: idx,
        price: selected.pricePerHour || 0,
        priceLabel: selected.pricePerHour ? `${selected.pricePerHour} 元/小时` : '面议'
      })
    });
  },

  closeBooking() {
    this.setData({ booking: null });
  },

  noop() {},

  onDateChange(e) {
    this.setData({ dateIndex: Number(e.detail.value) });
  },

  onTimeChange(e) {
    this.setData({ timeIndex: Number(e.detail.value) });
  },

  confirmBooking() {
    const b = this.data.booking;
    if (!b) return;
    // 付费墙：约球桌/约教练属于 player_pro
    const feature = b.type === 'table' ? 'member.bookTable' : 'member.bookCoach';
    billing.requirePlan({ feature, title: b.type === 'table' ? '在线预约球桌' : '在线预约教练' }).then((ok) => {
      if (!ok) return;
      const datetime = `${this.data.dateOptions[this.data.dateIndex]} ${this.data.timeOptions[this.data.timeIndex]}`;
      const tableTypeOption = b.tableTypeOptions && b.tableTypeOptions[b.tableTypeIndex];
      const tableTypeName = tableTypeOption ? tableTypeOption.name : '';
      // 弹二次确认窗（仅展示，不下单）
      this.setData({
        confirmBox: {
          type: b.type,
          targetId: b.targetId,
          targetName: b.targetName,
          hallName: b.hallName,
          price: b.price,
          priceLabel: b.priceLabel,
          datetime,
          tableType: tableTypeName
        }
      });
    });
  },

  // 二次确认：点"否" → 关窗，不下单
  closeConfirm() {
    this.setData({ confirmBox: null });
  },

  // 二次确认：点"是" → 真正下单
  doConfirmBooking() {
    const c = this.data.confirmBox;
    if (!c) return;
    data
      .createBooking({
        type: c.type,
        targetId: c.targetId,
        targetName: c.targetName,
        hallName: c.hallName,
        datetime: c.datetime,
        price: c.price,
        tableType: c.tableType
      })
      .then(() => {
        this.setData({ booking: null, confirmBox: null });
        wx.showToast({ title: '预约已提交', icon: 'success' });
      })
      .catch((err) => {
        this.setData({ confirmBox: null });
        wx.showToast({ title: (err && err.message) || '预约失败', icon: 'none' });
      });
  }
});
