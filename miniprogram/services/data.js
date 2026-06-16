// 数据服务层：统一对外暴露 Promise 接口。
// 若已配置并初始化云开发环境，则走云函数；否则自动回退到本地 mock 数据。
// 这样在没有云环境时也能在开发者工具中端到端演示。

const mock = require('../utils/mock');
const { levelFromMinutes } = require('../utils/color');

function cloudReady() {
  const app = getApp();
  return !!(app && app.globalData && app.globalData.cloudReady && wx.cloud);
}

function callCloud(name, data) {
  return wx.cloud.callFunction({ name, data }).then((res) => res.result);
}

// 初始化（播种演示数据；cloudReady 时云端数据优先，本地数据作为兜底）
function initData() {
  mock.ensureSeeded();
}

function applyUserResult(r) {
  const app = getApp();
  if (!app || !app.globalData || !r) return;
  if (r.openid) app.globalData.openid = r.openid;
  if (r.role) {
    mock.setRole(r.role);
    app.globalData.role = r.role;
  }
  if (r.nickname !== undefined || r.avatar !== undefined) {
    app.globalData.userProfile = {
      openid: r.openid || app.globalData.openid,
      role: r.role || app.globalData.role,
      nickname: r.nickname || '',
      avatar: r.avatar || ''
    };
  }
}

// 登录，返回 openid。role 可选：登录页选定身份，传入时写入云端 users 集合。
function login(role) {
  if (cloudReady()) {
    return callCloud('login', role ? { role } : {}).then((r) => {
      applyUserResult(r);
      return (r && r.openid) || '';
    });
  }
  getApp().globalData.openid = mock.MOCK_OPENID;
  mock.setRole(role);
  return Promise.resolve(mock.MOCK_OPENID);
}

// 读取当前用户在云数据库 users 集合中的资料
function getUserProfile() {
  if (cloudReady()) {
    return callCloud('getUserProfile', {}).then((r) => {
      const user = (r && r.user) || null;
      if (user) applyUserResult(user);
      return user;
    });
  }
  const user = {
    openid: mock.MOCK_OPENID,
    role: mock.getRole(),
    nickname: '大川会员',
    avatar: ''
  };
  applyUserResult(user);
  return Promise.resolve(user);
}

function saveUserProfile({ nickname, avatar, gender, birthDate, phone, locationCity, hometown, years, level }) {
  if (cloudReady()) {
    return callCloud('saveUserProfile', { nickname, avatar, gender, birthDate, phone, locationCity, hometown, years, level });
  }
  const key = 'dc_user_profile';
  const existing = mock.readObject(key, null) || {};
  const updated = Object.assign({}, existing, { nickname, avatar, gender, birthDate, phone, locationCity, hometown, years, level });
  mock.writeObject(key, updated);
  if (getApp().globalData) {
    getApp().globalData.userProfile = updated;
  }
  return Promise.resolve({ ok: true });
}

function getHalls() {
  if (cloudReady()) {
    return callCloud('getHalls', {}).then((r) => (r && r.halls) || []);
  }
  return Promise.resolve(mock.readArray(mock.KEY_HALLS));
}

// 聚合得到 [start, end] 区间内每一天的训练统计
// 返回数组：{ date, totalMinutes, sessionCount, level }
// targetOpenid 可选：教练查看已绑定会员数据时传入。
function getHeatmap({ startKey, endKey, targetOpenid }) {
  if (cloudReady()) {
    return callCloud('getHeatmap', { startKey, endKey, targetOpenid }).then(
      (r) => (r && r.stats) || []
    );
  }
  const ownerOpenid = targetOpenid || mock.MOCK_OPENID;
  const sessions = mock
    .readArray(mock.KEY_SESSIONS)
    .filter((s) => s._openid === ownerOpenid && s.date >= startKey && s.date <= endKey);
  const map = {};
  sessions.forEach((s) => {
    if (!map[s.date]) map[s.date] = { date: s.date, totalMinutes: 0, sessionCount: 0 };
    map[s.date].totalMinutes += s.durationMinutes || 0;
    map[s.date].sessionCount += 1;
  });
  const stats = Object.keys(map).map((k) => {
    const item = map[k];
    item.level = levelFromMinutes(item.totalMinutes);
    return item;
  });
  return Promise.resolve(stats);
}

// 某一天的明细记录。targetOpenid 可选（教练查看会员）。
function getDayDetail(dateKey, targetOpenid) {
  if (cloudReady()) {
    return callCloud('getDayDetail', { dateKey, targetOpenid }).then(
      (r) => (r && r.sessions) || []
    );
  }
  const ownerOpenid = targetOpenid || mock.MOCK_OPENID;
  const sessions = mock
    .readArray(mock.KEY_SESSIONS)
    .filter((s) => s._openid === ownerOpenid && s.date === dateKey)
    .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  return Promise.resolve(sessions);
}

// 新增一条训练记录
function addTraining({ hallId, hallName, date, startTime, durationMinutes }) {
  if (cloudReady()) {
    return callCloud('addTraining', { hallId, hallName, date, startTime, durationMinutes });
  }
  const sessions = mock.readArray(mock.KEY_SESSIONS);
  sessions.push({
    _id: `mock_s_${Date.now()}`,
    _openid: mock.MOCK_OPENID,
    hallId,
    hallName,
    date,
    startTime,
    durationMinutes,
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_SESSIONS, sessions);
  return Promise.resolve({ ok: true });
}

// ============ 角色 ============

function getRole() {
  // 云端模式也优先读本地缓存，避免每次拉取；登录时会同步
  return Promise.resolve(mock.getRole());
}

function setRole(role) {
  mock.setRole(role);
  const app = getApp();
  if (app && app.globalData) app.globalData.role = role;
  if (cloudReady()) {
    return callCloud('login', { role }).then((r) => {
      applyUserResult(r);
      return (r && r.role) || role;
    });
  }
  return Promise.resolve(role);
}

// ============ 教练资料 ============

function getCoachProfile() {
  if (cloudReady()) {
    return callCloud('getCoachProfile', {}).then((r) => (r && r.profile) || null);
  }
  return Promise.resolve(mock.readObject(mock.KEY_COACH, null));
}

function getCoachProfileByOpenid(openid) {
  if (!openid) return Promise.resolve(null);
  if (cloudReady()) {
    return callCloud('getCoachProfile', { targetOpenid: openid }).then((r) => (r && r.profile) || null);
  }
  return Promise.resolve(mock.getCoachProfileByOpenid(openid));
}

function getMemberProfileByOpenid(openid) {
  if (!openid) return Promise.resolve(null);
  if (cloudReady()) {
    return callCloud('getMemberProfile', { targetOpenid: openid }).then((r) => (r && r.member) || null);
  }
  const members = mock.readArray(mock.KEY_MEMBERS);
  return Promise.resolve(members.find((m) => m.openid === openid) || null);
}

function getMemberCheckinsByOpenid(openid) {
  if (!openid) return Promise.resolve([]);
  if (cloudReady()) {
    return callCloud('getMemberCheckins', { targetOpenid: openid }).then((r) => (r && r.checkins) || []);
  }
  return Promise.resolve(mock.getMemberCheckins(openid));
}

function getMemberCheckins() {
  if (cloudReady()) {
    return callCloud('getMemberCheckins', {}).then((r) => (r && r.checkins) || []);
  }
  return Promise.resolve([]);
}

function saveCoachProfile(profile) {
  if (cloudReady()) {
    return callCloud('saveCoachProfile', profile).then((r) => {
      mock.setRole('coach');
      return r;
    });
  }
  mock.writeObject(mock.KEY_COACH, Object.assign({ _openid: mock.MOCK_OPENID }, profile));
  mock.setRole('coach');
  return Promise.resolve({ ok: true });
}

// ============ 师生绑定 ============

// 教练已绑定的会员列表
function getMyMembers() {
  if (cloudReady()) {
    return callCloud('getMyMembers', {}).then((r) => (r && r.members) || []);
  }
  const links = mock.readArray(mock.KEY_LINKS);
  const members = mock.readArray(mock.KEY_MEMBERS);
  const linkedOpenids = links.map((l) => l.memberOpenid);
  return Promise.resolve(members.filter((m) => linkedOpenids.indexOf(m.openid) !== -1));
}

// 可绑定但尚未绑定的演示会员（mock 模式下用于"添加学员"选择）
function getLinkableMembers() {
  if (cloudReady()) {
    // 云端模式下通过会员编码绑定，无候选列表
    return Promise.resolve([]);
  }
  const links = mock.readArray(mock.KEY_LINKS);
  const members = mock.readArray(mock.KEY_MEMBERS);
  const linkedOpenids = links.map((l) => l.memberOpenid);
  return Promise.resolve(members.filter((m) => linkedOpenids.indexOf(m.openid) === -1));
}

function linkMember(memberOpenid) {
  if (cloudReady()) {
    return callCloud('linkMember', { memberOpenid });
  }
  const links = mock.readArray(mock.KEY_LINKS);
  if (links.some((l) => l.memberOpenid === memberOpenid)) {
    return Promise.resolve({ ok: true, msg: '已绑定' });
  }
  links.push({
    coachOpenid: mock.MOCK_OPENID,
    memberOpenid,
    status: 'active',
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_LINKS, links);
  return Promise.resolve({ ok: true });
}

// ============ 店家 ============

// mock 模式下根据 openid 解析会员昵称
function mockNickname(openid) {
  if (openid === mock.MOCK_OPENID) return '大川会员';
  const m = mock.readArray(mock.KEY_MEMBERS).find((x) => x.openid === openid);
  return (m && m.nickname) || '会员';
}

function getShopProfile() {
  if (cloudReady()) {
    return callCloud('getShopProfile', {}).then((r) => (r && r.profile) || null);
  }
  return Promise.resolve(mock.readObject(mock.KEY_SHOP, null));
}

// 店主保存的资料（品牌+门店双层）
function saveShopProfile({ name, hallId, hallName, tableTypes, brandId, storeId }) {
  if (cloudReady()) {
    return callCloud('saveShopProfile', { name, hallId, hallName, tableTypes, brandId, storeId }).then((r) => {
      mock.setRole('shop');
      return r;
    });
  }
  const existing = mock.readObject(mock.KEY_SHOP, null) || {};
  const updated = Object.assign({}, existing, {
    _openid: mock.MOCK_OPENID,
    name: name !== undefined ? name : existing.name,
    hallId: hallId !== undefined ? hallId : existing.hallId,
    hallName: hallName !== undefined ? hallName : existing.hallName,
    tableTypes: Array.isArray(tableTypes) ? tableTypes : existing.tableTypes,
    brandId: brandId !== undefined ? brandId : existing.brandId,
    storeId: storeId !== undefined ? storeId : existing.storeId
  });
  mock.writeObject(mock.KEY_SHOP, updated);
  mock.setRole('shop');
  return Promise.resolve({ ok: true });
}

// ============ 品牌管理 ============

// 获取全系统品牌（系统级，所有人可见）
function getBrands() {
  if (cloudReady()) {
    return callCloud('getBrands', {}).then((r) => (r && r.brands) || []);
  }
  return Promise.resolve(mock.readArray(mock.KEY_BRANDS));
}

// 保存品牌（店主账号下）
function saveShopBrand(brand) {
  if (cloudReady()) {
    return callCloud('saveShopBrand', { brand });
  }
  const brands = mock.readArray(mock.KEY_BRANDS);
  const idx = brands.findIndex((b) => b._id === brand._id);
  if (idx !== -1) {
    brands[idx] = Object.assign({}, brands[idx], brand);
  } else {
    brands.push(Object.assign({ _openid: mock.MOCK_OPENID, createdAt: Date.now() }, brand));
  }
  mock.writeArray(mock.KEY_BRANDS, brands);
  return Promise.resolve({ ok: true });
}

// 获取本店品牌列表
function getShopBrands() {
  if (cloudReady()) {
    return callCloud('getShopBrands', {}).then((r) => (r && r.brands) || []);
  }
  return Promise.resolve(mock.readArray(mock.KEY_BRANDS));
}

// ============ 门店管理 ============

// 获取系统门店（可按 brandId 过滤）
function getStores(brandId) {
  if (cloudReady()) {
    return callCloud('getStores', { brandId }).then((r) => (r && r.stores) || []);
  }
  const stores = mock.readArray(mock.KEY_STORES);
  if (brandId) return Promise.resolve(stores.filter((s) => s.brandId === brandId));
  return Promise.resolve(stores);
}

// 保存本店门店配置（店主新增/修改自己添加的门店）
function saveShopStore(store) {
  if (cloudReady()) {
    return callCloud('saveShopStore', { store });
  }
  const stores = mock.readArray(mock.KEY_STORES);
  const idx = stores.findIndex((s) => s._id === store._id);
  if (idx !== -1) {
    stores[idx] = Object.assign({}, stores[idx], store);
  } else {
    stores.push(Object.assign({ _openid: mock.MOCK_OPENID, createdAt: Date.now() }, store));
  }
  mock.writeArray(mock.KEY_STORES, stores);
  return Promise.resolve({ ok: true });
}

// 获取本店管理的门店（店主自定义添加的门店）
function getShopStores() {
  if (cloudReady()) {
    return callCloud('getShopStores', {}).then((r) => (r && r.stores) || []);
  }
  const stores = mock.readArray(mock.KEY_STORES);
  console.log('[getShopStores] KEY_STORES count:', stores.length);
  return Promise.resolve(stores);
}

// ============ 球台状态（开桌/结账） ============

function getSessions() {
  if (cloudReady()) {
    return callCloud('getSessions', {}).then((r) => (r && r.sessions) || []);
  }
  return Promise.resolve(mock.readArray(mock.KEY_SESSIONS));
}

function createSession({ tableId }) {
  if (cloudReady()) {
    return callCloud('createSession', { tableId });
  }
  const sessions = mock.readArray(mock.KEY_SESSIONS);
  sessions.push({
    _id: `mock_s_${Date.now()}`,
    _openid: mock.MOCK_OPENID,
    tableId,
    status: 'active',
    startedAt: Date.now(),
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_SESSIONS, sessions);
  return Promise.resolve({ ok: true });
}

function closeSession({ sessionId }) {
  if (cloudReady()) {
    return callCloud('closeSession', { sessionId });
  }
  const sessions = mock.readArray(mock.KEY_SESSIONS);
  const idx = sessions.findIndex((s) => s._id === sessionId);
  if (idx !== -1) {
    sessions[idx].status = 'closed';
    sessions[idx].closedAt = Date.now();
    mock.writeArray(mock.KEY_SESSIONS, sessions);
  }
  return Promise.resolve({ ok: true });
}

// ============ 球员列表（按 openid 查昵称/头像，供 hall-status 渲染） ============

function getMembers() {
  if (cloudReady()) {
    return callCloud('getMembers', {}).then((r) => (r && r.members) || []);
  }
  return Promise.resolve(mock.readArray(mock.KEY_MEMBERS));
}

// 本店已管理的教练列表
function getShopCoaches() {
  if (cloudReady()) {
    return callCloud('getShopCoaches', {}).then((r) => (r && r.coaches) || []);
  }
  const links = mock.readArray(mock.KEY_SHOP_COACHES);
  const linkedOpenids = links.map((l) => l.coachOpenid);
  const allCoaches = mock.readArray(mock.KEY_ALL_COACHES);
  const filtered = allCoaches.filter((c) => linkedOpenids.indexOf(c.openid) !== -1);
  console.log('[getShopCoaches] links:', links.length, 'openids:', linkedOpenids, 'coaches:', filtered.length);
  return Promise.resolve(filtered);
}

// 可添加（尚未被本店管理）的教练列表
function getLinkableCoaches() {
  if (cloudReady()) {
    return callCloud('getLinkableCoaches', {}).then((r) => (r && r.coaches) || []);
  }
  const links = mock.readArray(mock.KEY_SHOP_COACHES);
  const linkedOpenids = links.map((l) => l.coachOpenid);
  return Promise.resolve(
    mock
      .readArray(mock.KEY_ALL_COACHES)
      .filter((c) => linkedOpenids.indexOf(c.openid) === -1)
  );
}

function addShopCoach(coachOpenid) {
  if (cloudReady()) {
    return callCloud('addShopCoach', { coachOpenid });
  }
  const links = mock.readArray(mock.KEY_SHOP_COACHES);
  if (links.some((l) => l.coachOpenid === coachOpenid)) {
    return Promise.resolve({ ok: true, msg: '已添加' });
  }
  links.push({ shopOpenid: mock.MOCK_OPENID, coachOpenid, status: 'active', createdAt: Date.now() });
  mock.writeArray(mock.KEY_SHOP_COACHES, links);
  return Promise.resolve({ ok: true });
}

function removeShopCoach(coachOpenid) {
  if (cloudReady()) {
    return callCloud('removeShopCoach', { coachOpenid });
  }
  const links = mock.readArray(mock.KEY_SHOP_COACHES).filter((l) => l.coachOpenid !== coachOpenid);
  mock.writeArray(mock.KEY_SHOP_COACHES, links);
  return Promise.resolve({ ok: true });
}

// 某位教练给哪些球员上过课：返回会员列表 [{ openid, nickname, avatar }]
function getCoachStudents(coachOpenid) {
  if (cloudReady()) {
    return callCloud('getCoachStudents', { coachOpenid }).then(
      (r) => (r && r.students) || []
    );
  }
  return Promise.resolve(mock.coachStudents(coachOpenid));
}

// 本店会员训练统计：{ openid, nickname, checkinDays, totalMinutes }
// storeId 可选：指定门店时按该门店过滤；否则用 shop.storeId
function getShopMembers(storeId) {
  if (cloudReady()) {
    return callCloud('getShopMembers', { storeId }).then((r) => (r && r.members) || []);
  }
  const shop = mock.readObject(mock.KEY_SHOP, null);
  const targetStoreId = storeId || (shop && shop.storeId);
  console.log('[getShopMembers] shop:', JSON.stringify(shop), 'targetStoreId:', targetStoreId);
  if (!targetStoreId) return Promise.resolve([]);

  const sessions = mock.readArray(mock.KEY_SESSIONS).filter((s) => s.hallId === targetStoreId);
  console.log('[getShopMembers] sessions for hallId', targetStoreId, ':', sessions.length);
  const agg = {};
  sessions.forEach((s) => {
    if (!agg[s._openid]) agg[s._openid] = { totalMinutes: 0, days: {} };
    agg[s._openid].totalMinutes += s.durationMinutes || 0;
    agg[s._openid].days[s.date] = true;
  });

  const members = Object.keys(agg)
    .map((openid) => ({
      openid,
      nickname: mockNickname(openid),
      avatar: mock.avatarFor(openid),
      checkinDays: Object.keys(agg[openid].days).length,
      totalMinutes: agg[openid].totalMinutes
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes);

  return Promise.resolve(members);
}

// ============ 文件上传 ============

// 上传一张本地图片，返回可用于展示/存储的地址。
// 云端模式上传到云存储返回 fileID；mock 模式直接返回本地临时路径。
function uploadImage(tempFilePath) {
  return uploadFile(tempFilePath, 'coach');
}

// 通用文件上传（图片 / 视频）。dir 为云存储目录前缀。
function uploadFile(tempFilePath, dir) {
  if (cloudReady()) {
    const ext = (tempFilePath.split('.').pop() || 'dat').toLowerCase().split('?')[0];
    const cloudPath = `${dir || 'misc'}/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
    return wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath }).then((res) => res.fileID);
  }
  return Promise.resolve(tempFilePath);
}

// ============ 社区 ============

function getCurrentUserInfo() {
  const app = getApp();
  const profile = app && app.globalData && app.globalData.userProfile;
  if (profile && (profile.nickname || profile.avatar)) {
    return {
      authorName: profile.nickname || '大川会员',
      authorAvatar: profile.avatar || ''
    };
  }
  return { authorName: '大川会员', authorAvatar: '' };
}

// tab: 'discover' | 'follow' | 'region'；region 为 tab==='region' 时的城市名
function getFeed({ page = 0, pageSize = 20, tab = 'discover', region = '' } = {}) {
  if (cloudReady()) {
    return callCloud('getFeed', { page, pageSize, tab, region }).then(
      (r) => (r && r.posts) || []
    );
  }
  let posts = mock.readArray(mock.KEY_POSTS).slice();
  if (tab === 'follow') {
    const follows = mock.readArray(mock.KEY_FOLLOWS);
    posts = posts.filter((p) => follows.indexOf(p._openid) !== -1);
  } else if (tab === 'region') {
    posts = posts.filter((p) => p.region === region);
  }
  posts.sort((a, b) => b.createdAt - a.createdAt);
  return Promise.resolve(posts.slice(page * pageSize, (page + 1) * pageSize));
}

// ============ 关注 ============

function getFollows() {
  if (cloudReady()) {
    return callCloud('getFollows', {}).then((r) => (r && r.follows) || []);
  }
  return Promise.resolve(mock.readArray(mock.KEY_FOLLOWS));
}

function toggleFollow(authorOpenid) {
  if (cloudReady()) {
    return callCloud('toggleFollow', { authorOpenid });
  }
  const follows = mock.readArray(mock.KEY_FOLLOWS);
  const idx = follows.indexOf(authorOpenid);
  let following;
  if (idx !== -1) {
    follows.splice(idx, 1);
    following = false;
  } else {
    follows.push(authorOpenid);
    following = true;
  }
  mock.writeArray(mock.KEY_FOLLOWS, follows);
  return Promise.resolve({ ok: true, following });
}

// ============ 定位城市 ============

// 主要城市经纬度中心，用于免密钥的"就近城市"匹配
const CITY_CENTERS = [
  { city: '北京', lat: 39.9, lng: 116.4 },
  { city: '上海', lat: 31.23, lng: 121.47 },
  { city: '广州', lat: 23.13, lng: 113.26 },
  { city: '深圳', lat: 22.54, lng: 114.06 },
  { city: '成都', lat: 30.57, lng: 104.07 },
  { city: '杭州', lat: 30.27, lng: 120.16 },
  { city: '青岛', lat: 36.07, lng: 120.38 },
  { city: '昆明', lat: 25.04, lng: 102.71 },
  { city: '武汉', lat: 30.59, lng: 114.3 },
  { city: '西安', lat: 34.34, lng: 108.94 },
  { city: '重庆', lat: 29.56, lng: 106.55 },
  { city: '南京', lat: 32.06, lng: 118.8 },
  { city: '天津', lat: 39.13, lng: 117.2 },
  { city: '沈阳', lat: 41.8, lng: 123.43 }
];

function nearestCity(lat, lng) {
  let best = CITY_CENTERS[0];
  let min = Infinity;
  CITY_CENTERS.forEach((c) => {
    const d = (c.lat - lat) * (c.lat - lat) + (c.lng - lng) * (c.lng - lng);
    if (d < min) {
      min = d;
      best = c;
    }
  });
  return best.city;
}

// 解析当前城市：取经纬度后就近匹配。未授权/失败返回空串。
function resolveCity() {
  return new Promise((resolve) => {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => resolve(nearestCity(res.latitude, res.longitude)),
      fail: () => resolve('')
    });
  });
}

// ============ 约球 ============

// 约球友：邀约列表（附加发布者段位）
function getMatchPosts() {
  if (cloudReady()) {
    return callCloud('getMatchPosts', {}).then((r) => (r && r.matches) || []);
  }
  const matches = mock
    .readArray(mock.KEY_MATCHES)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
  const members = mock.readArray(mock.KEY_MEMBERS);
  const memberMap = {};
  members.forEach((m) => { memberMap[m.openid] = m; });
    const enriched = matches.map((m) => {
      const author = memberMap[m._openid];
      const myLevel = m.myLevel || (author ? author.level : '') || '';
      const targetLevel = m.targetLevel || m.level || (author ? author.level : '') || '';
      return Object.assign({}, m, { myLevel, targetLevel });
    });
  return Promise.resolve(enriched);
}

function createMatchPost({ hallId, hallName, datetime, gameType, note, myLevel, targetLevel, gender, age }) {
  const info = getCurrentUserInfo();
  if (cloudReady()) {
    return callCloud('createMatchPost', {
      hallId,
      hallName,
      datetime,
      gameType,
      note,
      myLevel,
      targetLevel,
      gender,
      age,
      authorName: info.authorName
    });
  }
  const matches = mock.readArray(mock.KEY_MATCHES);
  const id = `mock_m_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  matches.push({
    _id: id,
    _openid: mock.MOCK_OPENID,
    authorName: info.authorName,
    hallId: hallId || '',
    hallName: hallName || '',
    datetime: datetime || '',
    gameType: gameType || '',
    myLevel: myLevel || '',
    targetLevel: targetLevel || '',
    gender: gender || '',
    age: age || '',
    note: note || '',
    joinCount: 0,
    status: 'open',
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_MATCHES, matches);
  return Promise.resolve({ ok: true, id });
}

function joinMatch(matchId) {
  if (cloudReady()) {
    return callCloud('joinMatch', { matchId });
  }
  const joins = mock.readArray(mock.KEY_JOINS);
  if (joins.some((j) => j.matchId === matchId && j._openid === mock.MOCK_OPENID)) {
    const m0 = mock.readArray(mock.KEY_MATCHES).find((x) => x._id === matchId);
    return Promise.resolve({ ok: true, already: true, joinCount: m0 ? m0.joinCount : 0 });
  }
  const matches = mock.readArray(mock.KEY_MATCHES);
  const m = matches.find((x) => x._id === matchId);
  if (m) m.joinCount = (m.joinCount || 0) + 1;
  mock.writeArray(mock.KEY_MATCHES, matches);
  if (m) {
    joins.push({
      _id: `mock_j_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      _openid: mock.MOCK_OPENID,
      matchId,
      authorName: m.authorName,
      hallName: m.hallName,
      datetime: m.datetime,
      gameType: m.gameType,
      createdAt: Date.now()
    });
    mock.writeArray(mock.KEY_JOINS, joins);
  }
  return Promise.resolve({ ok: true, joinCount: m ? m.joinCount : 0 });
}

// 获取某场约球的已报名用户列表
function getMatchJoiners(matchId) {
  if (!matchId) return Promise.resolve([]);
  if (cloudReady()) {
    return callCloud('getMatchJoiners', { matchId }).then((r) => (r && r.joiners) || []);
  }
  const joins = mock.readArray(mock.KEY_JOINS).filter((j) => j.matchId === matchId);
  return Promise.resolve(joins);
}

// 我报名的球局
function getMyJoins() {
  if (cloudReady()) {
    return callCloud('getMyJoins', {}).then((r) => (r && r.joins) || []);
  }
  return Promise.resolve(
    mock
      .readArray(mock.KEY_JOINS)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

function cancelJoin(joinId, matchId) {
  if (cloudReady()) {
    return callCloud('cancelJoin', { joinId, matchId });
  }
  const joins = mock.readArray(mock.KEY_JOINS).filter((j) => j._id !== joinId);
  mock.writeArray(mock.KEY_JOINS, joins);
  const matches = mock.readArray(mock.KEY_MATCHES);
  const m = matches.find((x) => x._id === matchId);
  if (m && m.joinCount > 0) m.joinCount -= 1;
  mock.writeArray(mock.KEY_MATCHES, matches);
  return Promise.resolve({ ok: true });
}

// 教练端：谁约了我（约教练且 targetId 为当前用户）
function getCoachBookings() {
  if (cloudReady()) {
    return callCloud('getCoachBookings', {}).then((r) => (r && r.bookings) || []);
  }
  return Promise.resolve(
    mock
      .readArray(mock.KEY_BOOKINGS)
      .filter(
        (b) =>
          b.type === 'coach' &&
          b.targetId === mock.MOCK_OPENID &&
          b.status !== 'cancelled'
      )
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

// 约教练：可预约教练列表
function getBookableCoaches() {
  if (cloudReady()) {
    return callCloud('getCoaches', {}).then((r) => (r && r.coaches) || []);
  }
  return Promise.resolve(
    mock.readArray(mock.KEY_ALL_COACHES).map((c) => Object.assign({}, c))
  );
}

// 约球桌：可预约球桌（按门店）。合成桌位数量与每小时价格用于演示。
// 优先取该门店的 tableTypes（{name, pricePerHour} 对象数组），否则用 stores 默认值。
function getBookableTables() {
  const synth = {
    hall_01: { tableCount: 12 },
    hall_02: { tableCount: 8 },
    hall_03: { tableCount: 6 }
  };
  const defaultTypes = [{ name: '乔氏金腿', pricePerHour: 78 }, { name: '乔氏银腿', pricePerHour: 68 }];
  const fallbackStores = [
    { _id: 'hall_01', brandId: 'brand_01', name: '大川激流·旗舰店', address: '城市中心广场 3F', cover: '', tableTypes: [{ name: '乔氏金腿', pricePerHour: 78 }, { name: '乔氏银腿', pricePerHour: 68 }, { name: '美洲豹', pricePerHour: 58 }] },
    { _id: 'hall_02', brandId: 'brand_01', name: '大川激流·滨江店', address: '滨江路 88 号', cover: '', tableTypes: [{ name: '乔氏金腿', pricePerHour: 78 }, { name: '乔氏银腿', pricePerHour: 68 }] },
    { _id: 'hall_03', brandId: 'brand_02', name: '星河台球俱乐部', address: '高新区软件园', cover: '', tableTypes: [{ name: '星牌钢库', pricePerHour: 48 }, { name: '星牌木库', pricePerHour: 38 }] }
  ];
  return getStores().then((stores) => {
    const storesToUse = stores.length ? stores : fallbackStores;
    return storesToUse.map((s) => {
      const base = synth[s._id] || { tableCount: 8 };
      const hallShopTableTypes = (s.tableTypes && s.tableTypes.length) ? s.tableTypes : defaultTypes;
      return Object.assign({}, s, base, { tableTypes: hallShopTableTypes });
    });
  });
}

// 我的预约（约教练 / 约球桌），按时间倒序
function getMyBookings() {
  if (cloudReady()) {
    return callCloud('getMyBookings', {}).then((r) => (r && r.bookings) || []);
  }
  return Promise.resolve(
    mock
      .readArray(mock.KEY_BOOKINGS)
      .filter((b) => b.status !== 'cancelled')
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

function cancelBooking(id) {
  if (cloudReady()) {
    return callCloud('cancelBooking', { id });
  }
  const bookings = mock.readArray(mock.KEY_BOOKINGS).filter((b) => b._id !== id);
  mock.writeArray(mock.KEY_BOOKINGS, bookings);
  return Promise.resolve({ ok: true });
}

// 我发布的约球邀约
function getMyMatches() {
  if (cloudReady()) {
    return callCloud('getMyMatches', {}).then((r) => (r && r.matches) || []);
  }
  return Promise.resolve(
    mock
      .readArray(mock.KEY_MATCHES)
      .filter((m) => m._openid === mock.MOCK_OPENID)
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

function cancelMatch(id) {
  if (cloudReady()) {
    return callCloud('cancelMatch', { id });
  }
  const matches = mock.readArray(mock.KEY_MATCHES).filter((m) => m._id !== id);
  mock.writeArray(mock.KEY_MATCHES, matches);
  return Promise.resolve({ ok: true });
}

// 创建预约（约教练 / 约球桌）
function createBooking({ type, targetId, targetName, hallName, datetime, note, price, tableType }) {
  const info = getCurrentUserInfo();
  if (cloudReady()) {
    return callCloud('createBooking', {
      type,
      targetId,
      targetName,
      hallName,
      datetime,
      note,
      price,
      tableType: tableType || '',
      bookerName: info.authorName
    });
  }
  const bookings = mock.readArray(mock.KEY_BOOKINGS);
  const id = `mock_b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  bookings.push({
    _id: id,
    _openid: mock.MOCK_OPENID,
    bookerName: info.authorName,
    type,
    targetId: targetId || '',
    targetName: targetName || '',
    hallName: hallName || '',
    datetime: datetime || '',
    note: note || '',
    price: price || 0,
    tableType: tableType || '',
    status: 'pending',
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_BOOKINGS, bookings);
  return Promise.resolve({ ok: true, id });
}

function getPostDetail(postId) {
  if (cloudReady()) {
    return callCloud('getPostDetail', { postId }).then((r) => r || { post: null });
  }
  const post = mock.readArray(mock.KEY_POSTS).find((p) => p._id === postId) || null;
  const liked = mock
    .readArray(mock.KEY_POST_LIKES)
    .some((l) => l.postId === postId && l._openid === mock.MOCK_OPENID);
  const comments = mock
    .readArray(mock.KEY_COMMENTS)
    .filter((c) => c.postId === postId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const following = post
    ? mock.readArray(mock.KEY_FOLLOWS).indexOf(post._openid) !== -1
    : false;
  return Promise.resolve({ post, liked, comments, following });
}

function createPost({ type, title, content, images, video, cover }) {
  const info = getCurrentUserInfo();
  if (cloudReady()) {
    return callCloud('createPost', {
      type,
      title,
      content,
      images,
      video,
      cover,
      authorName: info.authorName,
      authorAvatar: info.authorAvatar
    });
  }
  const posts = mock.readArray(mock.KEY_POSTS);
  const id = `mock_p_${Date.now()}`;
  posts.push({
    _id: id,
    _openid: mock.MOCK_OPENID,
    authorName: info.authorName,
    authorAvatar: info.authorAvatar,
    type: type || (video ? 'video' : 'image'),
    title: title || '',
    content: content || '',
    images: images || [],
    video: video || '',
    cover: cover || (images && images[0]) || '',
    likeCount: 0,
    commentCount: 0,
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_POSTS, posts);
  return Promise.resolve({ ok: true, id });
}

function toggleLike(postId) {
  if (cloudReady()) {
    return callCloud('toggleLike', { postId });
  }
  const likes = mock.readArray(mock.KEY_POST_LIKES);
  const posts = mock.readArray(mock.KEY_POSTS);
  const post = posts.find((p) => p._id === postId);
  const idx = likes.findIndex((l) => l.postId === postId && l._openid === mock.MOCK_OPENID);
  let liked;
  if (idx !== -1) {
    likes.splice(idx, 1);
    if (post) post.likeCount = Math.max(0, (post.likeCount || 0) - 1);
    liked = false;
  } else {
    likes.push({ _openid: mock.MOCK_OPENID, postId, createdAt: Date.now() });
    if (post) post.likeCount = (post.likeCount || 0) + 1;
    liked = true;
  }
  mock.writeArray(mock.KEY_POST_LIKES, likes);
  mock.writeArray(mock.KEY_POSTS, posts);
  return Promise.resolve({ ok: true, liked, likeCount: post ? post.likeCount : 0 });
}

function addComment(postId, content) {
  const info = getCurrentUserInfo();
  if (cloudReady()) {
    return callCloud('addComment', {
      postId,
      content,
      authorName: info.authorName,
      authorAvatar: info.authorAvatar
    });
  }
  const comments = mock.readArray(mock.KEY_COMMENTS);
  const id = `mock_c_${Date.now()}`;
  comments.push({
    _id: id,
    _openid: mock.MOCK_OPENID,
    postId,
    content,
    authorName: info.authorName,
    authorAvatar: info.authorAvatar,
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_COMMENTS, comments);
  const posts = mock.readArray(mock.KEY_POSTS);
  const post = posts.find((p) => p._id === postId);
  if (post) post.commentCount = (post.commentCount || 0) + 1;
  mock.writeArray(mock.KEY_POSTS, posts);
  return Promise.resolve({ ok: true, id });
}

module.exports = {
  initData,
  login,
  getUserProfile,
  getUserProfile,
  saveUserProfile,
  getHalls,
  getHeatmap,
  getDayDetail,
  addTraining,
  getRole,
  setRole,
  getCoachProfile,
  getCoachProfileByOpenid,
  getMemberProfileByOpenid,
  getMemberCheckins,
  getMemberCheckinsByOpenid,
  saveCoachProfile,
  getMyMembers,
  getLinkableMembers,
  linkMember,
  getShopProfile,
  saveShopProfile,
  getBrands,
  saveShopBrand,
  getShopBrands,
  getStores,
  saveShopStore,
  getShopStores,
  getSessions,
  createSession,
  closeSession,
  getMembers,
  getShopCoaches,
  getLinkableCoaches,
  addShopCoach,
  removeShopCoach,
  getCoachStudents,
  getShopMembers,
  uploadImage,
  uploadFile,
  getFeed,
  getPostDetail,
  createPost,
  toggleLike,
  addComment,
  getFollows,
  toggleFollow,
  resolveCity,
  getMatchPosts,
  createMatchPost,
  getMatchJoiners,
  joinMatch,
  getBookableCoaches,
  getBookableTables,
  createBooking,
  getMyBookings,
  cancelBooking,
  getMyMatches,
  cancelMatch,
  getMyJoins,
  cancelJoin,
  getCoachBookings
};
