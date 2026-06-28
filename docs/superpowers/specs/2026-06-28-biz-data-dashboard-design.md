# 经营数据看板（店主端）设计 Spec

- 日期：2026-06-28
- 状态：待评审
- 所属：二期功能 · 店主端经营工具
- 定位：综合概览（一屏看懂经营）

## 1. 背景与目标

店主端「我的 → 经营工具」九宫格的「经营数据」当前是 `act:'soon'` 占位；顶部「经营数据」卡的「今日 ›」也是 `comingSoon`。本期落地为可用的**综合经营看板**。

**目标（MVP）**：店主能看到「今日快照 + 近 7/30 天关键数 + 营收按天趋势」，一屏掌握经营。**v1 不做导出**。

可用数据源：
- `shop_orders`（`dc_shop_orders`，云端 `shop_orders`）：结账订单，含 `amount/storeId/tableId/durationMin/date/_owner(云端 _openid)`。营收/开台来源。
- `dc_sessions`（云端 `training_sessions`）：会员训练记录，含 `_openid/hallId/date/durationMinutes`。活跃会员来源。
- `coach_lessons`（`dc_coach_lessons`）：教练课时，含 `coachOpenid/hallId/date`。教练课时来源（复用教练结算的本店 scope）。

## 2. 范围

**做（In scope）**
- 单页「经营数据」：今日快照 + 近7天/近30天切换 + 该范围 4 个关键数 + 营收按天 CSS 柱状趋势图。
- 数据层 `getShopBizOverview(rangeDays)`（cloud + mock 双分支，mock 先跑通）。
- 入口两处挂订阅墙（`shop.report` 标准版）。
- 演示数据：补种近 ~35 天 `shop_orders`，使营收/开台/趋势有数。

**不做（Out of scope）**
- 导出（Excel/CSV）—留后续。
- 自定义任意日期区间（只 近7天/近30天 两档 + 今日快照）。
- canvas 图表、营收构成下钻、同比/环比、多门店分店对比。
- 实时「当前在台」（需实时占用，另议）。

## 3. 入口与订阅墙

- 入口①：`pages/profile/index.js` 的 `SHOP_TOOLS`「经营数据」`act:'soon'` → `act:'bizData'`；`onTool` 加分支。
- 入口②：`pages/profile/index.wxml` 顶部「经营数据」卡的 `<text class="card-more" bindtap="comingSoon">今日 ›</text>` → 改 `bindtap="goBizData"`，`profile/index.js` 加 `goBizData`。
- 两入口都过订阅墙再进页：
  ```js
  billing.requirePlan({ feature: 'shop.report', title: '经营数据' }).then((ok) => {
    if (!ok) return;
    wx.navigateTo({ url: '/pages/shop/biz-data/index' });
  });
  ```
- `shop.report → shop_basic` 已在 `FEATURE_TO_PLAN`；`getFeatureLabel('shop.report')='经营数据报表'`（已存在）。续费墙 `app.paywall` 已修复。

## 4. 页面结构（`pages/shop/biz-data/`）

自上而下：
1. **今日快照**卡（始终今天）：今日营收 ¥ / 今日开台 / 今日活跃会员 / 今日课时（4 个并排小数）。
2. **范围切换**分段：`近7天` / `近30天`（默认近7天）。
3. **关键数**卡（选定范围）：营收合计 ¥ / 开台数 / 活跃会员 / 教练课时（节）。
4. **营收趋势**卡：CSS 柱状图——范围内每天一根柱，柱高 = `当天营收 / 范围内最大营收`（最大为 0 时全 0 高度、不除零）。点柱 → tooltip 显示「M月D日 · ¥X」。30 天时柱细、间距小；x 轴按需稀疏标注（首/中/尾日期）。

## 5. 指标定义（数据口径）

设范围 `[fromKey, todayKey]`，`fromKey = today − (rangeDays−1)` 天。

- **营收(revenue)** = `Σ shop_orders.amount`，`date ∈ [fromKey,todayKey]`。
- **开台数(opens)** = `count(shop_orders)`，date 在范围内（每笔结账=一次完成开台）。
- **活跃会员(activeMembers)** = `distinct dc_sessions._openid`，满足 `_openid ∈ KEY_MEMBERS 的 openid` 且 `hallId ∈ 本店门店` 且 date 在范围。
- **教练课时(lessons)** = `count(coach_lessons)`，`coachOpenid ∈ 本店教练` 且 `hallId ∈ 本店门店` 且 date 在范围（复用 `_shopScope`）。
- **今日快照** = 上述 4 项取 `date = todayKey`。
- **趋势(trend)** = 范围内每一天 `{date, revenue}`（缺天补 0），旧→新。

本店归属：`_shopScope()`（本店教练 openid ∩ 本店门店 _id，已在 data.js）。营收/开台：mock 不按 owner 过滤（与现有 `getTodayShopRevenue` 一致）；云端按 `_openid=OPENID`。

## 6. 数据层接口（services/data.js）

`getShopBizOverview(rangeDays)`，`rangeDays ∈ {7, 30}`（非法值回退 7），cloud + mock 双分支：
```
返回 {
  today:  { revenue, opens, activeMembers, lessons },
  range:  { revenue, opens, activeMembers, lessons },
  trend:  [ { date, revenue }, ... ]   // 长度 = rangeDays，旧→新
}
```
- 复用已有 `_fmtKey`、`_shopScope`、`_r2`；新增按天聚合（`shop_orders` group by date）。
- 金额统一四舍五入到元（与现有营收展示一致）：展示用整数元。聚合内部可保留精度，最终 `Math.round`。

## 7. 演示数据（seeding）

`shop_orders` 仅在结账时写，演示无历史 → 趋势空。新增：
- `mock.generateShopOrders()`：对本店门店在最近 35 天确定性补种订单（每天 0~8 笔，金额=时长×单价合理值，`_owner=MOCK_OPENID`、`date=dayKey`、`storeId` 取本店门店）。
- `ensureSeeded` 全量 + 迁移两处补种：**仅当 `dc_shop_orders` 为空时补**（不覆盖真实结账订单）。
- 活跃会员（member 训练 ~365 天）、教练课时（本店教练课时 ~60 天）已有种子，无需新增。

## 8. 边界与错误处理

- `rangeDays` 仅 7/30；非法回退 7。
- 趋势缺天补 0；柱高归一化时最大营收为 0 → 全 0 高度，**不除零**。
- 金额四舍五入到元；活跃会员/开台/课时为整数。
- 空数据 → 关键数显示 0、趋势卡空态（"暂无营收数据"）。
- 隔离：营收/开台按门店/owner；活跃会员、课时按本店 scope，不串别店/别教练。
- 今日口径：mock 用本地 `_todayKey`，云端用 UTC+8（与 `getTodayRevenue` 一致）。

## 9. 测试计划（独立 agent，Node 实跑）

1. 聚合正确：构造已知 `shop_orders`（多天、多门店）+ member sessions + coach lessons → `getShopBizOverview(7)`/`(30)` 的 revenue/opens/activeMembers/lessons 与手算一致。
2. 趋势：`trend.length === rangeDays`；按日期旧→新；缺天补 0；某天多笔订单营收累加正确。
3. 今日快照：`today.*` 仅统计 todayKey。
4. 范围边界：放一笔 40 天前的订单 → 近30天不计入、近7天不计入；放一笔今天的 → 都计入。
5. 隔离：别店门店订单/别教练课时不计入；活跃会员只数本店门店内的会员。
6. 归一化：最大营收为 0 时不报错（页逻辑层验证柱高计算）。
7. 演示数据：`mock.generateShopOrders()` 非空、日期在最近 35 天、金额为正；`ensureSeeded` 后 `dc_shop_orders` 非空且 `getShopBizOverview(7).range.revenue > 0`。
8. 入口：`onTool('bizData')` 与 `goBizData` 过 requirePlan 后 `navigateTo` 正确路径。
9. `node --check` 全部新增/改动 JS + `app.json` 注册。

## 10. 上云待办（真机生效需部署）

- 新增云函数 `getShopBizOverview`（聚合 `shop_orders`(本人) + `training_sessions`(本店门店) + `coach_lessons`(本店 scope)，按 rangeDays 与 UTC+8 今日）。
- 依赖 `shop_orders` 集合（与今日营收同一集合，见前述待办）。
- 真机未部署前该页空/报错，devtools mock 路径即时可用。

## 11. 涉及文件清单

**新增**
- `miniprogram/pages/shop/biz-data/index.{js,wxml,wxss,json}`
- `cloudfunctions/getShopBizOverview/{index.js,package.json}`

**改动**
- `miniprogram/pages/profile/index.js`（SHOP_TOOLS act + onTool 分支 + goBizData）
- `miniprogram/pages/profile/index.wxml`（经营数据卡「今日 ›」→ goBizData）
- `miniprogram/services/data.js`（getShopBizOverview + 按天聚合助手 + 导出）
- `miniprogram/utils/mock.js`（generateShopOrders + ensureSeeded 两处补种 + 导出）
- `miniprogram/app.json`（注册新页面）
