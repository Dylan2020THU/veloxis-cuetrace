# 教练结算（店主端）设计 Spec

- 日期：2026-06-28
- 状态：待评审
- 所属：二期功能 · 店主端经营工具
- 视角：**店主结算教练**（店主查看并结清应付给本店教练的课时费）

## 1. 背景与目标

店主端「我的 → 经营工具」九宫格里的「教练结算」当前是 `act:'soon'` 占位（点了弹「二期上线」）。本期把它落地为可用功能。

底层数据已具备：
- 课时记录 `KEY_COACH_LESSONS`（云端 `coach_lessons` 集合），每条含 `coachOpenid / coachNickname / memberNickname / hallId / hallName / date / durationMinutes / amount`，由结算流程 `recordVerifiedTraining` 写入。
- 平台抽佣 `billing.calcCoachCommission(amount)`（费率 `COACH_COMMISSION_RATE = 0.05`）。
- 本店教练 `getShopCoaches()`；本店门店 `getShopStores()`。

**目标（MVP）**：店主能按周期查看每个教练的应付净额（课时费 − 5% 平台佣金），并「结算」（标记已结算 + 生成结算流水）。**不涉及真实打款**（线下结清；真实转账与「资金·提现」并入后续）。

## 2. 范围

**做（In scope）**
- 店主端单页「教练结算」：周期筛选 + 待结算合计 + 教练列表 + 点开同页明细 sheet + 结算动作。
- 数据层 `getShopCoachSettlement` / `getCoachSettlementDetail` / `settleCoach`（cloud + mock 双分支，mock 先跑通）。
- 课时加 `settled` 状态 + 新增结算流水表。
- 入口挂订阅墙（标准版起）。
- 演示数据：给本店教练补种课时，使页面有数。

**不做（Out of scope）**
- 真实打款 / 提现 / 资金账户（属「资金·结算」那一期）。
- 教练端自己的收入账单（本期只做店主视角）。
- 自定义任意日期区间（本期周期只给 本周/本月/全部 三档）。
- 导出 Excel、对账单 PDF。

## 3. 入口与订阅墙

- `pages/profile/index.js` 的 `SHOP_TOOLS` 中「教练结算」项 `act:'soon'` → `act:'coachSettle'`。
- `onTool` 新增分支 `case 'coachSettle'`：先过订阅墙，再进页面：
  ```js
  billing.requirePlan({ feature: 'shop.coachSettle', title: '教练结算' }).then((ok) => {
    if (!ok) return;
    wx.navigateTo({ url: '/pages/shop/coach-settlement/index' });
  });
  ```
- `utils/billing.js`：
  - `FEATURE_TO_PLAN['shop.coachSettle'] = 'shop_basic'`（标准版起，与「经营报表」同档）。
  - `getFeatureLabel` 增加 `'shop.coachSettle': '教练结算'`。
- 续费墙弹出依赖 `app.paywall`（本会话已修复 `inst.show` 调用）；profile 页已挂 `<paywall id="paywall">`，无需额外组件。试用期内 `requirePlan` 直接放行。

## 4. 页面结构（列表 + 明细合一页）

新页面 `pages/shop/coach-settlement/`（index.js/.wxml/.wxss/.json），注册进 `app.json`。

**主体（列表）**
- 顶部：周期分段「本周 / 本月 / 全部」（默认本月）。
- 概览条：当前周期「待结算合计 ¥X」（本店全部教练待结算净额之和）+「待结算教练 N 人」。
- 教练列表：每行
  - 头像 / 姓名
  - 待结算：`N 节 · 应付净额 ¥X`（醒目，品牌色）
  - 已结算：`¥Y`（次要、灰；**当前周期内**已结算净额，保持与周期筛选一致）
  - 待结算为 0 的教练排在后面、净额置灰。
- 空态：本周期无课时 → 「本周期暂无教练课时」。

**明细 sheet（点教练行同页弹出，`mask + sheet` 复用现有底部弹层样式）**
- 头部：教练名 + 周期标签。
- 汇总三联：课时费合计 `¥G` ／ 平台抽佣 5% `−¥C` ／ **应付净额 `¥N`**。
- 分段 Tab：待结算 / 已结算；列课时明细行（日期 · 会员 · 时长 · 金额）。
- 底部主按钮「结算 ¥N」：结清**当前周期**的全部待结算课时；待结算为 0 时禁用置灰。

## 5. 周期筛选

- 三档：`week`(本周, 周一~周日) / `month`(本月, 1 号~月底) / `all`(全部)。
- 周期**同时作用于展示与结算范围**：选「本月」→ 概览/列表/明细只统计本月课时，「结算」只结清本月待结算；选「全部」→ 全量。
- 周期 → 日期区间在前端计算（复用 `utils/date.js` 的 `today/addDays/toKey`）：`{ fromKey, toKey }`（含端点；`all` 时区间为空表示不限）。

## 6. 数据模型

**课时 `KEY_COACH_LESSONS`（'dc_coach_lessons' / 云端 `coach_lessons`）新增字段**
- `settled`: boolean（默认 false）
- `settledAt`: number（结算时间戳）
- `settlementId`: string（关联结算流水 _id）

**结算流水表（新）`KEY_COACH_SETTLEMENTS = 'dc_coach_settlements'`（云端 `coach_settlements`）**
```
{
  _id, shopOpenid, coachOpenid, coachNickname,
  lessonCount, grossAmount, commission, netAmount,
  periodFrom, periodTo,        // 结算覆盖的日期区间（''/'' 表示全部）
  createdAt
}
```

**归属判定（本店应结算的课时集合）**
```
本店课时 = KEY_COACH_LESSONS.filter(l =>
  shopCoachOpenids.includes(l.coachOpenid) &&   // getShopCoaches() 的 openid
  shopStoreIds.includes(l.hallId)               // getShopStores() 的 _id（+ shop.storeId）
  && inPeriod(l.date)                            // 选定周期
)
```

## 7. 数据层接口（services/data.js，均 cloud + mock 双分支）

- `getShopCoachSettlement(period)` → 概览聚合
  ```
  返回 {
    totalPendingNet,            // 当前周期本店待结算净额合计
    pendingCoachCount,
    coaches: [{ coachOpenid, nickname, avatar,
                pendingCount, pendingGross, pendingCommission, pendingNet,
                settledNet }]   // settledNet：该教练【当前周期内】已结算净额（与周期筛选一致）
  }
  ```
- `getCoachSettlementDetail(coachOpenid, period)` → 单教练明细
  ```
  返回 {
    coachOpenid, nickname,
    summary: { gross, commission, net },   // 当前周期待结算汇总
    pending: [lesson...],                  // 待结算课时（按日期倒序）
    settled: [lesson...]                   // 已结算课时（当前周期）
  }
  ```
- `settleCoach(coachOpenid, period)` → 结算动作
  - 取该教练当前周期 `settled !== true` 的本店课时；为空则 `{ ok:false, msg:'无待结算课时' }`。
  - 计算 `gross = Σ amount`，`commission = billing.calcCoachCommission(gross)`，`net = gross - commission`。
  - 写一笔 `coach_settlements` 流水（含 periodFrom/To）；把这些课时标 `settled=true / settledAt / settlementId`。
  - 返回 `{ ok:true, netAmount: net, lessonCount }`。

**佣金口径**：按**当期 gross 总额算一次** `calcCoachCommission`（四舍五入到分），避免逐条舍入误差累积。`net = gross − commission`。

## 8. 结算流程

1. 店主在明细 sheet 点「结算 ¥N」。
2. 二次确认 `wx.showModal`：「确认结清 教练X 本月 N 节课时，应付 ¥Net？」。
3. 确认 → `settleCoach(coachOpenid, period)`。
4. 成功 → toast「已结算」→ 关闭 sheet 或刷新 sheet → 刷新列表（待结算转入已结算累计）。
5. `r.ok === false` → toast `r.msg`。

## 9. 演示数据（seeding）

现有 `generateCoachLessons` 只给 `MOCK_OPENID` 播种，挂不到本店教练（coach_01..10）名下 → 结算页会空。

- 新增 `generateShopCoachLessons()`：给 `coach_01..10` 在本店门店（hall_01/02/03）确定性补种课时（含 `amount = durationMinutes × 单价`，单价取该教练 `pricePerMinute`），覆盖最近数十天，`settled` 默认 false。
- 在 `ensureSeeded` 全量播种 + 迁移自愈两处写入（仅当 `coach_lessons` 中无本店教练课时时补种），与本会话的自愈式补种一致，不覆盖已有数据、不动 `dc_role`。

## 10. 边界与错误处理

- 待结算为 0 → 「结算」按钮禁用；`settleCoach` 返回 `{ok:false}`。
- `settleCoach` **幂等**：只处理当前 `settled !== true` 的课时；重复点击不会重复结算（第二次待结算已为空）。
- `amount` 缺失/非数 → 按 0 计，不报错。
- 金额一律四舍五入到分；展示用「¥」+ 两位小数（或整数元，按现有风格）。
- 跨店：只统计/结算 `hallId ∈ 本店门店` 且 `coachOpenid ∈ 本店教练` 的课时，不串其它店/其它教练。
- 周期为 `all` 时不加日期过滤。
- 云端未部署对应函数时，mock 分支保证 devtools 可演示；真机走云端（见上云待办）。

## 11. 测试计划（独立 agent，Node 实跑）

1. 聚合正确：构造已知课时（多教练、含 amount、跨周期、部分已结算）→ `getShopCoachSettlement('month')` 的 pendingGross/commission/net、totalPendingNet、各教练 settledNet 与手算一致。
2. 周期：`week/month/all` 过滤的课时集合正确；`all` 不过滤。
3. `settleCoach('coachX','month')`：当月 pending → settled、生成一条流水（net=gross−5%、lessonCount 对）、被结课时打上 settlementId；再次调用幂等（第二次 `ok:false` 无待结算、不新增流水）。
4. 隔离：只结本店教练 + 本店门店课时；其它店/其它教练课时不受影响、不计入。
5. 边界：amount 缺失按 0；待结算 0 时 `ok:false`。
6. 入口路由：`onTool` 分发 `coachSettle` → 订阅放行后 `navigateTo` 到正确路径（requirePlan 试用期内放行）。
7. `node --check` 全部新增/改动 JS 通过；`app.json` 注册校验。

## 12. 上云待办（真机生效需部署）

- 新增云函数 `getShopCoachSettlement` / `settleCoach`（操作 `coach_lessons` 的 `settled` 字段 + 新 `coach_settlements` 集合）。
- `coach_lessons` 文档补 `settled/settledAt/settlementId` 字段（无需 schema 迁移，写时即加）。
- 云开发控制台新建 `coach_settlements` 集合。
- `recordVerifiedTraining` 云端写课时时确保带 `amount`（结算依赖该字段）。

## 13. 涉及文件清单

**新增**
- `miniprogram/pages/shop/coach-settlement/index.{js,wxml,wxss,json}`
- `cloudfunctions/getShopCoachSettlement/`、`cloudfunctions/settleCoach/`（index.js + package.json）

**改动**
- `miniprogram/pages/profile/index.js`（SHOP_TOOLS act + onTool 分支）
- `miniprogram/services/data.js`（三个数据函数 + 导出）
- `miniprogram/utils/mock.js`（KEY_COACH_SETTLEMENTS、generateShopCoachLessons、ensureSeeded 两处补种 + 导出）
- `miniprogram/utils/billing.js`（FEATURE_TO_PLAN + getFeatureLabel）
- `miniprogram/app.json`（注册新页面）
