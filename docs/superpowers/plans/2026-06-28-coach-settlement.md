# 教练结算（店主端）Implementation Plan

> **For agentic workers:** 用 superpowers:executing-plans 按任务逐项实现。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 店主端可按周期（本周/本月/全部）查看本店各教练的应付净额（课时费 − 5% 平台佣金），并「结算」（标记已结算 + 生成结算流水）。

**Architecture:** 复用现有 `coach_lessons` 课时数据；新增「待/已结算」状态与结算流水表。数据层 `data.js` 提供聚合/明细/结算三个函数（cloud + mock 双分支，mock 先跑通）；单页 + 同页明细 sheet 的店主端页面；入口挂订阅墙。

**Tech Stack:** 微信小程序（原生 JS）；本地 `wx.storage` mock + 云函数双分支；Node 脚本做数据层验证。

## Global Constraints

- 数据每个函数写 `if (cloudReady()) {云} else {mock}` 双分支，**mock 分支必须可跑通**（devtools 演示路径）。见 [[runs-on-mock-path]] 记忆。
- 佣金率固定 `billing.COACH_COMMISSION_RATE = 0.05`；佣金按**当期 gross 总额算一次** `billing.calcCoachCommission(gross)`，`net = gross − commission`，金额四舍五入到分。
- 周期三档 `week`(本周一~今天) / `month`(本月 1 号~今天) / `all`(不限)；周期**同时约束展示与结算范围**。
- 归属：本店课时 = `coachOpenid ∈ getShopCoaches()` 且 `hallId ∈ getShopStores() 的 _id（+ shop.storeId）`。
- 入口订阅墙 feature key `shop.coachSettle` → 套餐 `shop_basic`。
- 所有金额字段单位：元。课时 `amount` 缺失按 0。
- 不做：真实打款、教练端账单、自定义日期、导出（见 spec §2）。
- 提交：每个 Task 末尾 commit；commit message 末尾带 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

参考 spec：`docs/superpowers/specs/2026-06-28-coach-settlement-design.md`

---

### Task 1: 订阅墙 feature 映射（billing.js）

**Files:**
- Modify: `miniprogram/utils/billing.js`（`FEATURE_TO_PLAN`、`getFeatureLabel`）

**Interfaces:**
- Produces: feature key `'shop.coachSettle'` → plan `'shop_basic'`；`getFeatureLabel('shop.coachSettle') === '教练结算'`。

- [ ] **Step 1: 改 FEATURE_TO_PLAN** —在 `FEATURE_TO_PLAN` 对象内新增一行：

```js
  'shop.coachStats': 'shop_pro'      // 教练学员深度分析
};
```
改为（在该对象内、`shop.coachStats` 之后加一项）：
```js
  'shop.coachStats': 'shop_pro',     // 教练学员深度分析
  'shop.coachSettle': 'shop_basic'   // 教练结算（标准版起）
};
```

- [ ] **Step 2: 改 getFeatureLabel** —在 `getFeatureLabel` 的 `map` 里加一项 `'shop.coachSettle': '教练结算'`。

- [ ] **Step 3: 语法检查** — `node --check miniprogram/utils/billing.js` → 通过。

- [ ] **Step 4: Commit** — `git add miniprogram/utils/billing.js && git commit -m "feat: 教练结算订阅墙 feature 映射(shop.coachSettle→标准版)"`

---

### Task 2: 演示课时补种（mock.js）

**Files:**
- Modify: `miniprogram/utils/mock.js`（新增 KEY、`generateShopCoachLessons`、`ensureSeeded` 两处补种、导出）
- Test: `scratchpad/t2_seed.js`（Node）

**Interfaces:**
- Produces: `mock.KEY_COACH_SETTLEMENTS === 'dc_coach_settlements'`；`mock.generateShopCoachLessons()` 返回课时数组（每条 `coachOpenid ∈ coach_01..10`、`hallId === c.hallId`、`amount = durationMinutes × c.pricePerMinute`、`settled:false`）；`ensureSeeded` 后 `KEY_COACH_LESSONS` 含本店教练课时。

- [ ] **Step 1: 写验证脚本** `scratchpad/t2_seed.js`：

```js
const BASE='F:/4 Code/veloxis-softwares/veloxis-cuetrace/miniprogram';
let store={}; global.wx={getStorageSync:k=>k in store?store[k]:'',setStorageSync:(k,v)=>{store[k]=v},removeStorageSync:k=>{delete store[k]},getStorageInfoSync:()=>({keys:Object.keys(store)}),cloud:null};
global.getApp=()=>({globalData:{openid:'local-demo-user',cloudReady:false,role:'shop'}});
const mock=require(BASE+'/utils/mock');
const A=(c,m)=>console.log((c?'PASS':'FAIL')+' - '+m);
const ls=mock.generateShopCoachLessons();
A(ls.length>0,'generateShopCoachLessons 非空 ('+ls.length+')');
A(ls.every(l=>/^coach_/.test(l.coachOpenid)),'全部挂在 coach_xx 名下');
A(ls.every(l=>typeof l.amount==='number'&&l.amount>0),'amount 为正数');
A(ls.every(l=>l.settled===false),'settled 默认 false');
A(mock.KEY_COACH_SETTLEMENTS==='dc_coach_settlements','KEY_COACH_SETTLEMENTS 导出');
store={}; mock.ensureSeeded();
const seeded=(wx.getStorageSync('dc_coach_lessons')||[]);
A(seeded.some(l=>/^coach_/.test(l.coachOpenid)),'ensureSeeded 后含本店教练课时');
```

- [ ] **Step 2: 运行验证（应失败）** — `node scratchpad/t2_seed.js` → 期望 FAIL（generateShopCoachLessons 未定义 / KEY 未导出）。

- [ ] **Step 3: 实现 mock.js**
  - 在 KEY 定义区（`KEY_COACH_LESSONS` 之后）加：
    ```js
    const KEY_COACH_SETTLEMENTS = 'dc_coach_settlements'; // 教练结算流水（店主结算教练）
    ```
  - 在 `generateCoachLessons` 之后加生成函数：
    ```js
    // 给本店教练 coach_01..10 在各自门店补种课时（带 amount = 时长 × 单价），供「教练结算」演示
    function generateShopCoachLessons() {
      const lessons = [];
      const end = today();
      let seq = 0;
      COACHES.forEach((c, ci) => {
        const students = MEMBERS.filter((m) => (m.hallIds || []).indexOf(c.hallId) !== -1);
        for (let i = 0; i < 60; i++) {
          if (pseudoRandom(i + ci * 97 + 313) > 0.3) continue; // ~30% 天有课
          const dateKey = toKey(addDays(end, -i));
          const dur = 60 + Math.floor(pseudoRandom(i + ci * 31 + 700) * 60); // 60~120 分
          const member = students.length ? students[(i + ci) % students.length] : MEMBERS[(i + ci) % MEMBERS.length];
          const price = c.pricePerMinute || 4;
          lessons.push({
            _id: `mock_l_shop_${c.openid}_${seq++}`,
            coachOpenid: c.openid,
            coachNickname: c.nickname,
            memberOpenid: member.openid,
            memberNickname: member.nickname,
            hallId: c.hallId,
            hallName: c.hallName,
            date: dateKey,
            startTime: '15:00',
            durationMinutes: dur,
            amount: dur * price,
            verified: true,
            settled: false,
            createdAt: Date.now()
          });
        }
      });
      return lessons;
    }
    ```
  - 全量播种处：把 `writeArray(KEY_COACH_LESSONS, generateCoachLessons(MOCK_OPENID));` 改为
    ```js
    writeArray(KEY_COACH_LESSONS, generateCoachLessons(MOCK_OPENID).concat(generateShopCoachLessons()));
    ```
  - 迁移自愈处：在补「教练身份」课时之后加：
    ```js
    // 补本店教练课时（教练结算演示），缺失才补
    const lessonsNow = wx.getStorageSync(KEY_COACH_LESSONS) || [];
    if (!lessonsNow.some((l) => /^coach_/.test(l.coachOpenid || ''))) {
      writeArray(KEY_COACH_LESSONS, lessonsNow.concat(generateShopCoachLessons()));
    }
    ```
  - 导出：`module.exports` 加 `KEY_COACH_SETTLEMENTS,` 与 `generateShopCoachLessons,`。

- [ ] **Step 4: 运行验证（应通过）** — `node scratchpad/t2_seed.js` → 全 PASS。

- [ ] **Step 5: Commit** — `git add miniprogram/utils/mock.js && git commit -m "feat: 教练结算演示数据——本店教练课时补种 + 结算流水 KEY"`

---

### Task 3: 数据层（data.js）

**Files:**
- Modify: `miniprogram/services/data.js`（period/scope 私有助手 + 三个函数 + 导出）
- Test: `scratchpad/t3_data.js`（Node）

**Interfaces:**
- Consumes: `mock.KEY_COACH_LESSONS` 课时、`mock.KEY_COACH_SETTLEMENTS`、`mock.KEY_SHOP_COACHES`/`KEY_ALL_COACHES`/`KEY_STORES`/`KEY_SHOP`、`billing.calcCoachCommission`。
- Produces:
  - `getShopCoachSettlement(period)` → `Promise<{ totalPendingNet, pendingCoachCount, coaches:[{coachOpenid,nickname,avatar,pendingCount,pendingGross,pendingCommission,pendingNet,settledNet}] }>`
  - `getCoachSettlementDetail(coachOpenid, period)` → `Promise<{ coachOpenid, nickname, summary:{gross,commission,net}, pending:[lesson], settled:[lesson] }>`
  - `settleCoach(coachOpenid, period)` → `Promise<{ ok, netAmount, lessonCount } | { ok:false, msg }>`

- [ ] **Step 1: 写验证脚本** `scratchpad/t3_data.js`：

```js
const BASE='F:/4 Code/veloxis-softwares/veloxis-cuetrace/miniprogram';
let store={}; global.wx={getStorageSync:k=>k in store?store[k]:'',setStorageSync:(k,v)=>{store[k]=v},removeStorageSync:k=>{delete store[k]},getStorageInfoSync:()=>({keys:Object.keys(store)}),cloud:null};
global.getApp=()=>({globalData:{openid:'local-demo-user',cloudReady:false,role:'shop'}});
const mock=require(BASE+'/utils/mock'); const data=require(BASE+'/services/data');
const A=(c,m)=>console.log((c?'PASS':'FAIL')+' - '+m);
// 确定性 seed：店 + 教练 + 课时（coach_01 在 hall_01；amount 已知）
mock.writeObject(mock.KEY_SHOP,{storeId:'hall_01'});
mock.writeArray(mock.KEY_STORES,[{_id:'hall_01'}]);
mock.writeArray(mock.KEY_SHOP_COACHES,[{coachOpenid:'coach_01'},{coachOpenid:'coach_02'}]);
mock.writeArray(mock.KEY_ALL_COACHES,[{openid:'coach_01',nickname:'周',pricePerMinute:5},{openid:'coach_02',nickname:'吴',pricePerMinute:4}]);
mock.writeArray(mock.KEY_COACH_SETTLEMENTS,[]);
const todayKey=(()=>{const d=new Date();const m=d.getMonth()+1,day=d.getDate();return d.getFullYear()+'-'+(m<10?'0'+m:m)+'-'+(day<10?'0'+day:day);})();
mock.writeArray(mock.KEY_COACH_LESSONS,[
  {_id:'L1',coachOpenid:'coach_01',hallId:'hall_01',date:todayKey,amount:200,settled:false},
  {_id:'L2',coachOpenid:'coach_01',hallId:'hall_01',date:todayKey,amount:300,settled:false},
  {_id:'L3',coachOpenid:'coach_01',hallId:'hall_99',date:todayKey,amount:999,settled:false}, // 别店门店，不计
  {_id:'L4',coachOpenid:'coach_xx',hallId:'hall_01',date:todayKey,amount:888,settled:false}, // 非本店教练，不计
]);
(async()=>{
  let r=await data.getShopCoachSettlement('all');
  const c1=r.coaches.find(c=>c.coachOpenid==='coach_01');
  A(c1 && c1.pendingGross===500,'coach_01 pendingGross=500 (只算本店门店本店教练)');
  A(c1 && c1.pendingCommission===25,'佣金=25 (500×5%)');
  A(c1 && c1.pendingNet===475,'净额=475');
  A(r.totalPendingNet===475,'totalPendingNet=475 (coach_02 无课时)');
  A(r.pendingCoachCount===1,'pendingCoachCount=1');
  const d=await data.getCoachSettlementDetail('coach_01','all');
  A(d.pending.length===2 && d.summary.net===475,'明细 pending 2 节, net 475');
  const s=await data.settleCoach('coach_01','all');
  A(s.ok===true && s.netAmount===475 && s.lessonCount===2,'settleCoach ok net475 2节');
  const after=await data.getShopCoachSettlement('all');
  const c1b=after.coaches.find(c=>c.coachOpenid==='coach_01');
  A(c1b.pendingCount===0 && c1b.settledNet===475,'结算后 pending=0, settledNet=475');
  A(mock.readArray(mock.KEY_COACH_SETTLEMENTS).length===1,'生成 1 笔结算流水');
  const s2=await data.settleCoach('coach_01','all');
  A(s2.ok===false,'幂等：再次结算 ok:false 无待结算');
  A(mock.readArray(mock.KEY_COACH_SETTLEMENTS).length===1,'幂等：不新增流水');
})();
```

- [ ] **Step 2: 运行验证（应失败）** — `node scratchpad/t3_data.js` → FAIL（函数未定义）。

- [ ] **Step 3: 实现 data.js**
  - 在 `KEY_COACH_LESSONS` 常量旁加：`const KEY_COACH_SETTLEMENTS = 'dc_coach_settlements';`
  - 加私有助手（放在 `getCoachLessons` 附近）：
    ```js
    function _fmtKey(d) { const m=d.getMonth()+1, day=d.getDate(); return d.getFullYear()+'-'+(m<10?'0'+m:m)+'-'+(day<10?'0'+day:day); }
    function _periodRange(period) {
      const end = new Date(); end.setHours(0,0,0,0);
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
    function _shopScope() {
      const shop = mock.readObject(mock.KEY_SHOP, null) || {};
      const coachOpenids = mock.readArray(mock.KEY_SHOP_COACHES).map((l) => l.coachOpenid);
      const storeIds = mock.readArray(mock.KEY_STORES).map((s) => s._id);
      if (shop.storeId && storeIds.indexOf(shop.storeId) === -1) storeIds.push(shop.storeId);
      return { coachOpenids, storeIds };
    }
    const _r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    ```
  - 加三个函数（实现见下，放在 `getCoachLessons` 之后）：
    ```js
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
    ```
  - `module.exports` 加：`getShopCoachSettlement, getCoachSettlementDetail, settleCoach,`

- [ ] **Step 4: 运行验证（应通过）** — `node scratchpad/t3_data.js` → 全 PASS。

- [ ] **Step 5: Commit** — `git add miniprogram/services/data.js && git commit -m "feat: 教练结算数据层 getShopCoachSettlement/getCoachSettlementDetail/settleCoach"`

---

### Task 4: 入口接线（profile/index.js）

**Files:**
- Modify: `miniprogram/pages/profile/index.js`（`SHOP_TOOLS` 的「教练结算」项 act + `onTool` 分支）

**Interfaces:**
- Consumes: `billing.requirePlan`、`data` 无需。`feature:'shop.coachSettle'`。

- [ ] **Step 1: 改 SHOP_TOOLS** — 把 `{ label: '教练结算', icon: icon('wallet'), act: 'soon', dot: false }` 改成 `act: 'coachSettle'`。

- [ ] **Step 2: 改 onTool** — 在 `switch (act)` 里加分支（`billing` 已 require）：

```js
      case 'coachSettle':
        billing.requirePlan({ feature: 'shop.coachSettle', title: '教练结算' }).then((ok) => {
          if (!ok) return;
          wx.navigateTo({ url: '/pages/shop/coach-settlement/index' });
        });
        break;
```

- [ ] **Step 3: 语法检查** — `node --check miniprogram/pages/profile/index.js` → 通过。

- [ ] **Step 4: Commit** — `git add miniprogram/pages/profile/index.js && git commit -m "feat: 我的→经营工具「教练结算」入口（挂订阅墙）"`

---

### Task 5: 结算页（单页 + 明细 sheet）

**Files:**
- Create: `miniprogram/pages/shop/coach-settlement/index.js` / `.wxml` / `.wxss` / `.json`
- Modify: `miniprogram/app.json`（注册页面）
- Test: `scratchpad/t5_page.js`（Node 加载页逻辑）

**Interfaces:**
- Consumes: `data.getShopCoachSettlement(period)`、`data.getCoachSettlementDetail(coachOpenid, period)`、`data.settleCoach(coachOpenid, period)`。

- [ ] **Step 1: 写 index.js**（完整文件）：

```js
const data = require('../../../services/data');

const PERIODS = [
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' }
];

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    periods: PERIODS,
    period: 'month',
    loading: true,
    totalPendingNet: 0,
    pendingCoachCount: 0,
    coaches: [],
    // 明细 sheet
    showDetail: false,
    detailTab: 'pending',
    detail: null,
    settling: false
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh();
    this.load();
  },

  load() {
    this.setData({ loading: true });
    data.getShopCoachSettlement(this.data.period).then((r) => {
      r = r || { totalPendingNet: 0, pendingCoachCount: 0, coaches: [] };
      this.setData({ loading: false, totalPendingNet: r.totalPendingNet, pendingCoachCount: r.pendingCoachCount, coaches: r.coaches || [] });
    }).catch(() => this.setData({ loading: false }));
  },

  onPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (period === this.data.period) return;
    this.setData({ period });
    this.load();
    if (this.data.showDetail && this.data.detail) this._loadDetail(this.data.detail.coachOpenid);
  },

  openDetail(e) {
    this._loadDetail(e.currentTarget.dataset.openid);
  },
  _loadDetail(coachOpenid) {
    data.getCoachSettlementDetail(coachOpenid, this.data.period).then((d) => {
      this.setData({ showDetail: true, detail: d, detailTab: 'pending' });
    });
  },
  closeDetail() { this.setData({ showDetail: false }); },
  noop() {},
  onDetailTab(e) { this.setData({ detailTab: e.currentTarget.dataset.tab }); },

  doSettle() {
    const d = this.data.detail;
    if (!d || this.data.settling) return;
    if (!d.pending || !d.pending.length) { wx.showToast({ title: '无待结算课时', icon: 'none' }); return; }
    const label = (this.data.periods.find((p) => p.key === this.data.period) || {}).label || '';
    wx.showModal({
      title: '确认结算',
      content: `确认结清「${d.nickname}」${label} ${d.pending.length} 节课时，应付 ¥${d.summary.net}？`,
      confirmText: '结算',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ settling: true });
        data.settleCoach(d.coachOpenid, this.data.period).then((r) => {
          this.setData({ settling: false });
          if (r && r.ok === false) { wx.showToast({ title: r.msg || '结算失败', icon: 'none' }); return; }
          wx.showToast({ title: '已结算', icon: 'success' });
          this._loadDetail(d.coachOpenid);
          this.load();
        }).catch(() => { this.setData({ settling: false }); wx.showToast({ title: '结算失败', icon: 'none' }); });
      }
    });
  }
});
```

- [ ] **Step 2: 写 index.wxml**（完整文件）：

```xml
<view class="page theme-{{theme}}">
  <view class="seg">
    <view class="seg-item {{period===item.key?'on':''}}" wx:for="{{periods}}" wx:key="key" data-key="{{item.key}}" bindtap="onPeriod">{{item.label}}</view>
  </view>

  <view class="summary card">
    <view class="sum-main"><text class="cur">¥</text>{{totalPendingNet}}</view>
    <view class="muted">待结算合计 · {{pendingCoachCount}} 位教练</view>
  </view>

  <view wx:if="{{loading}}" class="loading">加载中…</view>
  <view wx:elif="{{coaches.length === 0}}" class="empty card"><view class="muted">本周期暂无教练课时</view></view>

  <view wx:else class="card list">
    <view class="row" wx:for="{{coaches}}" wx:key="coachOpenid" data-openid="{{item.coachOpenid}}" bindtap="openDetail">
      <image wx:if="{{item.avatar}}" class="avatar" src="{{item.avatar}}" mode="aspectFill"></image>
      <view wx:else class="avatar">{{item.nickname[0]}}</view>
      <view class="main">
        <view class="name">{{item.nickname}}</view>
        <view class="muted" wx:if="{{item.settledNet > 0}}">已结算 ¥{{item.settledNet}}</view>
      </view>
      <view class="amt">
        <view class="amt-net {{item.pendingNet>0?'':'zero'}}">¥{{item.pendingNet}}</view>
        <view class="amt-sub">待结算 {{item.pendingCount}} 节</view>
      </view>
    </view>
  </view>

  <view wx:if="{{showDetail}}" class="mask" bindtap="closeDetail">
    <view class="sheet" catchtap="noop">
      <view class="sheet-title">{{detail.nickname}}</view>
      <view class="sum3">
        <view class="sum3-col"><view class="sum3-num">¥{{detail.summary.gross}}</view><view class="muted">课时费</view></view>
        <view class="sum3-col"><view class="sum3-num minus">−¥{{detail.summary.commission}}</view><view class="muted">抽佣5%</view></view>
        <view class="sum3-col"><view class="sum3-num net">¥{{detail.summary.net}}</view><view class="muted">应付净额</view></view>
      </view>
      <view class="tabs">
        <view class="tab {{detailTab==='pending'?'on':''}}" data-tab="pending" bindtap="onDetailTab">待结算 {{detail.pending.length}}</view>
        <view class="tab {{detailTab==='settled'?'on':''}}" data-tab="settled" bindtap="onDetailTab">已结算 {{detail.settled.length}}</view>
      </view>
      <scroll-view scroll-y="true" class="det-list">
        <block wx:if="{{detailTab==='pending'}}">
          <view class="det" wx:for="{{detail.pending}}" wx:key="_id">
            <view class="det-main"><text>{{item.date}}</text><text class="muted"> · {{item.memberNickname || '会员'}} · {{item.durationMinutes}}分</text></view>
            <text class="det-amt">¥{{item.amount}}</text>
          </view>
          <view wx:if="{{detail.pending.length===0}}" class="muted det-empty">无待结算课时</view>
        </block>
        <block wx:else>
          <view class="det" wx:for="{{detail.settled}}" wx:key="_id">
            <view class="det-main"><text>{{item.date}}</text><text class="muted"> · {{item.memberNickname || '会员'}} · {{item.durationMinutes}}分</text></view>
            <text class="det-amt">¥{{item.amount}}</text>
          </view>
          <view wx:if="{{detail.settled.length===0}}" class="muted det-empty">无已结算课时</view>
        </block>
      </scroll-view>
      <button class="btn-primary settle-btn" disabled="{{detail.pending.length===0 || settling}}" bindtap="doSettle">
        {{ settling ? '结算中...' : (detail.pending.length ? '结算 ¥' + detail.summary.net : '无待结算') }}
      </button>
    </view>
  </view>
</view>
```

- [ ] **Step 3: 写 index.wxss**（完整文件）：

```css
.page { min-height: 100vh; padding-bottom: calc(60rpx + env(safe-area-inset-bottom)); }
.seg { display: flex; background: var(--card-bg); padding: 16rpx 24rpx; gap: 12rpx; }
.seg-item { flex: 1; text-align: center; padding: 14rpx 0; font-size: 28rpx; color: var(--text-sub); background: var(--bg-elev); border-radius: 12rpx; }
.seg-item.on { color: #fff; background: var(--brand); font-weight: 600; }
.summary { text-align: center; }
.sum-main { font-family: "DIN Alternate","Bahnschrift",sans-serif; font-size: 64rpx; font-weight: 700; color: var(--brand); line-height: 1.1; }
.cur { font-size: 32rpx; margin-right: 4rpx; }
.loading, .empty { padding: 60rpx 0; text-align: center; color: var(--text-weak); font-size: 26rpx; }
.list { padding: 0 32rpx; }
.row { display: flex; align-items: center; padding: 24rpx 0; border-bottom: 1rpx solid var(--border); }
.row:last-child { border-bottom: none; }
.avatar { width: 72rpx; height: 72rpx; border-radius: 50%; margin-right: 20rpx; background: rgba(6,126,249,0.12); color: var(--brand); font-size: 28rpx; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.main { flex: 1; }
.name { font-size: 30rpx; font-weight: 500; color: var(--text); }
.amt { text-align: right; }
.amt-net { font-size: 34rpx; font-weight: 700; color: var(--brand); }
.amt-net.zero { color: var(--text-weak); }
.amt-sub { font-size: 22rpx; color: var(--text-weak); margin-top: 4rpx; }
.mask { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: flex-end; z-index: 100; }
.sheet { width: 100%; background: var(--card-bg); border-radius: 28rpx 28rpx 0 0; padding: 36rpx; margin-bottom: calc(110rpx + env(safe-area-inset-bottom)); box-sizing: border-box; }
.sheet-title { font-size: 34rpx; font-weight: 700; text-align: center; margin-bottom: 24rpx; }
.sum3 { display: flex; margin-bottom: 24rpx; }
.sum3-col { flex: 1; text-align: center; }
.sum3-num { font-size: 34rpx; font-weight: 700; color: var(--text); }
.sum3-num.minus { color: #e8833a; }
.sum3-num.net { color: var(--brand); }
.tabs { display: flex; gap: 16rpx; margin-bottom: 12rpx; }
.tab { font-size: 26rpx; color: var(--text-sub); padding: 8rpx 24rpx; border-radius: 24rpx; background: var(--bg-elev); }
.tab.on { color: #fff; background: var(--brand); }
.det-list { max-height: 460rpx; }
.det { display: flex; align-items: center; justify-content: space-between; padding: 18rpx 0; border-bottom: 1rpx solid var(--border); font-size: 26rpx; color: var(--text); }
.det-amt { font-weight: 600; color: var(--brand); }
.det-empty { text-align: center; padding: 40rpx 0; }
.settle-btn { width: 100%; height: 88rpx; margin-top: 24rpx; }
```

- [ ] **Step 4: 写 index.json** — `{ "navigationBarTitleText": "教练结算", "usingComponents": {} }`

- [ ] **Step 5: 注册 app.json** — 在 `pages` 数组加 `"pages/shop/coach-settlement/index"`（放在 `pages/shop/table-types/index` 之后）。

- [ ] **Step 6: 验证页逻辑** `scratchpad/t5_page.js`：stub `Page/Behavior/getApp/wx`，seed（同 Task 3）后 require 页，调 `load()`/`openDetail`/`doSettle`：断言 `coaches` 加载、`detail` 加载、`doSettle` 经确认后调 `settleCoach` 并刷新。`node --check` 全部四类文件中的 .js。

- [ ] **Step 7: Commit** — `git add miniprogram/pages/shop/coach-settlement miniprogram/app.json && git commit -m "feat: 教练结算页（周期筛选 + 教练列表 + 明细sheet + 结算）"`

---

### Task 6: 云函数（上线用，先建好待部署）

**Files:**
- Create: `cloudfunctions/getShopCoachSettlement/{index.js,package.json}`
- Create: `cloudfunctions/getCoachSettlementDetail/{index.js,package.json}`
- Create: `cloudfunctions/settleCoach/{index.js,package.json}`

**Interfaces:** 与 data.js 云分支契约一致：返回结构同 Task 3 Produces。云端集合：`coach_lessons`（课时，加 `settled/settledAt/settlementId`）、`coach_settlements`（流水）、`shop_coach_links`（本店教练，字段 `shopOpenid/coachOpenid/status`）、`stores`（本店门店 `_openid`）、`coaches`（教练资料）。

- [ ] **Step 1–3: 写三个云函数 index.js**（周期/归属/佣金逻辑与 mock 对齐；owner 用服务端 OPENID；本店教练取 `shop_coach_links.where({shopOpenid:OPENID})`，门店取 `stores.where({_openid:OPENID})`）。每个配 `package.json`（`wx-server-sdk ~2.6.3`，name/description 对应）。`node --check` 三个 index.js 通过。

- [ ] **Step 4: Commit** — `git add cloudfunctions/getShopCoachSettlement cloudfunctions/getCoachSettlementDetail cloudfunctions/settleCoach && git commit -m "feat(cloud): 教练结算云函数 getShopCoachSettlement/getCoachSettlementDetail/settleCoach"`

---

## 最终验收（全部任务后）

- [ ] 独立测试 agent（Node）：跑 Task 2/3/5 验证脚本汇总 + `node --check` 全部新增/改动 JS + `app.json` 注册 + 周期边界（week 跨周一、month 跨月初）+ 隔离（不串别店/别教练）+ 幂等。
- [ ] 通知张总验收：入口路径（我的→经营工具→教练结算→订阅放行→页面）、演示数据可见、结算流水正确、上云待办清单（部署 3 个云函数 + 建 `coach_settlements` 集合 + `recordVerifiedTraining` 带 amount）。
