const data = require('../../../services/data');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// 临时演示模式：设为 true 则用模拟数据展示完整占用态，改为 false 恢复真数据
const DEMO_MODE = true;

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0秒';
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  const s = Math.floor((ms % MINUTE) / SECOND);
  if (h > 0) return `${h}时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function computeCardBg(bgColor, status) {
  return 'rgba(255,255,255,0)';
}

function computeOccupiedBorder(bgColor, status) {
  if (status !== 'occupied') return 'rgba(0,0,0,0)';
  return bgColor || '#067ef9';
}

function computeStatus(tables, sessions, members) {
  members = Array.isArray(members) ? members : [];
  sessions = Array.isArray(sessions) ? sessions : [];
  const now = Date.now();
  return tables.map((t) => {
    const activeSession = sessions.find(
      (s) => s.tableId === t.tableId && s.status === 'active'
    );
    if (!activeSession) {
      return { ...t, status: 'idle', players: [], elapsedMs: 0, revenue: 0, revenueText: '', session: null, cardBg: computeCardBg(t.bgColor, 'idle'), occupiedBorder: computeOccupiedBorder(t.bgColor, 'idle') };
    }
    const elapsedMs = now - (activeSession.startedAt || now);
    const revenue = t.pricePerHour ? ((now - (activeSession.startedAt || now)) / HOUR) * t.pricePerHour : 0;
    const players = [];
    if (activeSession.memberOpenid) {
      const member = members.find((m) => m && m.openid === activeSession.memberOpenid);
      players.push({
        openid: activeSession.memberOpenid,
        nickname: member ? member.nickname : '球员',
        avatar: member && member.avatar ? member.avatar : '',
        isCoach: false
      });
    }
    if (activeSession.coachOpenid) {
      const coach = members.find((m) => m && m.openid === activeSession.coachOpenid);
      players.push({
        openid: activeSession.coachOpenid,
        nickname: coach ? coach.nickname : '教练',
        avatar: coach && coach.avatar ? coach.avatar : '',
        isCoach: true,
        joinedAt: activeSession.coachJoinedAt || activeSession.startedAt || now
      });
    }
    return { ...t, status: 'occupied', players, elapsedMs, revenue, revenueText: revenue > 0 ? `收入 ${revenue.toFixed(2)}元` : '', session: activeSession, cardBg: computeCardBg(t.bgColor, 'occupied'), occupiedBorder: computeOccupiedBorder(t.bgColor, 'occupied') };
  });
}

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    tables: [],
    refreshing: false,
    filters: { brand: '', status: '' },
    brandOptions: [],
    filteredTables: [],
    occupiedCount: 0,
    stores: [],
    currentStoreId: '',
    currentStoreName: ''
  },

  onLoad() {
    this.loadInit();
  },

  loadInit() {
    data.getShopStores().then((stores) => {
      if (!stores.length) {
        this.setData({ tables: [], filteredTables: [], refreshing: false });
        return;
      }
      const storeId = stores[0]._id;
      this.setData({ stores, currentStoreId: storeId, currentStoreName: stores[0].name });
      this._loadByStore(storeId);
    }).catch(() => this.setData({ refreshing: false }));
  },

  onStoreChange(e) {
    const idx = e.detail.value;
    const store = this.data.stores[idx];
    this.setData({ currentStoreId: store._id, currentStoreName: store.name });
    this._loadByStore(store._id);
  },

  _loadByStore(storeId) {
    this.setData({ refreshing: true });
    if (DEMO_MODE) {
      const now = Date.now();
      // 20 个模拟球台数据
      const TABLE_CONFIGS = [
        // ---- 桌型 ----
        { tableId: 'T1',  tableName: '1号桌',  bgColor: '#067EF9', tableTypeName: '乔氏金腿',   pricePerHour: 78,  status: 'occupied', elapsedH: 2, elapsedM: 35, elapsedS: 18, players: [{ openid: 'member_01', nickname: '李晨曦',  avatar: '',    isCoach: false }, { openid: 'member_02', nickname: '王浩然',  avatar: '',    isCoach: false }, { openid: 'coach_01', nickname: '周明辉', avatar: '', isCoach: true,  teachH: 1, teachM: 48, teachS: 5 }] },
        { tableId: 'T2',  tableName: '2号桌',  bgColor: '#34c759', tableTypeName: '乔氏银腿',   pricePerHour: 68,  status: 'idle' },
        { tableId: 'T3',  tableName: '3号桌',  bgColor: '#ff6b35', tableTypeName: '中式八球',   pricePerHour: 50,  status: 'occupied', elapsedH: 0, elapsedM: 47, elapsedS: 33, players: [{ openid: 'member_03', nickname: '张雨萱',  avatar: '',    isCoach: false }, { openid: 'coach_02', nickname: '吴建国', avatar: '', isCoach: true,  teachH: 0, teachM: 25, teachS: 10 }] },
        { tableId: 'T4',  tableName: '4号桌',  bgColor: '#9b59b6', tableTypeName: '美式落袋',   pricePerHour: 90,  status: 'idle' },
        { tableId: 'T5',  tableName: '5号桌',  bgColor: '#e67e22', tableTypeName: '英式斯诺克', pricePerHour: 120, status: 'occupied', elapsedH: 1, elapsedM: 15, elapsedS: 5,  players: [{ openid: 'member_04', nickname: '刘子琪',  avatar: '',    isCoach: false }, { openid: 'member_05', nickname: '陈思远',  avatar: '',    isCoach: false }] },
        { tableId: 'T6',  tableName: '6号桌',  bgColor: '#e91e8c', tableTypeName: '潘晓婷代言',  pricePerHour: 100, status: 'idle' },
        { tableId: 'T7',  tableName: '7号桌',  bgColor: '#00bcd4', tableTypeName: '开仑台',      pricePerHour: 60,  status: 'occupied', elapsedH: 0, elapsedM: 22, elapsedS: 45, players: [{ openid: 'member_06', nickname: '何雪晴',  avatar: '',    isCoach: false }, { openid: 'member_07', nickname: '黄一凡',  avatar: '',    isCoach: false }, { openid: 'coach_03', nickname: '郑海涛', avatar: '', isCoach: true,  teachH: 0, teachM: 12, teachS: 30 }] },
        { tableId: 'T8',  tableName: '8号桌',  bgColor: '#067EF9', tableTypeName: '乔氏金腿',   pricePerHour: 78,  status: 'idle' },
        { tableId: 'T9',  tableName: '9号桌',  bgColor: '#34c759', tableTypeName: '乔氏银腿',   pricePerHour: 68,  status: 'occupied', elapsedH: 3, elapsedM: 5,  elapsedS: 0,  players: [{ openid: 'member_08', nickname: '林志远',  avatar: '',    isCoach: false }, { openid: 'coach_04', nickname: '冯志刚', avatar: '', isCoach: true,  teachH: 1, teachM: 30, teachS: 0 }] },
        { tableId: 'T10', tableName: '10号桌', bgColor: '#ff6b35', tableTypeName: '中式八球',   pricePerHour: 50,  status: 'idle' },
        { tableId: 'T11', tableName: '11号桌', bgColor: '#9b59b6', tableTypeName: '美式落袋',   pricePerHour: 90,  status: 'occupied', elapsedH: 0, elapsedM: 58, elapsedS: 12, players: [{ openid: 'member_09', nickname: '孙小波', avatar: '',    isCoach: false }, { openid: 'member_10', nickname: '马锦程', avatar: '',    isCoach: false }] },
        { tableId: 'T12', tableName: '12号桌', bgColor: '#e67e22', tableTypeName: '英式斯诺克', pricePerHour: 120, status: 'idle' },
        { tableId: 'T13', tableName: '13号桌', bgColor: '#e91e8c', tableTypeName: '潘晓婷代言',  pricePerHour: 100, status: 'occupied', elapsedH: 1, elapsedM: 42, elapsedS: 50, players: [{ openid: 'member_11', nickname: '朱雅婷', avatar: '',    isCoach: false }, { openid: 'member_12', nickname: '胡泽楷', avatar: '',    isCoach: false }, { openid: 'coach_05', nickname: '顾小东', avatar: '', isCoach: true,  teachH: 0, teachM: 55, teachS: 20 }] },
        { tableId: 'T14', tableName: '14号桌', bgColor: '#00bcd4', tableTypeName: '开仑台',      pricePerHour: 60,  status: 'idle' },
        { tableId: 'T15', tableName: '15号桌', bgColor: '#067EF9', tableTypeName: '乔氏金腿',   pricePerHour: 78,  status: 'occupied', elapsedH: 0, elapsedM: 10, elapsedS: 5,  players: [{ openid: 'member_13', nickname: '蒋文博', avatar: '',    isCoach: false }] },
        { tableId: 'T16', tableName: '16号桌', bgColor: '#34c759', tableTypeName: '乔氏银腿',   pricePerHour: 68,  status: 'idle' },
        { tableId: 'T17', tableName: '17号桌', bgColor: '#ff6b35', tableTypeName: '中式八球',   pricePerHour: 50,  status: 'idle' },
        { tableId: 'T18', tableName: '18号桌', bgColor: '#9b59b6', tableTypeName: '美式落袋',   pricePerHour: 90,  status: 'idle' },
        { tableId: 'T19', tableName: '19号桌', bgColor: '#e67e22', tableTypeName: '英式斯诺克', pricePerHour: 120, status: 'idle' },
        { tableId: 'T20', tableName: '20号桌', bgColor: '#e91e8c', tableTypeName: '潘晓婷代言',  pricePerHour: 100, status: 'idle' },
      ];

      const demoTables = TABLE_CONFIGS.map((cfg) => {
        const isOcc = cfg.status === 'occupied';
        const tableStartedAt = isOcc ? now - (cfg.elapsedH * HOUR + cfg.elapsedM * MINUTE + cfg.elapsedS * SECOND) : null;
        const rawRevenue = isOcc ? ((now - tableStartedAt) / HOUR) * cfg.pricePerHour : 0;
        const players = isOcc
          ? cfg.players.map((p) => {
              const joinedAt = p.isCoach ? (isOcc ? now - (p.teachH * HOUR + p.teachM * MINUTE + p.teachS * SECOND) : null) : null;
              return {
                openid: p.openid,
                nickname: p.nickname,
                avatar: p.avatar || '',
                isCoach: !!p.isCoach,
                joinedAt: joinedAt || null,
                teachMs: joinedAt ? now - joinedAt : 0,
                teachText: joinedAt ? `已助教 ${p.teachH}时${p.teachM}分${p.teachS}秒` : ''
              };
            })
          : [];

        return {
          tableId: cfg.tableId,
          tableName: cfg.tableName,
          bgColor: cfg.bgColor,
          cardBg: computeCardBg(cfg.bgColor, cfg.status),
          occupiedBorder: computeOccupiedBorder(cfg.bgColor, cfg.status),
          tableTypeName: cfg.tableTypeName,
          pricePerHour: cfg.pricePerHour,
          image: '',
          status: cfg.status,
          elapsedMs: isOcc ? now - tableStartedAt : 0,
          elapsedText: isOcc ? `已开桌 ${cfg.elapsedH}时${cfg.elapsedM}分${cfg.elapsedS}秒` : '',
          revenue: rawRevenue,
          revenueText: rawRevenue > 0 ? `收入 ${rawRevenue.toFixed(2)}元` : '',
          players,
          session: isOcc ? { _id: `demo_session_${cfg.tableId}`, startedAt: tableStartedAt } : null
        };
      });
      this.setData({ tables: demoTables, refreshing: false });
      this._applyFilters();
      return;
    }

    Promise.all([data.getShopStores(), data.getSessions(), data.getMembers()])
      .then(([stores, sessions, members]) => {
        const store = stores.find((s) => s._id === this.data.currentStoreId) || stores[0] || {};
        const tableTypes = (store && store.tableTypes) || [];
        if (!tableTypes.length) {
          this.setData({ tables: [], filteredTables: [] });
          return;
        }
        const tables = tableTypes.map((tt, i) => ({
          tableId: tt.tableId || `T${i + 1}`,
          tableName: tt.name || `台${i + 1}`,
          bgColor: tt.bgColor || '#067EF9',
          tableTypeName: tt.name || '',
          pricePerHour: tt.pricePerHour || 0,
          image: tt.image || ''
        }));
        const sessions2 = (sessions || []).filter((s) => s.status === 'active');
        const tables2 = computeStatus(tables, sessions2, members || []);
        this.setData({ tables: tables2 }, () => this._applyFilters());
      })
      .catch((err) => {
        console.error('[hall-status] loadData failed:', err);
        wx.showToast({ title: '加载失败', icon: 'none' });
      })
      .finally(() => this.setData({ refreshing: false }));
  },

  onShow() {
    this.startTimer();
  },

  onHide() {
    this.stopTimer();
  },

  onUnload() {
    this.stopTimer();
  },

  startTimer() {
    this.stopTimer();
    this._timer = setInterval(() => {
      this.tickElapsed();
    }, 1000);
  },

  stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  tickElapsed() {
    const now = Date.now();
    const updated = this.data.tables.map((t) => {
      if (t.status !== 'occupied' || !t.session) return t;
      const startedAt = t.session.startedAt || now;
      const elapsedMs = now - startedAt;
      const revenue = t.pricePerHour ? (elapsedMs / HOUR) * t.pricePerHour : 0;
      const revenueText = revenue > 0 ? `收入 ${revenue.toFixed(2)}元` : '';
      const players = t.players.map((p) => {
        if (!p.isCoach || !p.joinedAt) return p;
        const teachMs = now - p.joinedAt;
        return { ...p, teachMs };
      });
      return { ...t, elapsedMs, revenue, revenueText, players };
    });
    this.setData({ tables: updated });
  },

  toggleTable(e) {
    const idx = e.currentTarget.dataset.idx;
    const table = this.data.filteredTables[idx];
    if (!table) return;
    if (table.status === 'idle') {
      wx.showModal({
        title: '使用球桌',
        content: `确定「${table.tableName}」开始使用吗？`,
        success: (res) => {
          if (!res.confirm) return;
          this.openTable(idx);
        }
      });
    } else {
      wx.showModal({
        title: '结束使用',
        content: `「${table.tableName}」结账离桌？`,
        success: (res) => {
          if (!res.confirm) return;
          this.closeTable(idx);
        }
      });
    }
  },

  openTable(idx) {
    const table = this.data.filteredTables[idx];
    data.createSession({ tableId: table.tableId }).then(() => {
      wx.showToast({ title: '已开始使用', icon: 'success' });
      this.loadInit();
    });
  },

  closeTable(idx) {
    const table = this.data.filteredTables[idx];
    data.closeSession({ sessionId: table.session._id }).then(() => {
      wx.showToast({ title: '已结束使用', icon: 'success' });
      this.loadInit();
    });
  },

  goPlayerProfile(e) {
    const { openid, nickname, iscoach } = e.currentTarget.dataset;
    if (!openid) return;
    wx.navigateTo({
      url: `/pages/player/profile/index?openid=${encodeURIComponent(openid)}&nickname=${encodeURIComponent(nickname || '')}&isCoach=${iscoach || 0}`
    });
  },

  formatDuration(ms) {
    return formatDuration(ms);
  },

  formatRevenue(yuan) {
    if (yuan == null || yuan < 0) return '收入 0.00元';
    return `收入 ${yuan.toFixed(2)}元`;
  },

  formatTeach(ms) {
    if (!ms || ms <= 0) return '';
    return `已助教${formatDuration(ms)}`;
  },

  _applyFilters() {
    const { tables, filters } = this.data;
    const brands = [...new Set(tables.map((t) => t.tableTypeName).filter(Boolean))].sort();
    const filtered = tables.filter((t) => {
      if (filters.brand && t.tableTypeName !== filters.brand) return false;
      if (filters.status && t.status !== filters.status) return false;
      return true;
    });
    const occupiedCount = filtered.filter((t) => t.status === 'occupied').length;
    this.setData({ brandOptions: brands, filteredTables: filtered, occupiedCount });
  },

  filterByBrand(e) {
    const brand = e.currentTarget.dataset.value;
    this.setData({ 'filters.brand': brand }, () => this._applyFilters());
  },

  filterByStatus(e) {
    const status = e.currentTarget.dataset.value;
    this.setData({ 'filters.status': status }, () => this._applyFilters());
  }
});
