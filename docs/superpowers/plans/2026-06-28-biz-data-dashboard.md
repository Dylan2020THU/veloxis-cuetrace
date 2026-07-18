# 经营数据看板（店主端）Implementation Plan

> **For agentic workers:** 用 superpowers:executing-plans 按任务逐项实现。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 店主端单页看板：今日快照 + 近7/30天关键数（营收/开台/活跃会员/教练课时）+ 营收按天 CSS 柱状趋势。

**Architecture:** 复用 `shop_orders`(营收/开台)、`dc_sessions`(活跃会员)、`coach_lessons`(课时) 聚合；数据层 `getShopBizOverview(rangeDays)` 一次返回今日+范围+趋势（cloud+mock 双分支）；纯 CSS 柱状图、无第三方库；入口挂订阅墙。

**Tech Stack:** 微信小程序原生 JS；wx.storage mock + 云函数双分支；Node 验证。

## Global Constraints

- 数据函数写 `if (cloudReady()) {云} else {mock}` 双分支，mock 必须可跑通。见 [[runs-on-mock-path]]。
- `rangeDays ∈ {7,30}`，非法回退 7。趋势长度=rangeDays，旧→新，缺天补 0。
- 营收四舍五入到**元**（整数，与 `getTodayShopRevenue` 展示一致）；开台/活跃会员/课时为整数。
- 本店归属复用 data.js 已有 `_shopScope()`（本店教练 ∩ 本店门店）与 `_fmtKey(d)`。
- 入口订阅墙 `shop.report`（标准版，已在 FEATURE_TO_PLAN）。
- 演示数据：补种近 35 天 `dc_shop_orders`，仅当为空时补（不覆盖真实结账）。
- 提交：每 Task 末 commit，message 末尾带 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

参考 spec：`docs/superpowers/specs/2026-06-28-biz-data-dashboard-design.md`

---

### Task 1: 演示订单补种（mock.js）

**Files:** Modify `miniprogram/utils/mock.js`（generateShopOrders + ensureSeeded 两处 + 导出）；Test `scratchpad/b1.js`

**Interfaces:** Produces `mock.generateShopOrders()` → 订单数组（`_owner=MOCK_OPENID`、`amount>0`、`date` 在最近35天、`storeId∈本店门店`）；`ensureSeeded` 后 `dc_shop_orders` 非空。

- [ ] **Step 1: 写 `scratchpad/b1.js`**
```js
const BASE='F:/4 Code/veloxis-softwares/veloxis-cuetrace/miniprogram';
let store={}; global.wx={getStorageSync:k=>k in store?store[k]:'',setStorageSync:(k,v)=>{store[k]=v},removeStorageSync:k=>{delete store[k]},getStorageInfoSync:()=>({keys:Object.keys(store)}),cloud:null};
global.getApp=()=>({globalData:{openid:'local-demo-user',cloudReady:false,role:'shop'}});
const mock=require(BASE+'/utils/mock'); const A=(c,m)=>console.log((c?'PASS':'FAIL')+' - '+m);
const o=mock.generateShopOrders();
A(o.length>0,'generateShopOrders 非空 ('+o.length+')');
A(o.every(x=>x.amount>0&&x._owner==='local-demo-user'),'amount>0 & owner 正确');
A(o.every(x=>['hall_01','hall_02','hall_03'].indexOf(x.storeId)!==-1),'storeId 在本店门店');
store={}; mock.ensureSeeded();
A((wx.getStorageSync('dc_shop_orders')||[]).length>0,'ensureSeeded 后 dc_shop_orders 非空');
```
- [ ] **Step 2: 运行（应 FAIL）** `node scratchpad/b1.js`
- [ ] **Step 3: 实现 mock.js**
  - 在 `generateShopCoachLessons` 之后加：
```js
// 给本店门店补种近 35 天结账订单（dc_shop_orders），供经营数据看板营收/开台/趋势演示
function generateShopOrders() {
  const orders = [];
  const end = today();
  const stores = STORES;
  for (let i = 0; i < 35; i++) {
    const dateKey = toKey(addDays(end, -i));
    const cnt = Math.floor(pseudoRandom(i + 555) * 8); // 0~7 笔/天
    for (let k = 0; k < cnt; k++) {
      const s = stores[(i + k) % stores.length];
      const tt = (s.tableTypes && s.tableTypes[(i + k) % s.tableTypes.length]) || { name: '球桌', pricePerHour: 60 };
      const hours = 1 + Math.floor(pseudoRandom(i * 7 + k + 900) * 3); // 1~3 小时
      orders.push({
        _owner: MOCK_OPENID,
        amount: (tt.pricePerHour || 60) * hours,
        storeId: s._id,
        tableId: `t_${((i + k) % 8) + 1}`,
        tableName: tt.name,
        durationMin: hours * 60,
        date: dateKey,
        createdAt: Date.now() - i * 86400000
      });
    }
  }
  return orders;
}
```
  - 全量播种：在 `writeArray(KEY_MATCHES,...)` 之前（或紧随 sessions 写入后）加 `writeArray('dc_shop_orders', generateShopOrders());`（放在 `writeArray(KEY_COACH_LESSONS, ...)` 那行之后即可）。
  - 迁移自愈：在补本店教练课时之后加：
```js
      // 补演示订单（经营数据看板），缺失才补
      if (!(wx.getStorageSync('dc_shop_orders') || []).length) {
        writeArray('dc_shop_orders', generateShopOrders());
        console.log('[ensureSeeded] backfilled shop orders');
      }
```
  - 导出：`module.exports` 加 `generateShopOrders,`。
- [ ] **Step 4: 运行（应 PASS）** `node scratchpad/b1.js`
- [ ] **Step 5: Commit** `git add miniprogram/utils/mock.js && git commit -m "feat: 经营数据看板演示订单补种 generateShopOrders"`

---

### Task 2: 数据层（data.js）

**Files:** Modify `miniprogram/services/data.js`（getShopBizOverview + _emptyBiz + 导出）；Test `scratchpad/b2.js`

**Interfaces:** Consumes `_fmtKey/_shopScope`（已存在）、`mock.KEY_SESSIONS/KEY_MEMBERS`、`KEY_COACH_LESSONS`、`'dc_shop_orders'`。Produces `getShopBizOverview(rangeDays)` → `{ today:{revenue,opens,activeMembers,lessons}, range:{...}, trend:[{date,revenue}] }`。

- [ ] **Step 1: 写 `scratchpad/b2.js`**
```js
const BASE='F:/4 Code/veloxis-softwares/veloxis-cuetrace/miniprogram';
let store={}; global.wx={getStorageSync:k=>k in store?store[k]:'',setStorageSync:(k,v)=>{store[k]=v},removeStorageSync:k=>{delete store[k]},getStorageInfoSync:()=>({keys:Object.keys(store)}),cloud:null};
global.getApp=()=>({globalData:{openid:'local-demo-user',cloudReady:false,role:'shop'}});
const mock=require(BASE+'/utils/mock'); const data=require(BASE+'/services/data'); const A=(c,m)=>console.log((c?'PASS':'FAIL')+' - '+m);
const fk=d=>{const m=d.getMonth()+1,da=d.getDate();return d.getFullYear()+'-'+(m<10?'0'+m:m)+'-'+(da<10?'0'+da:da);};
const base=new Date();base.setHours(0,0,0,0);
const today=fk(base); const dm=(n)=>{const d=new Date(base.getTime());d.setDate(base.getDate()-n);return fk(d);};
mock.writeObject(mock.KEY_SHOP,{storeId:'hall_01'});
mock.writeArray(mock.KEY_STORES,[{_id:'hall_01'},{_id:'hall_02'}]);
mock.writeArray(mock.KEY_SHOP_COACHES,[{coachOpenid:'coach_01'}]);
mock.writeArray(mock.KEY_ALL_COACHES,[{openid:'coach_01'}]);
mock.writeArray(mock.KEY_MEMBERS,[{openid:'member_01'},{openid:'member_02'}]);
mock.writeArray('dc_shop_orders',[
  {amount:100,storeId:'hall_01',date:today},
  {amount:50,storeId:'hall_01',date:today},
  {amount:80,storeId:'hall_02',date:dm(3)},
  {amount:999,storeId:'hall_01',date:dm(40)}, // 40 天前，近7/近30 都不计
]);
mock.writeArray(mock.KEY_SESSIONS,[
  {_openid:'member_01',hallId:'hall_01',date:today,durationMinutes:60},
  {_openid:'member_02',hallId:'hall_01',date:dm(2),durationMinutes:60},
  {_openid:'member_01',hallId:'hall_99',date:today,durationMinutes:60}, // 别店门店，不计活跃
  {_openid:'local-demo-user',hallId:'hall_01',date:today,durationMinutes:60}, // 非会员，不计
]);
mock.writeArray(mock.KEY_COACH_LESSONS,[
  {coachOpenid:'coach_01',hallId:'hall_01',date:today,amount:200},
  {coachOpenid:'coach_01',hallId:'hall_01',date:dm(3),amount:200},
  {coachOpenid:'coach_01',hallId:'hall_01',date:dm(40),amount:200}, // 旧，近7/30 不计
]);
(async()=>{
  const w=await data.getShopBizOverview(7);
  A(w.range.revenue===230,'近7天营收=230 (100+50+80, 排除40天前)');
  A(w.range.opens===3,'近7天开台=3');
  A(w.range.activeMembers===2,'近7天活跃会员=2 (member_01,02; 排除别店/非会员)');
  A(w.range.lessons===2,'近7天课时=2 (排除40天前)');
  A(w.today.revenue===150 && w.today.opens===2,'今日快照 营收150 开台2');
  A(w.today.activeMembers===1 && w.today.lessons===1,'今日 活跃1 课时1');
  A(w.trend.length===7,'trend 长度=7');
  A(w.trend[6].date===today && w.trend[6].revenue===150,'trend 末位=今日 150');
  A(w.trend[3].revenue===80,'trend 第 dm(3) 天=80');
  A(w.trend[0].revenue===0,'trend 缺天补 0');
  const m=await data.getShopBizOverview(30);
  A(m.trend.length===30 && m.range.revenue===230,'近30天 trend30 营收仍230 (40天前不计)');
  A((await data.getShopBizOverview(99)).trend.length===7,'非法 rangeDays 回退7');
})();
```
- [ ] **Step 2: 运行（应 FAIL）** `node scratchpad/b2.js`
- [ ] **Step 3: 实现 data.js**（放在 `settleCoach` 之后、`// ============ 球员列表` 之前）：
```js
// 店主端：经营数据看板概览（今日快照 + 近 rangeDays 天关键数 + 营收按天趋势）
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
```
  - 导出：`module.exports` 加 `getShopBizOverview,`
- [ ] **Step 4: 运行（应 PASS）** `node scratchpad/b2.js`
- [ ] **Step 5: Commit** `git add miniprogram/services/data.js && git commit -m "feat: 经营数据看板数据层 getShopBizOverview"`

---

### Task 3: 入口接线（profile/index.js + .wxml）

**Files:** Modify `miniprogram/pages/profile/index.js`、`miniprogram/pages/profile/index.wxml`

**Interfaces:** Consumes `billing.requirePlan`、`data.getShopBizOverview`（间接）。

- [ ] **Step 1: SHOP_TOOLS** — 把 `{ label: '经营数据', icon: icon('chart'), act: 'soon', dot: false }` 改 `act: 'bizData'`。
- [ ] **Step 2: onTool** — 在 switch 加：
```js
      case 'bizData':
        this.goBizData();
        break;
```
- [ ] **Step 3: 加 goBizData 方法**（放在 onTool 之后、comingSoon 之前）：
```js
  goBizData() {
    billing.requirePlan({ feature: 'shop.report', title: '经营数据' }).then((ok) => {
      if (!ok) return;
      wx.navigateTo({ url: '/pages/shop/biz-data/index' });
    });
  },
```
- [ ] **Step 4: wxml** — 把经营数据卡的 `<text class="card-more" bindtap="comingSoon">今日 ›</text>` 改为 `bindtap="goBizData"`。
- [ ] **Step 5: 语法** `node --check miniprogram/pages/profile/index.js`
- [ ] **Step 6: Commit** `git add miniprogram/pages/profile/index.js miniprogram/pages/profile/index.wxml && git commit -m "feat: 经营数据看板入口（九宫格+经营数据卡，挂订阅墙）"`

---

### Task 4: 看板页（pages/shop/biz-data）

**Files:** Create `miniprogram/pages/shop/biz-data/index.{js,wxml,wxss,json}`；Modify `miniprogram/app.json`；Test `scratchpad/b4.js`

**Interfaces:** Consumes `data.getShopBizOverview(rangeDays)`。

- [ ] **Step 1: index.js**
```js
const data = require('../../../services/data');
const RANGES = [{ key: 7, label: '近7天' }, { key: 30, label: '近30天' }];
Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    ranges: RANGES,
    rangeDays: 7,
    loading: true,
    today: { revenue: 0, opens: 0, activeMembers: 0, lessons: 0 },
    range: { revenue: 0, opens: 0, activeMembers: 0, lessons: 0 },
    bars: [],
    tip: ''
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh();
    this.load();
  },
  load() {
    this.setData({ loading: true });
    data.getShopBizOverview(this.data.rangeDays).then((r) => {
      r = r || { today: {}, range: {}, trend: [] };
      const trend = r.trend || [];
      const max = trend.reduce((m, t) => Math.max(m, t.revenue || 0), 0);
      const bars = trend.map((t) => ({
        date: t.date, revenue: t.revenue || 0,
        h: max > 0 ? Math.max(t.revenue > 0 ? 4 : 0, Math.round((t.revenue || 0) / max * 100)) : 0,
        md: t.date.slice(5).replace('-', '/')
      }));
      this.setData({ loading: false, today: r.today || {}, range: r.range || {}, bars, tip: '' });
    }).catch(() => this.setData({ loading: false }));
  },
  onRange(e) {
    const rangeDays = Number(e.currentTarget.dataset.key);
    if (rangeDays === this.data.rangeDays) return;
    this.setData({ rangeDays, tip: '' });
    this.load();
  },
  onBar(e) {
    const i = e.currentTarget.dataset.i;
    const b = this.data.bars[i];
    if (b) this.setData({ tip: `${b.md} · ¥${b.revenue}` });
  }
});
```
- [ ] **Step 2: index.wxml**
```xml
<view class="page theme-{{theme}}">
  <view class="card snap">
    <view class="snap-title">今日</view>
    <view class="metrics">
      <view class="metric"><view class="m-num"><text class="cur">¥</text>{{today.revenue}}</view><view class="m-lbl">营收</view></view>
      <view class="metric"><view class="m-num">{{today.opens}}</view><view class="m-lbl">开台</view></view>
      <view class="metric"><view class="m-num">{{today.activeMembers}}</view><view class="m-lbl">活跃会员</view></view>
      <view class="metric"><view class="m-num">{{today.lessons}}</view><view class="m-lbl">课时</view></view>
    </view>
  </view>

  <view class="seg">
    <view class="seg-item {{rangeDays===item.key?'on':''}}" wx:for="{{ranges}}" wx:key="key" data-key="{{item.key}}" bindtap="onRange">{{item.label}}</view>
  </view>

  <view class="card">
    <view class="metrics">
      <view class="metric"><view class="m-num"><text class="cur">¥</text>{{range.revenue}}</view><view class="m-lbl">营收合计</view></view>
      <view class="metric"><view class="m-num">{{range.opens}}</view><view class="m-lbl">开台数</view></view>
      <view class="metric"><view class="m-num">{{range.activeMembers}}</view><view class="m-lbl">活跃会员</view></view>
      <view class="metric"><view class="m-num">{{range.lessons}}</view><view class="m-lbl">教练课时</view></view>
    </view>
  </view>

  <view class="card">
    <view class="chart-head">
      <text class="chart-title">营收趋势</text>
      <text class="chart-tip">{{tip || '点柱看当天营收'}}</text>
    </view>
    <view wx:if="{{loading}}" class="loading">加载中…</view>
    <view wx:elif="{{range.revenue===0}}" class="empty muted">暂无营收数据</view>
    <view wx:else class="chart">
      <view class="bar-wrap" wx:for="{{bars}}" wx:key="date" data-i="{{index}}" bindtap="onBar">
        <view class="bar" style="height:{{item.h}}%"></view>
      </view>
    </view>
  </view>
</view>
```
- [ ] **Step 3: index.wxss**
```css
.page { min-height: 100vh; padding-bottom: calc(60rpx + env(safe-area-inset-bottom)); }
.snap { margin-top: 24rpx; }
.snap-title { font-size: 26rpx; color: var(--text-weak); margin-bottom: 16rpx; }
.metrics { display: flex; }
.metric { flex: 1; text-align: center; }
.m-num { font-family: "DIN Alternate","Bahnschrift",sans-serif; font-size: 44rpx; font-weight: 700; color: var(--brand); line-height: 1.1; }
.cur { font-size: 26rpx; margin-right: 2rpx; }
.m-lbl { font-size: 22rpx; color: var(--text-weak); margin-top: 6rpx; }
.seg { display: flex; gap: 12rpx; padding: 0 24rpx; margin: 8rpx 0; }
.seg-item { flex: 1; text-align: center; padding: 14rpx 0; font-size: 28rpx; color: var(--text-sub); background: var(--bg-elev); border-radius: 12rpx; }
.seg-item.on { color: #fff; background: var(--brand); font-weight: 600; }
.chart-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24rpx; }
.chart-title { font-size: 30rpx; font-weight: 700; color: var(--text); }
.chart-tip { font-size: 22rpx; color: var(--text-weak); }
.loading, .empty { padding: 60rpx 0; text-align: center; font-size: 26rpx; color: var(--text-weak); }
.chart { display: flex; align-items: flex-end; height: 240rpx; gap: 4rpx; }
.bar-wrap { flex: 1; height: 100%; display: flex; align-items: flex-end; }
.bar { width: 100%; min-height: 0; background: linear-gradient(to top, #067ef9, #4da3ff); border-radius: 6rpx 6rpx 0 0; transition: height .2s; }
```
- [ ] **Step 4: index.json** — `{ "navigationBarTitleText": "经营数据", "usingComponents": {} }`
- [ ] **Step 5: app.json** — 在 `pages` 加 `"pages/shop/biz-data/index"`（放在 `pages/shop/coach-settlement/index` 之后）。
- [ ] **Step 6: 写 `scratchpad/b4.js`** — stub Page/Behavior/getApp/wx；seed（同 b2）；require 页；`p.load()` 后断言 `bars.length===7`、`today.revenue===150`、`range.revenue===230`、max 归一化柱高（today 柱 h===100 因当天营收 150 为最大）；`onRange({currentTarget:{dataset:{key:30}}})` 后 `bars.length===30`；`onBar({currentTarget:{dataset:{i:6}}})` 后 `tip` 含 '¥150'。`node --check` 页 js + app.json 校验。
- [ ] **Step 7: Commit** `git add miniprogram/pages/shop/biz-data miniprogram/app.json && git commit -m "feat: 经营数据看板页（今日快照+近7/30天关键数+营收CSS柱状趋势）"`

---

### Task 5: 云函数（上线用）

**Files:** Create `cloudfunctions/getShopBizOverview/{index.js,package.json}`

**Interfaces:** 与 data.js 云分支契约一致：入参 `{rangeDays}`，返回同 Task 2 Produces。集合：`shop_orders`(本人 _openid)、`training_sessions`(本店门店 hallId + 会员)、`coach_lessons`(本店 scope)。本店门店=`stores.where({_openid:OPENID})`，本店教练=`shop_coach_links.where({shopOpenid:OPENID,status:'active'})`，会员判定=`_openid` 在 `members` 集合（或非教练/非店主）。日期按 UTC+8。

- [ ] **Step 1–2: 写 index.js + package.json**（聚合逻辑与 mock 对齐：rangeDays∈{7,30} 回退7；营收/开台来自 shop_orders.where({_openid:OPENID,date∈range})；活跃会员=training_sessions 在本店门店、date∈range 的去重 _openid 且属 members；课时=coach_lessons 本店 scope；trend 缺天补 0；金额 round 到元）。`node --check` 通过。
- [ ] **Step 3: Commit** `git add cloudfunctions/getShopBizOverview && git commit -m "feat(cloud): 经营数据看板云函数 getShopBizOverview"`

---

## 最终验收（全部任务后）

- [ ] 独立 agent（Node）：聚合/趋势/今日/范围边界/隔离/归一化 + 用真实 ensureSeeded 种子跑 `getShopBizOverview(7)`/`(30)` 确认 range.revenue>0、trend 天数对、页面非空 + `node --check` 全部 + app.json 注册 + 入口 requirePlan→navigate。
- [ ] 通知张总验收 + 上云待办（部署 getShopBizOverview + shop_orders 集合）。
