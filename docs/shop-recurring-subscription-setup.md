# 历史归档：店主端连续订阅已退役

店主套餐、连续签约和周期扣款不属于当前按桌抽成模式。`createRecurringContract`、`createRecurringDebit` 与 `reconcilePay` 均返回 `PRODUCT_RETIRED`，相关定时触发器为空。

禁止部署、启用或手动触发新的签约与扣款流程，也不要配置下方历史环境变量。仅为历史回调和解约兼容保留对应文件；当前没有已购买套餐或连续扣费合约，无需执行迁移。

以下内容仅为退役前历史记录，已从渲染文档隐藏，不是上线步骤。

<!-- RETIRED_HISTORICAL_REFERENCE

# 店主端连续订阅配置清单

张总，代码侧已经预留连续包月、包季、包年的签约、扣款、解约和回调云函数。上线前还需要完成以下外部配置，否则连续订阅入口会安全提示“尚未配置”，不会扣费。

## 微信支付商户平台

1. 开通「委托代扣 / 周期扣费」能力。
2. 创建周期扣费协议模板并通过审核：
   - 包月模板，写入云函数环境变量 `PAP_PLAN_ID_MONTH`
   - 包季模板，写入云函数环境变量 `PAP_PLAN_ID_QUARTER`
   - 包年模板，写入云函数环境变量 `PAP_PLAN_ID_YEAR`
3. 当前接入模式已确认为普通商户 / 直连商户：
   - 小程序 AppID：`wxa7c9920cda26d7ca`
   - 商户号 mch_id：`1747055604`
   - 不需要 `sub_mch_id`
4. 在小程序管理后台确认可跳转微信签约小程序 `wxbd687630cd02ce1d`。

## 回调域名

委托代扣签约回调和扣款回调必须使用公网 HTTPS 地址，不能使用本地地址。

需要准备：

- `PAP_CONTRACT_NOTIFY_URL`：签约 / 解约结果回调。
- `PAP_DEBIT_NOTIFY_URL`：周期扣款结果回调。

## 云函数环境变量

在云开发控制台为相关云函数配置：

```text
PAP_APPID
PAP_MCH_ID
PAP_SIGN_KEY
PAP_CONTRACT_NOTIFY_URL
PAP_DEBIT_NOTIFY_URL
PAP_PLAN_ID_MONTH
PAP_PLAN_ID_QUARTER
PAP_PLAN_ID_YEAR
```

涉及云函数：

```text
createRecurringContract
recurringContractCallback
cancelRecurringContract
createRecurringDebit
recurringDebitCallback
```

## 部署顺序

1. 上传并部署以上 5 个云函数。
2. 配置云函数环境变量。
3. 在微信支付后台配置签约与扣款回调 URL。
4. 确认 `createRecurringDebit/config.json` 的定时触发符合实际扣费策略；默认每天 10:00 处理到期订阅。
5. 使用测试商户或小额套餐完成签约测试。
6. 手动触发 `createRecurringDebit` 做一次周期扣款测试。
7. 检查 `orders`、`subscriptions`、`users.per_role.shop` 三处数据是否一致。

## 验收标准

- 单次购买仍走原支付路径，不自动续费。
- 连续订阅未配置时不会扣款，页面给出明确提示。
- 连续订阅配置齐全后，用户先跳转微信签约小程序。
- 签约回调写入 `subscriptions.contractId`。
- 周期扣款成功后，`users.per_role.shop.planExpiresAt` 顺延。
- 用户取消连续订阅后，不再继续发起后续扣款。

-->
