// 数据服务层：统一对外暴露 Promise 接口。
// 若已配置并初始化云开发环境，则走云函数；否则自动回退到本地 mock 数据。
// 这样在没有云环境时也能在开发者工具中端到端演示。

const mock = require('../utils/mock');
const { levelFromMinutes } = require('../utils/color');
const billing = require('../utils/billing');
const adminAuth = require('../utils/adminAuth');

function cloudReady() {
  // onLaunch 期间 getApp() 可能尚未就绪，访问 .globalData 会抛 TypeError。
  // 任何一个环节为空都按"未就绪"处理，由调用方决定走 mock 兜底。
  const app = typeof getApp === 'function' ? getApp() : null;
  return !!(app && app.globalData && app.globalData.cloudReady && wx.cloud);
}

function callCloud(name, data) {
  console.warn('[cloud] calling:', name);
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
  if (r.firstLoginAt) app.globalData.firstLoginAt = r.firstLoginAt;
  if (r.plan) app.globalData.plan = r.plan;
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

function saveUserProfile({
  nickname,
  avatar,
  gender,
  birthDate,
  phone,
  locationCity,
  hometown,
  years,
  level,
  canSeeGender,
  canSeeBirthDate,
  canSeeHometown,
  canSeePhone
}) {
  if (cloudReady()) {
    return callCloud('saveUserProfile', {
      nickname,
      avatar,
      gender,
      birthDate,
      phone,
      locationCity,
      hometown,
      years,
      level,
      canSeeGender,
      canSeeBirthDate,
      canSeeHometown,
      canSeePhone
    });
  }
  const key = 'dc_user_profile';
  const existing = mock.readObject(key, null) || {};
  const updated = Object.assign({}, existing, {
    nickname,
    avatar,
    gender,
    birthDate,
    phone,
    locationCity,
    hometown,
    years,
    level,
    canSeeGender,
    canSeeBirthDate,
    canSeeHometown,
    canSeePhone
  });
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
    if (!map[s.date]) map[s.date] = { date: s.date, totalMinutes: 0, sessionCount: 0, personalMinutes: 0, coachMinutes: 0, verifiedCount: 0, unverifiedCount: 0 };
    map[s.date].totalMinutes += s.durationMinutes || 0;
    map[s.date].personalMinutes += s.durationMinutes || 0;
    map[s.date].sessionCount += 1;
    if (s.verified) map[s.date].verifiedCount += 1;
    else map[s.date].unverifiedCount += 1;
  });

  // 教练查看自己的杆迹时：叠加「以教练身份计时」的课时（金色），与自主练球/客场打球（蓝色）并存。
  // 同一天若两种身份都有计时，总时长统一以金色表示（金 > 蓝优先级）。
  const asCoachOwn = !targetOpenid && mock.getRole() === 'coach';
  if (asCoachOwn) {
    mock.readArray(KEY_COACH_LESSONS)
      .filter((l) => l.coachOpenid === ownerOpenid && l.date >= startKey && l.date <= endKey)
      .forEach((l) => {
        if (!map[l.date]) map[l.date] = { date: l.date, totalMinutes: 0, sessionCount: 0, personalMinutes: 0, coachMinutes: 0, verifiedCount: 0, unverifiedCount: 0 };
        map[l.date].totalMinutes += l.durationMinutes || 0;
        map[l.date].coachMinutes += l.durationMinutes || 0;
        map[l.date].sessionCount += 1;
        map[l.date].verifiedCount += 1;
      });
  }

  const stats = Object.keys(map).map((k) => {
    const item = map[k];
    item.level = levelFromMinutes(item.totalMinutes);
    item.hasVerified = item.verifiedCount > 0;
    if (asCoachOwn) item.kind = item.coachMinutes > 0 ? 'coach' : 'personal';
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
    .filter((s) => s._openid === ownerOpenid && s.date === dateKey);

  // 教练查看自己当日明细：把「教练身份」的课时也列出来（标记 kind:'coach'），与杆迹热力图一致
  const asCoachOwn = !targetOpenid && mock.getRole() === 'coach';
  let rows = sessions.map((s) => Object.assign({ kind: 'personal' }, s));
  if (asCoachOwn) {
    const lessons = mock.readArray(KEY_COACH_LESSONS)
      .filter((l) => l.coachOpenid === ownerOpenid && l.date === dateKey)
      .map((l) => ({
        _id: l._id,
        hallName: l.hallName || '教学课时',
        startTime: l.startTime || '',
        durationMinutes: l.durationMinutes || 0,
        verified: true,
        kind: 'coach',
        memberNickname: l.memberNickname || ''
      }));
    rows = rows.concat(lessons);
  }
  rows.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  return Promise.resolve(rows);
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
    verified: false,
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

// 解析"账号编码 / 二维码内容 / 原始 openid"为账号对象 { openid, role, nickname, avatar, source }。
// 供「扫码添加」与「手动输入编码添加」统一落地。mock 下在本地集合（教练/会员/当前用户）中按
// openid 或编码反查；云端模式下若本地查不到，则把原始串当作 openid 透传给云函数处理。
function resolveAccount(input) {
  const account = require('../utils/account');
  const parsed = account.parse(input);
  if (!parsed) return Promise.resolve(null);

  const lookupLocal = (openid, code) => {
    const coaches = mock.readArray(mock.KEY_ALL_COACHES);
    const members = mock.readArray(mock.KEY_MEMBERS);
    let hit = null;
    let role = '';
    if (openid) {
      hit = coaches.find((c) => c.openid === openid);
      if (hit) role = 'coach';
      if (!hit) { hit = members.find((m) => m.openid === openid); if (hit) role = 'member'; }
    }
    if (!hit && code) {
      hit = coaches.find((c) => account.codeOf(c.openid) === code);
      if (hit) role = 'coach';
      if (!hit) { hit = members.find((m) => account.codeOf(m.openid) === code); if (hit) role = 'member'; }
    }
    if (hit) {
      return { openid: hit.openid, role, nickname: hit.nickname || '', avatar: hit.avatar || mock.avatarFor(hit.openid) };
    }
    // 兜底：当前演示用户自身（单账号演示下扫到自己的码）
    if ((openid && openid === mock.MOCK_OPENID) || (code && account.codeOf(mock.MOCK_OPENID) === code)) {
      const app = getApp();
      const prof = (app && app.globalData && app.globalData.userProfile) || {};
      return { openid: mock.MOCK_OPENID, role: mock.getRole(), nickname: prof.nickname || '大川会员', avatar: prof.avatar || '' };
    }
    return null;
  };

  if (parsed.source === 'qr') {
    const local = lookupLocal(parsed.openid, parsed.code);
    return Promise.resolve({
      openid: parsed.openid,
      role: parsed.role || (local && local.role) || '',
      nickname: parsed.name || (local && local.nickname) || '',
      avatar: (local && local.avatar) || mock.avatarFor(parsed.openid),
      source: 'qr'
    });
  }

  // 文本：编码反查 → 原始 openid 反查 → 云端透传
  const local = lookupLocal('', parsed.code) || lookupLocal(parsed.raw, '');
  if (local) return Promise.resolve(Object.assign({ source: 'text' }, local));
  if (cloudReady()) {
    return Promise.resolve({ openid: parsed.raw, role: '', nickname: '', avatar: '', source: 'text' });
  }
  return Promise.resolve(null);
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

// ============ 店主资质审核（营业执照） ============

// 提交 / 重新提交店主资质申请（营业执照 + 关键字段）。状态置为 pending。
function submitShopApplication({ ownerPhone, ownerWechat, ownerQQ, ownerEmail, licenseFileID }) {
  if (cloudReady()) {
    return callCloud('submitShopApplication', { ownerPhone, ownerWechat, ownerQQ, ownerEmail, licenseFileID });
  }
  const owner = mock.MOCK_OPENID;
  const list = mock.readArray(mock.KEY_SHOP_APPLICATIONS);
  const now = Date.now();
  const idx = list.findIndex((a) => a._openid === owner);
  const record = {
    _id: idx !== -1 ? list[idx]._id : 'app_' + now,
    _openid: owner,
    ownerPhone: ownerPhone || '',
    ownerWechat: ownerWechat || '',
    ownerQQ: ownerQQ || '',
    ownerEmail: ownerEmail || '',
    licenseFileID: licenseFileID || '',
    status: 'pending',
    reason: '',
    createdAt: idx !== -1 ? list[idx].createdAt : now,
    updatedAt: now
  };
  if (idx !== -1) list[idx] = record;
  else list.push(record);
  mock.writeArray(mock.KEY_SHOP_APPLICATIONS, list);
  return Promise.resolve({ ok: true, status: 'pending', _id: record._id });
}

// 查询当前用户店主资质状态：'none' | 'pending' | 'approved' | 'rejected'
// 老店主豁免：已有店铺资料(KEY_SHOP) 但无申请记录 → 视为 approved。
function getShopApplicationStatus() {
  if (cloudReady()) {
    return callCloud('getShopApplicationStatus', {}).then((r) => r || { status: 'none', application: null });
  }
  const owner = mock.MOCK_OPENID;
  const list = mock.readArray(mock.KEY_SHOP_APPLICATIONS);
  const app = list.find((a) => a._openid === owner);
  if (app) return Promise.resolve({ status: app.status || 'pending', application: app });
  const shop = mock.readObject(mock.KEY_SHOP, null);
  if (shop && shop._openid === owner) return Promise.resolve({ status: 'approved', application: null, legacy: true });
  return Promise.resolve({ status: 'none', application: null });
}

function getAdminStatus() {
  if (cloudReady()) {
    return callCloud('getAdminStatus', {}).then((r) => r || { ok: true, isAdmin: false });
  }
  const app = getApp();
  const openid = (app && app.globalData && app.globalData.openid) || mock.MOCK_OPENID;
  const admins = mock.readArray(mock.KEY_ADMINS);
  const bootstrapOpenids = [mock.MOCK_OPENID].concat(adminAuth.BOOTSTRAP_ADMIN_OPENIDS);
  const isAdmin = adminAuth.canAdmin(openid, admins, bootstrapOpenids);
  return Promise.resolve({
    ok: true,
    isAdmin,
    bootstrap: adminAuth.shouldBootstrapAdmin(openid, admins, bootstrapOpenids)
  });
}

// 管理员：拉取资质申请列表。status: 'pending'(默认) | 'approved' | 'rejected' | 'all'
function getPendingShopApplications(status = 'pending') {
  if (cloudReady()) {
    return callCloud('getPendingShopApplications', { status }).then((r) => {
      // 服务端白名单拒绝时抛出 FORBIDDEN，供页面区分「无权限」与「空队列」
      if (r && r.ok === false && r.code === 'FORBIDDEN') {
        const e = new Error('FORBIDDEN');
        e.code = 'FORBIDDEN';
        throw e;
      }
      return (r && r.applications) || [];
    });
  }
  const list = mock.readArray(mock.KEY_SHOP_APPLICATIONS).slice();
  const filtered = status === 'all' ? list : list.filter((a) => (a.status || 'pending') === status);
  return Promise.resolve(filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
}

// 管理员：审核（approve=true 通过 / false 驳回；驳回写 reason）
function reviewShopApplication({ applicationId, approve, reason }) {
  if (cloudReady()) {
    return callCloud('reviewShopApplication', { applicationId, approve, reason });
  }
  const list = mock.readArray(mock.KEY_SHOP_APPLICATIONS);
  const idx = list.findIndex((a) => a._id === applicationId);
  if (idx === -1) return Promise.resolve({ ok: false, msg: '申请不存在' });
  list[idx] = Object.assign({}, list[idx], {
    status: approve ? 'approved' : 'rejected',
    reason: approve ? '' : (reason || '资料未通过核验'),
    reviewedAt: Date.now()
  });
  mock.writeArray(mock.KEY_SHOP_APPLICATIONS, list);
  return Promise.resolve({ ok: true, status: approve ? 'approved' : 'rejected' });
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

// 开桌：支持绑定到店球员 memberOpenid、教学局教练 coachOpenid、门店 storeId、是否已核验 verified。
// hall-status.computeStatus 读取这些字段渲染占用卡（球员/教练头像、助教时长）。
function createSession({ tableId, storeId, memberOpenid, coachOpenid, coachJoinedAt, verified }) {
  if (cloudReady()) {
    return callCloud('createSession', { tableId, storeId, memberOpenid, coachOpenid, coachJoinedAt, verified });
  }
  const sessions = mock.readArray(mock.KEY_SESSIONS);
  const now = Date.now();
  const sid = `mock_s_${now}`;
  sessions.push({
    _id: sid,
    _openid: mock.MOCK_OPENID,
    tableId,
    storeId: storeId || '',
    memberOpenid: memberOpenid || '',
    coachOpenid: coachOpenid || '',
    coachJoinedAt: coachOpenid ? (coachJoinedAt || now) : null,
    verified: !!verified,
    status: 'active',
    startedAt: now,
    createdAt: now
  });
  mock.writeArray(mock.KEY_SESSIONS, sessions);
  return Promise.resolve({ ok: true, sessionId: sid });
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

// ============ 到店打卡核验（B：扫码/选店到店 → 前台确认 → 绑定开台） ============
// 演示阶段 mock 落本地 'dc_checkin_requests'；接真实云端改 callCloud（云函数待部署）。
const KEY_CHECKIN = 'dc_checkin_requests';
const KEY_COACH_LESSONS = 'dc_coach_lessons';
const KEY_COACH_SETTLEMENTS = 'dc_coach_settlements';

function _currentOpenid() {
  const app = getApp();
  return (app && app.globalData && app.globalData.openid) || mock.MOCK_OPENID;
}

// 球员到店：发起待前台确认的到店请求。lat/lng/dist 供"在店内"距离核验留痕。
function requestCheckin({ storeId, storeName, tableId, tableName, nickname, avatar, lat, lng, dist }) {
  const me = _currentOpenid();
  const record = {
    _id: `ci_${Date.now()}`,
    storeId: storeId || '',
    storeName: storeName || '',
    tableId: tableId || '',
    tableName: tableName || '',
    memberOpenid: me,
    nickname: nickname || '',
    avatar: avatar || '',
    lat: typeof lat === 'number' ? lat : null,
    lng: typeof lng === 'number' ? lng : null,
    dist: typeof dist === 'number' ? dist : null,
    status: 'pending',
    createdAt: Date.now()
  };
  if (cloudReady()) {
    return callCloud('requestCheckin', record).then((r) => r || { ok: true, request: record });
  }
  const arr = mock.readArray(KEY_CHECKIN);
  // 同一球员对同一门店仅保留一条 pending（重复发起覆盖）
  const kept = arr.filter((x) => !(x.memberOpenid === me && x.storeId === record.storeId && x.status === 'pending'));
  kept.push(record);
  mock.writeArray(KEY_CHECKIN, kept);
  return Promise.resolve({ ok: true, request: record });
}

// 前台：拉取本店待确认的到店请求队列
function getPendingCheckins(storeId) {
  if (cloudReady()) {
    return callCloud('getPendingCheckins', { storeId }).then((r) => (r && r.requests) || []);
  }
  const arr = mock.readArray(KEY_CHECKIN)
    .filter((x) => x.status === 'pending' && (!storeId || x.storeId === storeId))
    .sort((a, b) => a.createdAt - b.createdAt);
  return Promise.resolve(arr);
}

// 前台：确认 / 拒绝某条到店请求（action: 'confirm' | 'reject'）
function resolveCheckin(requestId, action) {
  if (cloudReady()) {
    return callCloud('resolveCheckin', { requestId, action });
  }
  const arr = mock.readArray(KEY_CHECKIN);
  const idx = arr.findIndex((x) => x._id === requestId);
  if (idx !== -1) {
    arr[idx].status = action === 'reject' ? 'rejected' : 'confirmed';
    arr[idx].resolvedAt = Date.now();
    mock.writeArray(KEY_CHECKIN, arr);
  }
  return Promise.resolve({ ok: true });
}

// 球员：查询自己在某门店最近一条到店请求状态（pending/confirmed/rejected/none）
function getMyCheckinStatus(storeId) {
  const me = _currentOpenid();
  if (cloudReady()) {
    return callCloud('getMyCheckinStatus', { storeId }).then((r) => (r && r.status) || 'none');
  }
  const list = mock.readArray(KEY_CHECKIN)
    .filter((x) => x.memberOpenid === me && (!storeId || x.storeId === storeId))
    .sort((a, b) => b.createdAt - a.createdAt);
  return Promise.resolve(list.length ? list[0].status : 'none');
}

// ============ 结账同步（C：球桌实测时长 → 球员已核验训练 + 教练课时） ============
// durationMinutes 由调用方按分钟算好。memberOpenid 必填，coachOpenid 可选（教学局）。
function recordVerifiedTraining({ memberOpenid, memberNickname, coachOpenid, coachNickname, hallId, hallName, storeId, durationMinutes, amount }) {
  const mins = Math.round(Number(durationMinutes) || 0);
  if (!memberOpenid || mins <= 0) return Promise.resolve({ ok: false });
  const now = new Date();
  const date = _todayKey();
  const hh = now.getHours();
  const mm = now.getMinutes();
  const startTime = (hh < 10 ? '0' + hh : '' + hh) + ':' + (mm < 10 ? '0' + mm : '' + mm);
  if (cloudReady()) {
    return callCloud('recordVerifiedTraining', {
      memberOpenid, memberNickname, coachOpenid, coachNickname,
      hallId: hallId || storeId, hallName, date, startTime, durationMinutes: mins, amount
    });
  }
  // 1) 球员"已核验"训练记录（进热力图 / 杆迹 / 我的）
  const sessions = mock.readArray(mock.KEY_SESSIONS);
  sessions.push({
    _id: `mock_t_${Date.now()}`,
    _openid: memberOpenid,
    hallId: hallId || storeId || '',
    hallName: hallName || '',
    date,
    startTime,
    durationMinutes: mins,
    verified: true,
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_SESSIONS, sessions);
  // 2) 教学局：教练课时记录
  if (coachOpenid) {
    const lessons = mock.readArray(KEY_COACH_LESSONS);
    lessons.push({
      _id: `mock_l_${Date.now()}`,
      coachOpenid,
      coachNickname: coachNickname || '',
      memberOpenid,
      memberNickname: memberNickname || '',
      hallId: hallId || storeId || '',
      hallName: hallName || '',
      date,
      durationMinutes: mins,
      amount: Number(amount) || 0,
      verified: true,
      createdAt: Date.now()
    });
    mock.writeArray(KEY_COACH_LESSONS, lessons);
  }
  return Promise.resolve({ ok: true });
}

// 生成门店"到店码"（小程序码，scene=s=<storeId>）。
// 云端走 genCheckinCode 云函数（wxacode.getUnlimited，需部署 + 真云环境）；
// mock/未部署返回空串，页面用 payload 文本 + 占位兜底。
function genStoreCheckinCode(storeId) {
  if (cloudReady()) {
    return callCloud('genCheckinCode', { storeId }).then((r) => (r && (r.fileID || r.image)) || '');
  }
  return Promise.resolve('');
}

// 教练课时列表（默认当前用户；演示单账号下亦可传指定 coachOpenid）
function getCoachLessons(coachOpenid) {
  const who = coachOpenid || _currentOpenid();
  if (cloudReady()) {
    return callCloud('getCoachLessons', { coachOpenid }).then((r) => (r && r.lessons) || []);
  }
  const all = mock.readArray(KEY_COACH_LESSONS).sort((a, b) => b.createdAt - a.createdAt);
  const mine = all.filter((x) => x.coachOpenid === who);
  // 演示为单账号（openid 恒为 local-demo-user），教学局里选的教练是 coach_xx，
  // 与当前 openid 不一致会看不到课时；mock 下若本人无匹配则回退展示全部，便于验收 D 期。
  return Promise.resolve(mine.length ? mine : all);
}

// ============ 教练结算（店主结算本店教练课时费） ============

function _fmtKey(d) { const m = d.getMonth() + 1, day = d.getDate(); return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day); }
// 周期 → 日期区间（含端点）。week=本周一~今天；month=本月1号~今天；all=不限
function _periodRange(period) {
  const end = new Date(); end.setHours(0, 0, 0, 0);
  if (period === 'all') return { fromKey: '', toKey: '' };
  if (period === 'week') {
    const day = end.getDay(); const back = day === 0 ? 6 : day - 1;
    const from = new Date(end.getTime()); from.setDate(end.getDate() - back);
    return { fromKey: _fmtKey(from), toKey: _fmtKey(end) };
  }
  const from = new Date(end.getFullYear(), end.getMonth(), 1);
  return { fromKey: _fmtKey(from), toKey: _fmtKey(end) };
}
function _inPeriod(date, range) { if (!range.fromKey) return true; return date >= range.fromKey && date <= range.toKey; }
// 本店归属：本店教练 openid 集合 + 本店门店 _id 集合
function _shopScope() {
  const shop = mock.readObject(mock.KEY_SHOP, null) || {};
  const coachOpenids = mock.readArray(mock.KEY_SHOP_COACHES).map((l) => l.coachOpenid);
  const storeIds = mock.readArray(mock.KEY_STORES).map((s) => s._id);
  if (shop.storeId && storeIds.indexOf(shop.storeId) === -1) storeIds.push(shop.storeId);
  return { coachOpenids, storeIds };
}
const _r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// 店主端：本店各教练在指定周期的结算概览
function getShopCoachSettlement(period) {
  if (cloudReady()) return callCloud('getShopCoachSettlement', { period }).then((r) => r || { totalPendingNet: 0, pendingCoachCount: 0, coaches: [] });
  const range = _periodRange(period);
  const { coachOpenids, storeIds } = _shopScope();
  const lessons = mock.readArray(KEY_COACH_LESSONS).filter((l) =>
    coachOpenids.indexOf(l.coachOpenid) !== -1 && storeIds.indexOf(l.hallId) !== -1 && _inPeriod(l.date, range));
  const allCoaches = mock.readArray(mock.KEY_ALL_COACHES);
  const agg = {};
  lessons.forEach((l) => {
    if (!agg[l.coachOpenid]) agg[l.coachOpenid] = { pendingGross: 0, pendingCount: 0, settledGross: 0 };
    const a = Number(l.amount) || 0;
    if (l.settled) agg[l.coachOpenid].settledGross += a;
    else { agg[l.coachOpenid].pendingGross += a; agg[l.coachOpenid].pendingCount += 1; }
  });
  let totalPendingNet = 0, pendingCoachCount = 0;
  const coaches = coachOpenids.map((openid) => {
    const g = agg[openid] || { pendingGross: 0, pendingCount: 0, settledGross: 0 };
    const c = allCoaches.find((x) => x.openid === openid) || {};
    const pendingCommission = billing.calcCoachCommission(g.pendingGross);
    const pendingNet = _r2(g.pendingGross - pendingCommission);
    const settledNet = _r2(g.settledGross - billing.calcCoachCommission(g.settledGross));
    if (g.pendingCount > 0) { totalPendingNet += pendingNet; pendingCoachCount += 1; }
    return { coachOpenid: openid, nickname: c.nickname || '教练', avatar: c.avatar || mock.avatarFor(openid),
      pendingCount: g.pendingCount, pendingGross: g.pendingGross, pendingCommission, pendingNet, settledNet };
  }).sort((a, b) => b.pendingNet - a.pendingNet || b.settledNet - a.settledNet);
  return Promise.resolve({ totalPendingNet: _r2(totalPendingNet), pendingCoachCount, coaches });
}

// 店主端：单个教练在指定周期的结算明细（待/已结算课时 + 待结算汇总）
function getCoachSettlementDetail(coachOpenid, period) {
  if (cloudReady()) return callCloud('getCoachSettlementDetail', { coachOpenid, period }).then((r) => r || { pending: [], settled: [], summary: { gross: 0, commission: 0, net: 0 } });
  const range = _periodRange(period);
  const { storeIds } = _shopScope();
  const lessons = mock.readArray(KEY_COACH_LESSONS)
    .filter((l) => l.coachOpenid === coachOpenid && storeIds.indexOf(l.hallId) !== -1 && _inPeriod(l.date, range))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const pending = lessons.filter((l) => !l.settled);
  const settled = lessons.filter((l) => l.settled);
  const gross = pending.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const commission = billing.calcCoachCommission(gross);
  const c = mock.readArray(mock.KEY_ALL_COACHES).find((x) => x.openid === coachOpenid) || {};
  return Promise.resolve({ coachOpenid, nickname: c.nickname || '教练', summary: { gross, commission, net: _r2(gross - commission) }, pending, settled });
}

// 店主端：结清某教练当前周期的待结算课时（标记 settled + 写一笔结算流水）。幂等。
function settleCoach(coachOpenid, period) {
  if (cloudReady()) return callCloud('settleCoach', { coachOpenid, period });
  const range = _periodRange(period);
  const { storeIds } = _shopScope();
  const all = mock.readArray(KEY_COACH_LESSONS);
  const targets = all.filter((l) => l.coachOpenid === coachOpenid && !l.settled && storeIds.indexOf(l.hallId) !== -1 && _inPeriod(l.date, range));
  if (!targets.length) return Promise.resolve({ ok: false, msg: '无待结算课时' });
  const gross = targets.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const commission = billing.calcCoachCommission(gross);
  const net = _r2(gross - commission);
  const c = mock.readArray(mock.KEY_ALL_COACHES).find((x) => x.openid === coachOpenid) || {};
  const settlementId = `stl_${Date.now()}`;
  const now = Date.now();
  const settlements = mock.readArray(mock.KEY_COACH_SETTLEMENTS);
  settlements.push({ _id: settlementId, shopOpenid: mock.MOCK_OPENID, coachOpenid, coachNickname: c.nickname || '教练',
    lessonCount: targets.length, grossAmount: gross, commission, netAmount: net, periodFrom: range.fromKey, periodTo: range.toKey, createdAt: now });
  mock.writeArray(mock.KEY_COACH_SETTLEMENTS, settlements);
  const ids = {}; targets.forEach((t) => { ids[t._id] = true; });
  all.forEach((l) => { if (ids[l._id]) { l.settled = true; l.settledAt = now; l.settlementId = settlementId; } });
  mock.writeArray(KEY_COACH_LESSONS, all);
  return Promise.resolve({ ok: true, netAmount: net, lessonCount: targets.length });
}

// ============ 经营数据看板（今日快照 + 近 rangeDays 天关键数 + 营收按天趋势） ============

function _emptyBiz(days) {
  const dates = []; const base = new Date(); base.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) { const d = new Date(base.getTime()); d.setDate(base.getDate() - i); dates.push(_fmtKey(d)); }
  return { today: { revenue: 0, opens: 0, activeMembers: 0, lessons: 0 }, range: { revenue: 0, opens: 0, activeMembers: 0, lessons: 0 }, trend: dates.map((d) => ({ date: d, revenue: 0 })) };
}

function getShopBizOverview(rangeDays) {
  const days = rangeDays === 30 ? 30 : 7;
  if (cloudReady()) return callCloud('getShopBizOverview', { rangeDays: days }).then((r) => r || _emptyBiz(days));
  const base = new Date(); base.setHours(0, 0, 0, 0);
  const todayKey = _fmtKey(base);
  const dates = [];
  for (let i = days - 1; i >= 0; i--) { const d = new Date(base.getTime()); d.setDate(base.getDate() - i); dates.push(_fmtKey(d)); }
  const fromKey = dates[0];
  const inR = (dk) => dk >= fromKey && dk <= todayKey;
  const { coachOpenids, storeIds } = _shopScope();
  const memberOpenids = mock.readArray(mock.KEY_MEMBERS).map((m) => m.openid);

  const byDay = {};
  let revenue = 0, opens = 0, todayRevenue = 0, todayOpens = 0;
  mock.readArray('dc_shop_orders').forEach((o) => {
    if (!inR(o.date)) return;
    const a = Number(o.amount) || 0;
    revenue += a; opens += 1; byDay[o.date] = (byDay[o.date] || 0) + a;
    if (o.date === todayKey) { todayRevenue += a; todayOpens += 1; }
  });
  const trend = dates.map((d) => ({ date: d, revenue: Math.round(byDay[d] || 0) }));

  const memSet = {}, memTodaySet = {};
  mock.readArray(mock.KEY_SESSIONS).forEach((s) => {
    if (!inR(s.date) || storeIds.indexOf(s.hallId) === -1 || memberOpenids.indexOf(s._openid) === -1) return;
    memSet[s._openid] = 1; if (s.date === todayKey) memTodaySet[s._openid] = 1;
  });

  let lessons = 0, todayLessons = 0;
  mock.readArray(KEY_COACH_LESSONS).forEach((l) => {
    if (!inR(l.date) || coachOpenids.indexOf(l.coachOpenid) === -1 || storeIds.indexOf(l.hallId) === -1) return;
    lessons += 1; if (l.date === todayKey) todayLessons += 1;
  });

  return Promise.resolve({
    today: { revenue: Math.round(todayRevenue), opens: todayOpens, activeMembers: Object.keys(memTodaySet).length, lessons: todayLessons },
    range: { revenue: Math.round(revenue), opens, activeMembers: Object.keys(memSet).length, lessons },
    trend
  });
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

  // 合并店主手动添加（扫码 / 输入编码）的会员：本店尚无训练记录时也应出现，统计计为 0
  mock.readArray(mock.KEY_SHOP_MEMBERS)
    .filter((l) => l.memberOpenid && (!l.storeId || l.storeId === targetStoreId))
    .forEach((l) => {
      if (!agg[l.memberOpenid]) agg[l.memberOpenid] = { totalMinutes: 0, days: {} };
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

// 店主手动添加会员（扫码 / 输入编码后落地）。mock 写 KEY_SHOP_MEMBERS 关系表（按门店）。
function addShopMember(memberOpenid, storeId) {
  if (!memberOpenid) return Promise.resolve({ ok: false, msg: '无效会员' });
  if (cloudReady()) {
    return callCloud('addShopMember', { memberOpenid, storeId });
  }
  const shop = mock.readObject(mock.KEY_SHOP, null);
  const sid = storeId || (shop && shop.storeId) || '';
  const links = mock.readArray(mock.KEY_SHOP_MEMBERS);
  if (links.some((l) => l.memberOpenid === memberOpenid && (l.storeId || '') === sid)) {
    return Promise.resolve({ ok: true, msg: '已添加' });
  }
  links.push({ shopOpenid: mock.MOCK_OPENID, storeId: sid, memberOpenid, status: 'active', createdAt: Date.now() });
  mock.writeArray(mock.KEY_SHOP_MEMBERS, links);
  return Promise.resolve({ ok: true });
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
  const currentOpenid = (getApp().globalData && getApp().globalData.openid) || mock.MOCK_OPENID;
  if (tab === 'follow') {
    const follows = mock.readArray(mock.KEY_FOLLOWS);
    posts = posts.filter((p) => isFollowing(follows, currentOpenid, p._openid));
  } else if (tab === 'region') {
    posts = posts.filter((p) => p.region === region);
  }
  posts = posts.filter((p) => canViewPost(p, currentOpenid, region));
  posts.sort((a, b) => b.createdAt - a.createdAt);
  return Promise.resolve(posts.slice(page * pageSize, (page + 1) * pageSize));
}

// ============ 关注 ============

function getFollows() {
  if (cloudReady()) {
    return callCloud('getFollows', {}).then((r) => (r && r.follows) || []);
  }
  const currentOpenid = (getApp().globalData && getApp().globalData.openid) || mock.MOCK_OPENID;
  return Promise.resolve(
    mock.readArray(mock.KEY_FOLLOWS)
      .filter((item) => isFollowFrom(item, currentOpenid))
      .map((item) => followTarget(item))
      .filter(Boolean)
  );
}

function toggleFollow(authorOpenid) {
  if (cloudReady()) {
    return callCloud('toggleFollow', { authorOpenid });
  }
  const follows = mock.readArray(mock.KEY_FOLLOWS);
  const currentOpenid = (getApp().globalData && getApp().globalData.openid) || mock.MOCK_OPENID;
  const idx = follows.findIndex((item) => isFollowRelation(item, currentOpenid, authorOpenid));
  let following;
  if (idx !== -1) {
    follows.splice(idx, 1);
    following = false;
  } else {
    follows.push({ _openid: currentOpenid, authorOpenid, createdAt: Date.now() });
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

// 取用户当前经纬度（gcj02）。未授权/失败返回 null（调用方自行降级）。
function getUserLatLng() {
  return new Promise((resolve) => {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => resolve({ lat: res.latitude, lng: res.longitude }),
      fail: () => resolve(null)
    });
  });
}

// 两点球面距离（km），保留 1 位小数；任一坐标缺失返回 null。
function distanceKm(lat1, lng1, lat2, lng2) {
  const nums = [lat1, lng1, lat2, lng2];
  if (nums.some((v) => typeof v !== 'number' || isNaN(v))) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const a = sinLat * sinLat + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

function resolveCityFromLocation(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return '';
  return nearestCity(lat, lng);
}

function followSource(item) {
  if (typeof item === 'string') return mock.MOCK_OPENID;
  return item && item._openid;
}

function followTarget(item) {
  if (typeof item === 'string') return item;
  return item && item.authorOpenid;
}

function isFollowFrom(item, openid) {
  return followSource(item) === openid;
}

function isFollowRelation(item, fromOpenid, toOpenid) {
  return followSource(item) === fromOpenid && followTarget(item) === toOpenid;
}

function isFollowing(follows, fromOpenid, toOpenid) {
  return follows.some((item) => isFollowRelation(item, fromOpenid, toOpenid));
}

function isMutualFollow(follows, openidA, openidB) {
  return isFollowing(follows, openidA, openidB) && isFollowing(follows, openidB, openidA);
}

function normalizeVisibility(visibility) {
  return ['public', 'region', 'mutual', 'private'].indexOf(visibility) !== -1 ? visibility : 'public';
}

function canViewPost(post, currentOpenid, region) {
  const visibility = normalizeVisibility(post && post.visibility);
  if (!post) return false;
  if (post._openid === currentOpenid) return true;
  if (visibility === 'private') return false;
  if (visibility === 'region') {
    return !!(region && post.region === region);
  }
  if (visibility === 'mutual') {
    return isMutualFollow(mock.readArray(mock.KEY_FOLLOWS), currentOpenid, post._openid);
  }
  return true;
}

// 按门店 region 找城市中心坐标兜底
function _cityCenter(region) {
  const c = CITY_CENTERS.find((x) => region && region.indexOf(x.city) !== -1);
  return c || CITY_CENTERS[0];
}

// 确定性微抖动（±约 5km），让无坐标门店在地图上不重叠
function _hashJitter(seed) {
  let h = 0;
  const str = String(seed || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const dy = ((h % 1000) / 1000 - 0.5) * 0.1;
  const dx = (((h >>> 10) % 1000) / 1000 - 0.5) * 0.1;
  return { dx, dy };
}

// 补全门店坐标：已有 lat/lng 直接返回；否则按 region 城市中心 + 确定性抖动兜底。
// 用于兼容"老种子数据"（升级前已落库、无坐标字段）与未选点的门店。
function ensureStoreGeo(store) {
  if (store && typeof store.lat === 'number' && typeof store.lng === 'number') return store;
  const center = _cityCenter(store && store.region);
  const j = _hashJitter(store && store._id);
  return Object.assign({}, store, { lat: center.lat + j.dy, lng: center.lng + j.dx });
}

// 门店是否为"系统种子/官方店"（用于老数据默认开启到店打卡）
function _isSeedStore(s) {
  const id = (s && s._id) || '';
  return !!(s && (s.isSeed || /^hall_/.test(id) || /seed/.test(id)));
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
// 云端模式下 getStores 已固定返回"大川激流·旗舰店"种子门店，stores.length ≥ 1 不会走 fallback；
// fallbackStores 仅在云端完全失败时作为最后兜底。
function getBookableTables() {
  const synth = {
    hall_01: { tableCount: 12 },
    hall_02: { tableCount: 8 },
    hall_03: { tableCount: 6 },
    seed_store_dachuan_flag: { tableCount: 12 }
  };
  const defaultTypes = [{ name: '乔氏金腿', pricePerHour: 78 }, { name: '乔氏银腿', pricePerHour: 68 }];
  const fallbackStores = [
    { _id: 'seed_store_dachuan_flag', brandId: 'seed_brand_dachuan', name: '大川激流·旗舰店', address: '北京·朝阳区国贸 CBD 中心', cover: '', isSeed: true, tableTypes: [{ name: '乔氏金腿', pricePerHour: 78 }, { name: '乔氏银腿', pricePerHour: 68 }, { name: '美洲豹', pricePerHour: 58 }] }
  ];
  return getStores().then((stores) => {
    const raw = stores.length ? stores : fallbackStores;
    return raw
      .map((s) => ensureStoreGeo(s))
      .map((s) => {
        // 决策3：仅"已订阅且开启到店打卡"的合作门店出现在约球桌/地图找店。
        // 订阅按店主维度，跨用户在客户端拿不到 → 云端 getStores 应 join 店主订阅并 stamp s.subscribed 后再过滤；
        // mock/老数据：种子门店默认开启，店主新建门店以 checkinEnabled 为准（开启时已在门店管理校验订阅）。
        const enabled = s.checkinEnabled === undefined ? _isSeedStore(s) : !!s.checkinEnabled;
        return Object.assign({}, s, { checkinEnabled: enabled });
      })
      .filter((s) => s.checkinEnabled)
      .map((s) => {
        const base = synth[s._id] || { tableCount: 8 };
        const hallShopTableTypes = (s.tableTypes && s.tableTypes.length) ? s.tableTypes : defaultTypes;
        return Object.assign({}, s, base, { tableTypes: hallShopTableTypes });
      });
  });
}

// 按 _id 取单个门店（约球桌/地图/扫码核验用）
function getStoreById(storeId) {
  if (!storeId) return Promise.resolve(null);
  return getStores().then((stores) => {
    const s = (stores || []).find((x) => x._id === storeId);
    return s ? ensureStoreGeo(s) : null;
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
  const booking = {
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
  };
  // 约教练订单：标记平台抽佣率（与云端 createBooking 一致）
  if (type === 'coach') {
    booking.commissionRate = billing.COACH_COMMISSION_RATE;
  }
  bookings.push(booking);
  mock.writeArray(mock.KEY_BOOKINGS, bookings);
  return Promise.resolve({ ok: true, id });
}

function getPostDetail(postId, opts = {}) {
  if (cloudReady()) {
    return callCloud('getPostDetail', { postId, region: opts.region || '' }).then((r) => r || { post: null });
  }
  const post = mock.readArray(mock.KEY_POSTS).find((p) => p._id === postId) || null;
  const currentOpenid = (getApp().globalData && getApp().globalData.openid) || mock.MOCK_OPENID;
  if (post && !canViewPost(post, currentOpenid, opts.region || '')) {
    return Promise.resolve({ post: null, liked: false, comments: [], following: false });
  }
  const liked = mock
    .readArray(mock.KEY_POST_LIKES)
    .some((l) => l.postId === postId && l._openid === mock.MOCK_OPENID);
  const comments = mock
    .readArray(mock.KEY_COMMENTS)
    .filter((c) => c.postId === postId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const following = post
    ? isFollowing(mock.readArray(mock.KEY_FOLLOWS), currentOpenid, post._openid)
    : false;
  return Promise.resolve({ post, liked, comments, following });
}

function createPost({ type, title, content, images, video, cover, topics, location, region, visibility }) {
  const info = getCurrentUserInfo();
  if (cloudReady()) {
    return callCloud('createPost', {
      type,
      title,
      content,
      images,
      video,
      cover,
      topics,
      location,
      region,
      visibility,
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
    topics: Array.isArray(topics) ? topics : [],
    location: location || null,
    region: region || '',
    visibility: normalizeVisibility(visibility),
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

// ============ 收费 / 试用 ============

// 读取当前用户的计费状态 { firstLoginAt, plan, role, isInTrial }
// 云端模式从 users 集合拿，mock 模式从本地 KEY_BILLING 拿
// 读取当前用户在指定角色（或当前角色）下的计费状态：firstLoginAt / plan / isInTrial
// role 可不传，默认从 mock.getRole() 取；为支持 per_role 存储，传 role 时以它为准
function getUserBilling(opts) {
  const app = getApp();
  const passed = opts && opts.role;
  const role = passed || (app && app.globalData && app.globalData.role) || mock.getRole();
  const owner = app && app.globalData && app.globalData.openid ? app.globalData.openid : mock.MOCK_OPENID;
  if (cloudReady()) {
    return callCloud('getUserBilling', { role }).then((r) => {
      const b = (r && r.billing) || { firstLoginAt: 0, plan: 'free' };
      if (app && app.globalData) {
        app.globalData.firstLoginAt = b.firstLoginAt;
        app.globalData.plan = b.plan;
        app.globalData.planExpiresAt = b.planExpiresAt || 0;
      }
      // 关键：云端返回后立即让内存里 planExpiresAt 同步，hasPlan 才有依据
      return Object.assign({ role }, b, {
        isInTrial: billing.isInTrial(),
        trialRemainingMs: billing.trialRemainingMs()
      });
    });
  }
  const stateKey = mock.KEY_BILLING + '_' + owner + '_' + role;
  const stored = mock.readObject(stateKey, null);
  const now = Date.now();
  let firstLoginAt = (stored && stored.firstLoginAt) || 0;
  let plan = (stored && stored.plan) || 'free';
  if (!firstLoginAt) {
    firstLoginAt = now;
    mock.writeObject(stateKey, { firstLoginAt, plan, role });
  }
  if (app && app.globalData) {
    app.globalData.firstLoginAt = firstLoginAt;
    app.globalData.plan = plan;
    app.globalData.planExpiresAt = (stored && stored.planExpiresAt) || 0;
  }
  return Promise.resolve({
    firstLoginAt,
    plan,
    role,
    period: (stored && stored.period) || 'year',
    planExpiresAt: (stored && stored.planExpiresAt) || 0,
    isInTrial: billing.isInTrial(),
    trialRemainingMs: billing.trialRemainingMs()
  });
}

// 便捷方法：判断当前用户对某 plan 是否"在有效期"内（封装 billing.isPlanActive + 同步 globalData）
function isPlanActive(planKey) {
  // 确保 globalData 已读到位（不阻塞，缺失时 isPlanActive 自己会兜底）
  const app = getApp();
  if (app && app.globalData && !app.globalData.planExpiresAt) {
    // 尝试从 storage 同步一次（避免首次拉取时不同步）
    const role = app.globalData.role || mock.getRole();
    const owner = app.globalData.openid || mock.MOCK_OPENID;
    const stateKey = mock.KEY_BILLING + '_' + owner + '_' + role;
    const stored = mock.readObject(stateKey, null);
    if (stored && stored.planExpiresAt) {
      app.globalData.planExpiresAt = stored.planExpiresAt;
      if (stored.plan) app.globalData.plan = stored.plan;
    }
  }
  return billing.isPlanActive(planKey);
}

// 首次完成"角色选择"时调用，落地首次登录时间戳
// 首次登录时间戳标记（per_owner + per_role：同一人以不同身份登录时各自开始试期）
// 设计原则：firstLoginAt 只在用户在该角色下从未登录过时才写入；后续调用不会覆盖。
function markFirstLogin(role) {
  const app = getApp();
  const r = role || (app && app.globalData && app.globalData.role) || mock.getRole();
  const owner = app && app.globalData && app.globalData.openid ? app.globalData.openid : mock.MOCK_OPENID;
  const now = Date.now();
  const stateKey = mock.KEY_BILLING + '_' + owner + '_' + r;
  if (cloudReady()) {
    return callCloud('markFirstLogin', { role: r, firstLoginAt: now }).then((res) => {
      // 云端兜底：仅当云端未返回时本地兜底
      const stored = mock.readObject(stateKey, null);
      const firstLoginAt = (stored && stored.firstLoginAt) || now;
      if (app && app.globalData) app.globalData.firstLoginAt = firstLoginAt;
      mock.writeObject(stateKey, { firstLoginAt, plan: (stored && stored.plan) || 'free', role: r });
      return res || { ok: true, firstLoginAt, role: r };
    });
  }
  const stored = mock.readObject(stateKey, null);
  const firstLoginAt = (stored && stored.firstLoginAt) || now;
  const plan = (stored && stored.plan) || 'free';
  mock.writeObject(stateKey, { firstLoginAt, plan, role: r });
  if (app && app.globalData) {
    app.globalData.firstLoginAt = firstLoginAt;
    app.globalData.plan = plan;
  }
  return Promise.resolve({ ok: true, firstLoginAt, role: r, plan });
}

// 升级/续费套餐（per_owner + per_role 存储；后续接 wx.requestPayment 替换云端分支）
// 入参 period 为订阅周期 month/quarter/year，默认 year。落表写 planExpiresAt（到期内可继续使用）。
function upgradePlan(planKey, period) {
  const app = getApp();
  const role = (app && app.globalData && app.globalData.role) || mock.getRole();
  const owner = app && app.globalData && app.globalData.openid ? app.globalData.openid : mock.MOCK_OPENID;
  const per = billing.PERIOD_MS[period] ? period : 'year';
  const amount = billing.getPlanPrice(planKey, per);
  if (cloudReady()) {
    return callCloud('upgradePlan', { planKey, role, period: per }).then((r) => {
      if (app && app.globalData) {
        app.globalData.plan = planKey;
        if (r && r.planExpiresAt) app.globalData.planExpiresAt = r.planExpiresAt;
      }
      return r || { ok: true, plan: planKey, period: per };
    });
  }
  const stateKey = mock.KEY_BILLING + '_' + owner + '_' + role;
  const stored = mock.readObject(stateKey, null) || {};
  // 续期：若用户已购同套餐且未到期，在原到期日上累加；否则从 now 起算
  const now = Date.now();
  const base = (stored && stored.plan === planKey && stored.planExpiresAt && stored.planExpiresAt > now)
    ? stored.planExpiresAt
    : now;
  const planExpiresAt = base + billing.PERIOD_MS[per];
  const updated = Object.assign({}, stored, {
    plan: planKey,
    role,
    period: per,
    amount,
    planExpiresAt,
    upgradedAt: now
  });
  mock.writeObject(stateKey, updated);
  if (app && app.globalData) {
    app.globalData.plan = planKey;
    app.globalData.planExpiresAt = planExpiresAt;
  }
  return Promise.resolve({ ok: true, plan: planKey, period: per, amount, planExpiresAt });
}

// 创建虚拟支付订单（服务端下单 + 签名）。
// 云端：调 createVirtualPayOrder 云函数，返回 { ok, signData, paySig, signature, outTradeNo } 供 wx.requestVirtualPayment。
// mock/devtools：无法真实支付，返回 { ok:true, mock:true }，由前端走演示发货（upgradePlan）。
function createVirtualPayOrder(planKey, period, code) {
  const app = getApp();
  const role = (app && app.globalData && app.globalData.role) || mock.getRole();
  const per = billing.PERIOD_MS[period] ? period : 'year';
  if (cloudReady()) {
    // code 为 wx.login 票据，服务端 code2Session 取 session_key 做用户态签名
    return callCloud('createVirtualPayOrder', { planKey, role, period: per, code });
  }
  return Promise.resolve({ ok: true, mock: true });
}

// 基础支付（微信支付·JSAPI）下单：云端 cloudPay 统一下单，返回 { ok, payment, outTradeNo }
// 供前端 wx.requestPayment(payment)；mock/devtools 返回 { ok:true, mock:true } 走演示发货。
function createPayOrder(planKey, period) {
  const app = getApp();
  const role = (app && app.globalData && app.globalData.role) || mock.getRole();
  const per = billing.PERIOD_MS[period] ? period : 'year';
  if (cloudReady()) {
    return callCloud('createPayOrder', { planKey, role, period: per });
  }
  return Promise.resolve({ ok: true, mock: true });
}

// ============ 球桌按时计费订单（P1：结账 → 当日营收 → 我的页滚动） ============
// 演示阶段：mock 落本地，无需部署云函数即可跑通；接真实台桌/支付后改云端。
function _todayKey() {
  const d = new Date();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

// 结账：写一笔球桌计费订单（amount = 时长 × 单价，按分钟实算由调用方算好）
function addTableOrder(order) {
  const o = order || {};
  const app = getApp();
  const owner = app && app.globalData && app.globalData.openid ? app.globalData.openid : mock.MOCK_OPENID;
  const record = {
    _owner: owner,
    amount: Number(o.amount) || 0,
    storeId: o.storeId || '',
    tableId: o.tableId || '',
    tableName: o.tableName || '',
    durationMin: Number(o.durationMin) || 0,
    date: _todayKey(),
    createdAt: Date.now()
  };
  if (cloudReady()) {
    return callCloud('createTableOrder', record).then((r) => r || { ok: true, amount: record.amount });
  }
  const KEY = 'dc_shop_orders';
  const arr = mock.readArray(KEY);
  arr.push(record);
  mock.writeArray(KEY, arr);
  return Promise.resolve({ ok: true, amount: record.amount });
}

// 今日营收：当前店家今日所有结账订单金额合计（元）
function getTodayShopRevenue() {
  if (cloudReady()) {
    return callCloud('getTodayRevenue', {}).then((r) => (r && r.total) || 0);
  }
  const KEY = 'dc_shop_orders';
  const today = _todayKey();
  const total = mock.readArray(KEY)
    .filter((o) => o.date === today)
    .reduce((s, o) => s + (Number(o.amount) || 0), 0);
  return Promise.resolve(total);
}

// 账号注销：删除本人全部数据（云端调用 deleteAccount 云函数；mock 清空本地存储）
function deleteAccount() {
  if (cloudReady()) {
    return callCloud('deleteAccount', {});
  }
  try {
    const info = wx.getStorageInfoSync();
    (info.keys || []).forEach((k) => wx.removeStorageSync(k));
  } catch (e) {}
  return Promise.resolve({ ok: true });
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
  resolveAccount,
  getMemberCheckins,
  getMemberCheckinsByOpenid,
  saveCoachProfile,
  getMyMembers,
  getLinkableMembers,
  linkMember,
  getShopProfile,
  saveShopProfile,
  submitShopApplication,
  getShopApplicationStatus,
  getAdminStatus,
  getPendingShopApplications,
  reviewShopApplication,
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
  addShopMember,
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
  resolveCityFromLocation,
  getUserLatLng,
  distanceKm,
  getStoreById,
  requestCheckin,
  getPendingCheckins,
  resolveCheckin,
  getMyCheckinStatus,
  recordVerifiedTraining,
  getCoachLessons,
  getShopCoachSettlement,
  getCoachSettlementDetail,
  settleCoach,
  getShopBizOverview,
  genStoreCheckinCode,
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
  getCoachBookings,
  getUserBilling,
  markFirstLogin,
  upgradePlan,
  createVirtualPayOrder,
  createPayOrder,
  deleteAccount,
  addTableOrder,
  getTodayShopRevenue,
  isPlanActive
};
