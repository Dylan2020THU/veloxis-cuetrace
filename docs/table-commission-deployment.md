# 按桌抽成部署与验收手册

本文对应 `table_commission_v1`。本地代码、模拟账单和自动化测试只能证明程序契约，不能证明微信支付商户平台、网络、已发布小程序、官方次日账单或真实资金链路已经可用。完成本文最后一节前，生产发布必须保持关闭。

## 1. 首发业务边界

- 计费对象仅为顾客最终实付的球桌费，教练、商品、充值、券补贴和外部现金/POS 均不进入抽成基数。
- 标准综合成本为 5%，即 `commissionRateBps=500`，其中包含实际微信支付通道费；球厅目标净收入为顾客实付球桌费的 95%。
- 平台净收入为“5% 综合成本减实际通道费”。实际通道费超过 5% 时进入人工复核，由平台承担差额，不能向球厅追加扣款。
- 首发按 T+1：只有官方交易账单提供实际手续费证据后才允许分账。
- 退款按最终留存的顾客实付金额重新计算。全额退款后综合成本为零；优惠券补贴与顾客现金退款分别累计。
- `external_paid` 只用于店主确认的外部现金/POS 结账，必须记录原因，不分账、不抽成并进入独立报表。
- 新店主套餐、连续扣费和教练课时抽佣已经停用；历史记录只读保留，不迁移为新版订单。

## 2. 微信支付进件前置条件

按以下顺序完成外部配置，并保存审批截图、合同编号和操作审计：

1. 以普通服务商主体完成微信支付服务商申请，确认服务商 AppID 与服务商 MchID 已绑定。
2. 为每个店主经营主体完成特约商户进件，取得唯一 `subMchid`，并确认小程序支付产品权限。
3. 签署支付与分账合同，完成分账授权；服务商作为分账接收方时，关系类型固定为 `SERVICE_PROVIDER`。
4. 在微信支付侧建立接收方关系，并核对接收方名称与 `WXPAY_PLATFORM_RECEIVER_NAME` 完全一致。
5. 确定 OPENID 模式：`sp_openid` 使用服务商 AppID，`sub_openid` 必须配置并验证对应 `subAppid`。不得在两种模式间静默回退。
6. 验证该特约商户可以申请 `ALL` 交易账单，随后才把 `tradeBillModeVerified` 设为 `true`。

## 3. 门店支付档案与启停

`shop_payment_profiles/{shopId}` 只能由受控后台或管理员服务端写入，客户端无直接读写权限。首发字段如下；凭据不属于该文档：

| 字段 | 值或约束 |
| --- | --- |
| `_id`, `shopId` | 两者相同，均为已认证店主 ID |
| `schemaVersion` | `1` |
| `status` | 启用前为受控待审状态；可支付时为 `ready` |
| `onboardingStatus` | 可支付时为 `approved` |
| `contractStatus` | 可支付时为 `signed` |
| `profitSharingAuthorizationStatus` | 可支付时为 `authorized` |
| `paymentEnabled` | 仅控制新支付申领；外部验收完成前为 `false` |
| `profitSharingEnabled` | 新支付要求为 `true`；在途结算期间不得关闭 |
| `policyVersion` | `table_commission_v1` |
| `subMchid` | 对应经营主体的特约商户号；跨全部店主唯一，由数据库唯一索引强制 |
| `openidMode` | `sp_openid` 或 `sub_openid` |
| `subAppid` | `sp_openid` 时为空；`sub_openid` 时为已验证 AppID |
| `tradeBillModeVerified` | 只有真实验证 `ALL` 账单模式后才为 `true` |
| `createdAt`, `updatedAt`, 审核人字段 | 服务端时间和管理员审计信息 |

因此，`shop_payment_profiles` 的新支付门禁由 `paymentEnabled`、`profitSharingEnabled` 和 `tradeBillModeVerified` 共同构成；订单只保存非敏感的支付档案快照。

启用流程：先建立 `shop_payment_profiles.subMchid` 唯一索引并完成存量重复检查，再以两个 enable 字段均为 `false` 建档，完成进件、合同、分账授权、OPENID 和账单模式验证，最后把状态置为 `ready` 并由双人复核开启两个 enable 字段。唯一索引冲突必须中止启用，禁止复用其他店主的特约商户号。

回滚或暂停新支付时，只把 `paymentEnabled` 改为 `false`，保留 `status=ready`、进件/合同/分账授权状态、`profitSharingEnabled=true`、`tradeBillModeVerified=true` 和全部服务端凭据。这样新支付申领会被拒绝，而在途支付查询、回调、官方账单对账、分账、退款和退款查单仍继续运行。不要在仍有在途订单时关闭 `WXPAY_V3_ENABLED` 或删除档案、密钥、回调、定时器。

## 4. 云端环境变量

所有变量配置到相关云函数的加密环境或密钥管理服务。仓库、数据库、客户端、构建日志和工单中不得出现真实值。

| 变量 | 配置要求 |
| --- | --- |
| `WXPAY_V3_ENABLED` | 发布门禁；外部验收前保持 `false`，启用时为 `true` |
| `WXPAY_SP_APPID` | `<SERVICE_PROVIDER_APPID>`，已绑定服务商 MchID |
| `WXPAY_SP_MCHID` | `<SERVICE_PROVIDER_MCHID>` |
| `WXPAY_MERCHANT_SERIAL_NO` | `<MERCHANT_CERTIFICATE_SERIAL>` |
| `WXPAY_MERCHANT_PRIVATE_KEY` | `<SECRET_STORE_REFERENCE_FOR_RSA_PRIVATE_KEY>`，不得写入普通环境文件 |
| `WXPAY_API_V3_KEY` | `<SECRET_STORE_REFERENCE_FOR_32_BYTE_API_V3_KEY>` |
| `WXPAY_PLATFORM_CERTS_JSON` | `<TRUSTED_ID_TO_RSA_PUBLIC_KEY_JSON>`；键为平台证书序列号或官方 `PUB_KEY_ID_...`，值由密钥存储注入 |
| `WXPAY_ENCRYPTION_KEY_ID` | `<EXACT_TRUSTED_ENCRYPTION_KEY_ID>`；多把可信公钥时必填，且必须存在于上一个映射中 |
| `WXPAY_TABLE_NOTIFY_URL` | `<HTTPS_PAYMENT_CALLBACK_URL>`，映射到 `tablePayNotifyV3` |
| `WXPAY_TABLE_REFUND_NOTIFY_URL` | `<HTTPS_REFUND_CALLBACK_URL>`，映射到 `tableRefundNotifyV3` |
| `WXPAY_PLATFORM_RECEIVER_NAME` | `<APPROVED_SERVICE_PROVIDER_RECEIVER_NAME>`，必须与分账接收方一致 |

密钥轮换时先并存新旧可信验签公钥，再切换加密公钥 ID 和商户证书，完成已验签查询后才移除旧公钥。日志只能记录短哈希、确定性业务 ID 和错误分类，禁止记录私钥、APIv3 密钥、完整 OPENID、顾客入账账户、回调明文、付款码或 checkout token。

## 5. 云函数与访问边界

所有云函数使用各自目录内的部署副本和 `package.json` 安装依赖，不能依赖部署目录之外的相对路径。

| 云函数 | 访问级别 | 用途 |
| --- | --- | --- |
| `saveShopStore` | 店主专用 | 保存服务端规范化球桌与可信分价 |
| `requestCheckin` | 活动会员/教练 | 仅允许当前活动角色对精确门店球桌申请；事务内占用确定性角色槽位 |
| `getTableParticipants` | 本店店主或当前参与者 | 仅返回精确球桌的 `nickname/avatar/role/ready` 最小投影 |
| `createSession`, `getSessions` | 店主专用 | 开台与读取归属场次 |
| `closeSession` | 已停用 | 新请求固定返回 `PRODUCT_RETIRED` |
| `createTableOrder` | 店主专用 | 仅接受 `sessionId`，冻结服务端报价 |
| `markTableOrderExternalPaid` | 店主专用 | 必填原因的外部现金/POS 结账 |
| `genTableCheckoutCode` | 店主专用 | 生成只含一次性 token 的顾客结账码 |
| `getTableCheckoutOrder` | token 持有者 | 仅返回公开报价和状态字段 |
| `createTablePayOrder` | 已认证付款人 | 首位付款人绑定并创建服务商 JSAPI 预支付 |
| `tablePayNotifyV3` | 公开 HTTPS 回调 | 验签、解密并写入可信支付成功 |
| `reconcileTablePayments` | 内部定时器 | 对不确定支付执行签名查单 |
| `settleTableProfitSharing` | 内部定时器 | T+1 分账、结果查询与解冻 |
| `requestTableRefund` | 店主命令 + 内部定时器 | 店主申请退款；定时器主动恢复分账回退/退款状态 |
| `tableRefundNotifyV3` | 公开 HTTPS 回调 | 处理成功、关闭和异常退款通知 |
| `reconcileTableFinance` | 内部定时器 | 下载、校验、私存并匹配官方交易账单 |
| `getTodayRevenue`, `getShopBizOverview` | 店主专用 | 分开返回平台支付、外部结账和历史元制数据 |

除两个 HTTPS 回调外，不建立匿名公网入口。店主命令始终从可信 `OPENID` 推导归属，不能接受客户端传入 shop、金额、商户号、付款人或结算字段。内部定时器要求精确事件名且调用上下文没有 `OPENID`；客户端伪造 Timer 事件必须在数据库或网络访问前失败。

## 6. 定时器

以下七字段 cron 均按 `Asia/Shanghai` 解释，部署后要在云控制台复核时区和唯一触发器，不得重复创建：

| 函数 | 触发器 | cron | 说明 |
| --- | --- | --- | --- |
| `reconcileTablePayments` | `reconcileTablePaymentsTimer` | `0 */5 * * * * *` | 每 5 分钟恢复支付查单 |
| `settleTableProfitSharing` | `settleTableProfitSharingTimer` | `0 */5 * * * * *` | 每 5 分钟处理到期分账 |
| `requestTableRefund` | `reconcileTableRefundsTimer` | `0 */5 * * * * *` | 每 5 分钟恢复分账回退和退款查单 |
| `reconcileTableFinance` | `reconcileTableFinanceTimer` | `0 15 10 * * * *` | 每日 10:15 处理官方前一日账单及未完成运行 |

`createRecurringDebit/config.json` 必须保持无触发器，不能恢复订阅扣费。

## 7. HTTPS 回调代理

为付款和退款分别配置独立 HTTPS 路由。网关或代理必须：

1. 保留未经解析、未经重新编码的请求 body 字节；若平台以 base64 传递，必须同时传递原始编码标志，由 `http-event` 统一还原。
2. 原样转发 `Wechatpay-Timestamp`、`Wechatpay-Nonce`、`Wechatpay-Serial`、`Wechatpay-Signature`；不得拼接、裁剪或改写大小写对应的值。
3. 禁止在验签前 JSON 解析、日志格式化或字符集转换。
4. 只允许 `tablePayNotifyV3` 使用付款 URL，`tableRefundNotifyV3` 使用退款 URL；两者都先验签再解密。
5. 健康检查不能伪造成功业务回调。签名、时间窗、密文、商户身份、订单身份或金额不匹配时必须失败。

退款通知外层 `create_time` 使用严格 RFC3339；`REFUND.SUCCESS`、`REFUND.CLOSED`、`REFUND.ABNORMAL` 必须与解密后的状态一致。`associated_data` 可缺省，缺省时按空附加数据解密；存在时必须为字符串。

## 8. 集合与最小权限

最小权限原则是：客户端永远不能直接写财务事实。所有订单状态、支付/退款结果、手续费、分账、异常和财务事件只能由相应云函数事务写入。

| 集合 | 用途与权限 |
| --- | --- |
| `accounts` | 店主业务账号与启用状态；客户端禁止直接修改授权字段 |
| `wechat_bindings` | `sha256(wechat:OPENID)` 到业务账号的确定性绑定；客户端禁止直写 |
| `users` | 当前角色依据；退款和经营报表要求活动账号具备 `shop` 角色 |
| `stores` | 门店和球桌可信价格；店主通过云函数维护 |
| `checkin_requests` | 到店请求与已确认绑定证据；仅云函数读写，终态证据不得覆盖 |
| `table_checkin_slots` | `sha256(checkin-slot\0storeId\0tableId\0role)` 确定性角色槽位；仅云函数以精确文档事务读写 |
| `sessions` | 新版开台、报价和关闭状态；客户端禁止直写 |
| `table_occupancies` | `storeId + tableId` 确定性占用锁；仅云函数读写 |
| `shop_orders` | 历史记账与 `schemaVersion=2` 可信订单；仅云函数写财务字段 |
| `shop_payment_profiles` | 特约商户支付档案；仅受控管理员服务端写 |
| `billing_policies` | 不可变策略审计；`table_commission_v1` 固定 500 bps、包含通道费、T+1 |
| `financial_events` | 追加式不可变支付、手续费、分账、解冻、退款事件；禁止更新和删除既有事件 |
| `shop_refunds` | 每次退款、确定性退款号、回退、查单和累计快照；店主只能通过命令云函数申请 |
| `wechat_bill_artifacts` | 官方账单哈希、短期下载元数据和解析状态；服务端专用 |
| `finance_reconciliation_runs` | 每个账单日的租约、重试与完成摘要；服务端专用 |
| `finance_anomalies` | `status=open`、`billDate`、`severity=blocking` 的确定性异常；服务端专用 |

`billing_policies/table_commission_v1` 是代码策略的审计镜像，必须保存 `policyVersion=table_commission_v1`、`billingMode=table_commission`、`commissionRateBps=500`、`includesChannelFee=true`、`splitCycle=T_PLUS_1`、`status=active` 及批准审计。订单引用后不得修改该文档，只能新增策略版本；首发运行时仍以代码常量和订单快照为可信计算输入。

`table_checkin_slots` 文档固定包含 `schemaVersion=1`、精确 `storeId/tableId/role`、`currentRequestId/memberOpenid`、`status`、`sessionId/boundAt` 和服务端 `updatedAt`。到店请求、槽位和球桌占用均通过确定性文档 ID 精确读取，不需要为这一访问路径新增查询索引；客户端不得直接读取槽位或完整到店请求。

分账或解冻首次出现远端未决/查询不确定时，订单必须持久化 `splitRecovery.firstUncertainAtMs`、当前查询阶段和逐次 `attemptEvidence`。未满 24 小时只能使用原 `splitNo`/`unfreezeNo` 查单恢复，不能重复提交已经进入查询阶段的添加接收方、分账或解冻请求；首次调用解冻前也必须先用当前 claim 做 CAS，持久化 `unfreeze_query` 提交意图。每次添加接收方、分账、查单或解冻远端调用前都必须重新读取时钟并在事务中校验当前 claim 与截止点，claim 成功后恰好跨越 24 小时也不得发起远端调用。下一次调度时间不得晚于 24 小时截止点。达到截止点后必须在同一事务中把订单置为 `manual_review`、设置 `financeAutomationBlocked=true`，并用确定性 ID 写入 `source=profit_sharing`、`status=open`、`severity=blocking` 的 `finance_anomalies`，之后定时器不得再产生远端副作用。同 ID 的既有异常必须校验身份和来源并重新打开为 blocking；若身份或来源冲突，不得覆盖原记录，必须另建确定性的 blocking 冲突异常。部署前已存在且没有 `splitRecovery` 的 `processing/failed` 订单，以原 `splitClaim.claimedAt` 作为首次不确定时间并仅做同号查询；若部署时已达到 24 小时则直接进入人工队列。

## 9. 必建索引

在生产写入前按下列顺序创建复合索引。`ASC` 表示升序；标为唯一的索引在建索引前必须先完成重复检查。`shop_orders` 继续保留旧版记账记录，历史订单的缺失/空值不能用于唯一索引，因此新版订单身份字段使用普通索引；服务端查询固定 `limit=2`，任何碰撞都 fail closed，不得任选一条继续处理。新版订单自身以确定性订单主键、确定性商户单号和高熵 token 哈希降低碰撞风险。

| 集合/用途 | 精确字段顺序 | 类型 |
| --- | --- | --- |
| `shop_orders` token | `checkoutTokenHash ASC` | 普通；兼容历史缺失字段，碰撞查询必须拒绝 |
| `shop_orders` 商户支付单号 | `outTradeNo ASC` | 普通；兼容历史缺失字段，确定性碰撞必须拒绝 |
| `shop_orders` 历史支付尝试号 | `previousOutTradeNos ASC` | 普通多键索引；回调/查单按旧号归回同一逻辑订单，任何跨订单碰撞必须拒绝 |
| `shop_orders` 微信交易号 | `wechatTransactionId ASC` | 普通确定性查找；未支付订单使用空串占位，不能直接设全表唯一 |
| `shop_orders` 三项身份审计 | `checkoutTokenHash ASC, outTradeNo ASC, wechatTransactionId ASC` | 普通 |
| `shop_orders` 支付不确定态 | `schemaVersion ASC, orderStatus ASC, paymentStatus ASC, paymentClaim.status ASC, paymentClaim.nextReconcileAt ASC, paymentClaim.claimedAt ASC, _id ASC` | 普通 |
| `shop_orders` 创建租约过期 | `schemaVersion ASC, orderStatus ASC, paymentStatus ASC, paymentClaim.status ASC, paymentClaim.leaseExpiresAt ASC, paymentClaim.nextReconcileAt ASC, paymentClaim.claimedAt ASC, _id ASC` | 普通 |
| `shop_orders` 预支付过期 | `schemaVersion ASC, orderStatus ASC, paymentStatus ASC, paymentClaim.status ASC, prepayExpiresAt ASC, paymentClaim.nextReconcileAt ASC, paymentClaim.claimedAt ASC, _id ASC` | 普通 |
| `shop_orders` 分账到期 | `schemaVersion ASC, orderStatus ASC, paymentStatus ASC, splitStatus ASC, splitNextAttemptAt ASC, paidAt ASC, _id ASC` | 普通 |
| `shop_orders` 分账租约过期 | `schemaVersion ASC, orderStatus ASC, paymentStatus ASC, splitStatus ASC, splitClaim.leaseExpiresAt ASC, splitNextAttemptAt ASC, paidAt ASC, _id ASC` | 普通 |
| `shop_orders` 分账商户审计 | `paymentProfileSnapshot.subMchid ASC, paymentStatus ASC, splitStatus ASC, paidAt ASC, _id ASC` | 普通 |
| `shop_orders` 旧订单日期报表 | `_openid ASC, date ASC` | 普通；`getTodayRevenue` 按日期等值查询，`getShopBizOverview` 按日期范围查询；两者均无显式 `orderBy` |
| `shop_orders` 新版报表 | `_openid ASC, schemaVersion ASC, orderStatus ASC, checkoutAt ASC, _id ASC` | 普通 |
| `shop_orders` 新版报表实际查询 | `_openid ASC, schemaVersion ASC, checkoutAt ASC, _id ASC` | 普通 |
| `shop_orders` 官方付款账单 | `schemaVersion ASC, paymentProfileSnapshot.subMchid ASC, paidAt ASC, _id ASC` | 普通 |
| `shop_orders` 迟到付款回补 | `schemaVersion ASC, orderStatus ASC, paymentStatus ASC, paymentBillFeeEvidence ASC, paymentBillDiscoveryCompletedAt ASC, paidAt ASC, _id ASC` | 普通；新订单显式初始化两个回补字段为 `null`，已尝试人工单会写完成标记避免饿死队列 |
| `shop_refunds` 订单状态 | `orderId ASC, status ASC, refundNo ASC` | 普通；`_id=refundNo` 为确定性主键 |
| `shop_refunds` 恢复到期 | `schemaVersion ASC, status ASC, refundNextAttemptAt ASC, requestedAt ASC, _id ASC` | 普通 |
| `shop_refunds` 首次恢复 | `schemaVersion ASC, status ASC, refundNextAttemptAt ASC, refundClaim.leaseExpiresAt ASC, requestedAt ASC, _id ASC` | 普通 |
| `shop_refunds` 官方创建日 | `subMchid ASC, refundCreatedAt ASC, _id ASC` | 普通 |
| `shop_refunds` 请求日后备 | `subMchid ASC, refundCreatedAt ASC, requestedAt ASC, _id ASC` | 普通；仅 `refundCreatedAt` 缺失时使用 |
| `shop_refunds` 订单对账 | `orderId ASC, _id ASC` | 普通 |
| `shop_payment_profiles` 特约商户唯一性 | `subMchid ASC` | 唯一；建索引前先完成跨店主重复检查 |
| `shop_payment_profiles` 账单档案 | `schemaVersion ASC, status ASC, policyVersion ASC, _id ASC` | 普通；enable 字段不参与，以保证回滚后在途对账 |
| `finance_reconciliation_runs` 过期运行恢复 | `status ASC, leaseExpiresAt ASC, billDate ASC` | 普通 |
| `financial_events` 审计 | `orderId ASC, eventType ASC, createdAt ASC, _id ASC` | 普通 |
| `finance_anomalies` 运维队列 | `status ASC, billDate ASC, severity ASC` | 普通 |
| `sessions` 店主门店状态 | `shopId ASC, storeId ASC, status ASC, startedAt ASC, _id ASC` | 普通 |
| `table_occupancies` 门店状态 | `shopId ASC, storeId ASC, status ASC, _id ASC` | 普通；占用 `_id` 仍为确定性锁 |

索引创建完成后，用生产同结构的空白环境逐条执行对应查询；缺索引、返回未排序或触发全表扫描均不得发布。

首发版财务对账采用明确的受控容量：启用支付档案总数不得超过 100；每个 `subMchid` 每个北京时间自然日的订单数和退款数分别不得超过 100。运维必须对 80% 容量设置预警，并在每次新增门店或流量活动前复核。超过任一门槛前必须先上线游标分页并完成账单日跨页、重放和故障恢复测试；不得依赖当前上限后返回人工异常来替代逐笔 T+1 对账。

## 10. 私有账单存储

交易账单只写入 `finance/bills/{date}/{subMchid}/trade.csv`。在 CloudBase 存储安全规则中对 `finance/bills/**` 明确设置：小程序客户端读取拒绝、客户端写入拒绝，只有运行财务对账云函数的服务身份可上传和读取。`wechat_bill_artifacts` 中的 `storageVisibility` 必须为 `private`，但数据库元数据不能替代真实存储规则。

发布前必须用普通小程序身份验证该路径读写均被拒绝，再用财务云函数服务身份验证上传、SHA1 回读和解析成功。原始字节不得覆盖；相同确定性 artifact ID 的不同 SHA1 必须冻结并告警。保留期由财务、法务和税务共同批准，应用代码不得自行删除原始账单或财务事件。

## 11. 确定性与审计

- 订单 ID 由场次 ID 确定；首个 `outTradeNo` 由订单派生，微信明确 `CLOSED` 后的新 attempt 号由订单 ID 与递增 attempt 序号确定性派生；分账号、解冻号、退款号和分账回退号同样由稳定业务身份派生。
- 支付首次 claim 必须在联网前写入 `paymentAttemptNo`、`previousOutTradeNos` 和精确 `paymentRequestBody`。`NOTPAY` 只能用当前 `outTradeNo` 与完全相同请求体重下；`CLOSED` 才能把旧号追加到历史映射并仅替换新 `out_trade_no`。
- checkout token 只向二维码/付款人展示一次，数据库仅保存 SHA-256；日志和文档不得保存 token 明文。
- 微信回调和查询只通过同一事务状态机写可信结果。小程序 `wx.requestPayment` 成功回调只启动服务端轮询，不能直接标记已支付。
- `financial_events` 使用确定性事件 ID，采用追加式不可变写入；已有事件内容冲突时进入人工复核，禁止覆盖。
- `wechat_bill_artifacts`、`finance_reconciliation_runs`、`finance_anomalies` 均使用确定性 ID，重试不得复制证据或异常。
- 外部现金/POS 只记录店主、原因和时间，不伪造微信交易号、验证课时或财务事件。

## 12. 故障恢复手册

| 场景 | 处理 |
| --- | --- |
| 支付结果不确定或 `prepay_id` 超过 2 小时 | 保持 `awaiting_payment/unpaid` 并先用当前 `outTradeNo` 签名查单；仅 `SUCCESS` 可写 paid，`NOTPAY` 以 CAS/write-ahead 原号原参数重下，`CLOSED` 以确定性新 attempt 号重下并保留旧号映射；网络错误继续查同号，禁止由本地超时推断失败 |
| 训练/教练课确定性快照冲突 | 不覆盖既有快照；支付成功事实、关台和占用释放照常落账，同时写确定性、去 PII 的 blocking entitlement anomaly 并把订单置为 `manual_review`；精确重复回调必须幂等 |
| 官方账单尚未生成或网络失败 | 当次运行保持可重试，不标记完成；后续运行继续最早未完成账单日 |
| 账单 SHA1/行身份冲突 | 保留原 artifact，创建 blocking 异常并冻结受影响订单；不得覆盖文件或继续分账 |
| 实际手续费超过 5% | 进入 `manual_review`，平台吸收超额通道费；球厅 95% 目标不变 |
| 分账失败或状态不确定 | 未满 24 小时使用同一分账号/解冻号查单恢复；达到 24 小时立即停止自动操作并进入 blocking 人工队列；只有官方终态成功后解冻，禁止创建第二业务单号 |
| 分账回退失败 | 用同一 `out_return_no` 查单；明确查无后才重发原请求，成功前不申请后续退款 |
| 退款处理中或回调丢失 | `reconcileTableRefundsTimer` 主动查询；`CLOSED/ABNORMAL` 进入人工复核，不写退款成功事件 |
| 退款身份、金额或事件冲突 | 保留累计金额和 pre-refund 证据，冻结自动化；以签名查询和官方账单为准 |
| 人工复核释放 | 收集 order/refund/artifact/anomaly/event ID，完成微信侧证据核验和财务+工程双签；只能通过受审计的服务端事务工具修正并追加更正事件，禁止客户端或控制台散改。当前版本没有自动释放端点，未完成该工具与双签时保持冻结 |

任何恢复操作都必须先查官方状态，再决定是否重发；不得因为本地超时推断微信侧失败。

## 13. 部署顺序与回滚检查

1. 创建集合、最小权限和全部索引；配置并实测 `finance/bills/**` 私有规则。
2. 建立仍关闭的支付档案和 `billing_policies/table_commission_v1` 审计文档。
3. 在密钥存储配置全部 `WXPAY_*`，此时 `WXPAY_V3_ENABLED=false`。
4. 部署本手册列出的云函数及目录内依赖，复核四个唯一触发器和 `Asia/Shanghai` 时区。
5. 发布两个 HTTPS 回调代理，完成原始 body、四个 `Wechatpay-*` 头和错误响应验证。
6. 发布包含 `pages/table-checkout/index` 的小程序并在真实设备验证二维码、单付款人和服务端轮询。
7. 完成外部验收后，先开启 `WXPAY_V3_ENABLED`，再逐店双人复核开启档案。

发现异常时先把受影响档案 `paymentEnabled=false`，保留所有在途处理能力。回滚检查应确认新预支付被拒绝、已有付款回调/查单仍成功、账单运行仍包含已停新支付的档案、退款和分账定时器仍工作。

## 14. 真实资金验收门槛

以下均为外部验收，不能由本地测试勾选。全部完成前，真实资金验收状态为“未通过”：

- [ ] 普通服务商申请获批，服务商 AppID/MchID 绑定验证完成。
- [ ] 特约商户进件完成，支付合同、分账合同和分账授权生效，`SERVICE_PROVIDER` 接收方关系可查。
- [ ] 生产商户私钥、APIv3 密钥、可信平台证书/公钥及明确的加密公钥 ID 已进入密钥存储。
- [ ] 付款和退款 HTTPS 回调在公网可达，并通过原始 body 与四个 `Wechatpay-*` 头验签测试。
- [ ] 小程序结账页已发布，真实设备扫码、首位付款人绑定和服务端状态轮询通过。
- [ ] 财务、法务和税务对 5% 综合成本、发票、留存期和争议处理完成签字。
- [ ] 完成一笔真实小额支付，并以签名通知或查单确认，客户端未自行标记成功。
- [ ] 次日取得官方 `ALL` 交易账单，SHA1、支付行和实际手续费匹配，生成唯一 `channel_fee_confirmed`。
- [ ] 完成分账、分账查询和解冻，金额等于 5% 综合成本减实际通道费。
- [ ] 完成一次部分退款及必要的分账回退，并在后续官方负手续费行中完成重算。
- [ ] 完成同一订单的全额退款，确认最终顾客实付、综合成本和平台净收入均归零，并完成后续账单对账。
- [ ] 验证关闭新支付后，在途回调、查单、账单对账、分账和退款仍继续运行。

本地代码完成与真实资金验收是两个独立结论。只有上述清单全部留有可审计证据，才能把门店支付档案正式启用。
