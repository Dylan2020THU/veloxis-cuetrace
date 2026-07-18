# Table Commission Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace active shop subscriptions and coach commission with a server-trusted table-fee payment flow whose first-release total transaction cost is 5% including the actual WeChat Pay channel fee, with APIv3 service-provider payment, T+1 profit sharing, refunds, reconciliation, and an explicitly separated external-payment exception.

**Architecture:** Keep legacy subscription data and callbacks read-only, but fail closed for every endpoint that can create new subscription charges. Introduce versioned table sessions and orders whose amounts are calculated from an immutable server-side pricing snapshot. Put deterministic money and state logic in deployable shared modules, wrap WeChat Pay APIv3 behind a fail-closed Node.js adapter, and expose separate cloud functions for payer checkout, signed notifications, compensation, profit sharing, refunds, and T+1 bill reconciliation.

**Tech Stack:** Native WeChat Mini Program JavaScript/WXML/WXSS, CloudBase Node.js cloud functions, `wx-server-sdk ~2.6.3`, Node built-in `crypto`/`https`, CloudBase database transactions and storage, standalone Node assertion tests.

## Global Constraints

- Every amount used by the new flow is an integer number of fen. Floating-point yuan is presentation-only.
- Standard policy is immutable `table_commission_v1`: `billingMode=table_commission`, `commissionRateBps=500`, `includesChannelFee=true`, `splitCycle=T_PLUS_1`.
- Commission base is only the final retained customer-paid table fee. Coach fees, goods, recharge, and coupon subsidies are excluded.
- `totalCostFen = round(paidTableFeeFen * 500 / 10000)` and `shopNetFen = paidTableFeeFen - totalCostFen`.
- `platformNetFen = totalCostFen - actualChannelFeeFen`. If this is negative, the order enters `manual_review`; the shop's 95% target is not reduced.
- New orders use `schemaVersion=2`. Records without `schemaVersion` stay historical and never enter real GMV, profit sharing, or commission.
- Session transitions are only `active -> awaiting_payment -> closed`.
- Order dimensions are exactly:
  - `orderStatus`: `awaiting_payment | complete | external_paid | canceled | manual_review`
  - `paymentStatus`: `not_applicable | unpaid | paid | partially_refunded | refunded | closed`
  - `splitStatus`: `not_applicable | pending | processing | succeeded | failed | reversed`
- Client-supplied amount, duration, shop, store, table, fee rate, and payment result are never trusted.
- WeChat payment success is established only by a verified/decrypted APIv3 notification or a verified APIv3 query response.
- Missing credentials, payment profile, platform certificate/public key, callback URL, actual channel fee, or bill match must fail closed. No test or demo path may mark real finance state successful.
- External payment is owner-only in this release because the project has no manager ACL model. It requires a reason, uses `external_paid`, has zero automatic commission, and stays separate in reporting.
- Preserve files and legacy records; do not delete anything. Keep cancellation and late-callback compatibility for historical subscription data.
- The repository has no `HEAD`; do not initialize or commit without Zhang's explicit authorization. Task checkpoints are recorded in `.superpowers/sdd/progress.md` instead of Git commits.
- The Node.js WeChat Pay implementation is an AI-translated reference based on official Java/API documentation, not officially maintained. Each adapter source must carry the approved disclaimer.
- Official source set:
  - `https://pay.weixin.qq.com/doc/v3/partner/4012759974.md` service-provider mini-program order
  - `https://pay.weixin.qq.com/doc/v3/partner/4012085827.md` mini-program payment invocation
  - `https://pay.weixin.qq.com/doc/v3/partner/4012760115.md` query by merchant order number
  - `https://pay.weixin.qq.com/doc/v3/partner/4012085801.md` payment notification
  - `https://pay.weixin.qq.com/doc/v3/partner/4012760121.md` refund
  - `https://pay.weixin.qq.com/doc/v3/partner/4012085802.md` refund notification
  - `https://pay.weixin.qq.com/doc/v3/partner/4012690944.md` add profit-sharing receiver
  - `https://pay.weixin.qq.com/doc/v3/partner/4012690683.md` profit sharing
  - `https://pay.weixin.qq.com/doc/v3/partner/4012466854.md` profit-sharing return
  - `https://pay.weixin.qq.com/doc/v3/partner/4012466860.md` unfreeze remaining funds
  - `https://pay.weixin.qq.com/doc/v3/partner/4013080595.md` trade bill
  - `https://pay.weixin.qq.com/doc/v3/partner/4013080596.md` fund bill
  - `https://pay.weixin.qq.com/doc/v3/partner/4012365870.md` APIv3 signing/verification
  - `https://pay.weixin.qq.com/doc/v3/partner/4012082320.md` AES-256-GCM notification decryption

## Task 1: Verification Harness and Finance Core

**Files:**
- Create: `tests/tableCommissionMath.test.js`
- Create: `tests/tableFinanceState.test.js`
- Create: `tests/codexVerifyUnborn.test.js`
- Create: `cloudfunctions/_shared/table-finance/money.js`
- Create: `cloudfunctions/_shared/table-finance/state.js`
- Modify: `scripts/codex-verify.ps1`

- [ ] Write RED tests for integer-fen validation, 500-bps rounding, 95% shop net, unknown fee, fee over total cost, zero/full refund, and multi-partial-refund recomputation.
- [ ] Run `& $NODE tests/tableCommissionMath.test.js`; verify it fails because `money.js` does not exist.
- [ ] Implement this exact public API:

```js
const STANDARD_POLICY = Object.freeze({
  policyVersion: 'table_commission_v1',
  billingMode: 'table_commission',
  commissionRateBps: 500,
  includesChannelFee: true,
  splitCycle: 'T_PLUS_1'
});

function calculateSettlement(paidTableFeeFen, channelFeeFen, policy = STANDARD_POLICY) {}
function recalculateAfterRefund(originalPaidFen, cumulativeRefundFen, netChannelFeeFen, policy = STANDARD_POLICY) {}
function yuanTextToFen(value) {}
```

- [ ] Run the money test again; verify all cases pass.
- [ ] Write RED tests for all allowed session/order/payment/split transitions and deterministic IDs no longer than WeChat's documented limits.
- [ ] Implement `assertTransition(kind, from, to)`, `orderIdForSession(sessionId)`, `outTradeNoForOrder(orderId)`, `splitNoForOrder(orderId)`, `refundNoForOrder(orderId, idempotencyKey)`, and `financialEventId(type, businessId)` in `state.js`.
- [ ] Run `& $NODE tests/tableFinanceState.test.js`; verify green.
- [ ] Write a RED static test proving `codex-verify.ps1` supports an unborn branch without `merge-base HEAD main` and still checks every untracked text/JS file.
- [ ] Modify `codex-verify.ps1`: detect `git rev-parse --verify HEAD`; on unborn branches use only `git ls-files --others --exclude-standard`, skip Git diff checks that cannot inspect untracked files, retain JS syntax, UTF-8, whitespace, conflict-marker, and named-test checks.
- [ ] Run `& $NODE tests/codexVerifyUnborn.test.js`; verify green.

## Task 2: Retire New Legacy Charges and Coach Commission

**Files:**
- Create: `tests/legacyBillingRetirement.test.js`
- Create: `tests/coachCommissionRetirement.test.js`
- Modify: `miniprogram/utils/billing.js`
- Modify: `miniprogram/components/paywall/index.js`
- Modify: `miniprogram/pages/shop/dashboard/index.js`
- Modify: `miniprogram/pages/shop/dashboard/index.wxml`
- Modify: `miniprogram/pages/profile/index.js`
- Modify: `miniprogram/pages/profile/index.wxml`
- Modify: `miniprogram/pages/shop/brand-add/index.js`
- Modify: `miniprogram/app.js`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/services/data.js`
- Modify: `cloudfunctions/upgradePlan/index.js`
- Modify: `cloudfunctions/createPayOrder/index.js`
- Modify: `cloudfunctions/createVirtualPayOrder/index.js`
- Modify: `cloudfunctions/createRecurringContract/index.js`
- Modify: `cloudfunctions/createRecurringDebit/index.js`
- Modify: `cloudfunctions/createRecurringDebit/config.json`
- Modify: `cloudfunctions/createBooking/index.js`
- Modify: `cloudfunctions/getShopCoachSettlement/index.js`
- Modify: `cloudfunctions/getCoachSettlementDetail/index.js`
- Modify: `cloudfunctions/settleCoach/index.js`
- Modify: `cloudfunctions/recordVerifiedTraining/index.js`
- Modify: `miniprogram/pages/coach/bookings/index.js`
- Modify: `miniprogram/pages/coach/bookings/index.wxml`
- Modify: `miniprogram/pages/shop/coach-settlement/index.wxml`
- Modify: `miniprogram/pages/legal/index.js`
- Rewrite expectations: `tests/shopSubscriptionPlans.test.js`
- Rewrite expectations: `tests/recurringCloudFunctions.test.js`

- [ ] Write RED tests asserting: shop features are free; plan list is empty; no visible subscription/renewal UI; no `FORCE_VIRTUAL_PAY_FOR_TEST`; active purchase/signing/debit endpoints return `{ok:false, code:'PRODUCT_RETIRED'}` before writes/network; the recurring debit config has no triggers; historical cancellation/callback files remain.
- [ ] Run the retirement test and confirm current subscription behavior makes it fail.
- [ ] Make the minimum retirement changes. Preserve exported billing functions as compatibility interfaces, but make `canUse/requirePlan` allow shop features and all active purchase helpers fail closed.
- [ ] Write RED tests asserting new coach bookings omit `commissionRate`, current unsettled commission is zero, `net=gross`, settled historical snapshots are not recomputed, and visible “抽佣5%/平台服务费” copy is absent.
- [ ] Run the coach test and confirm it fails against the current 5% behavior.
- [ ] Set new coach commission to zero across client and cloud settlement paths. Pass `amount: 0` when verified training records are generated from a table session so table fee is never mistaken for coach fee.
- [ ] Run both focused tests plus `tests/recurringSubscriptionGuard.test.js` and `tests/accountDeletionGracePeriod.test.js`; verify historical compatibility remains green.

## Task 3: Trusted Table Configuration, Sessions, and Checkout Orders

**Files:**
- Create: `tests/tableSessionOrderFlow.test.js`
- Create: `cloudfunctions/createSession/lib/money.js`
- Create: `cloudfunctions/createSession/lib/state.js`
- Create: `cloudfunctions/createTableOrder/lib/money.js`
- Create: `cloudfunctions/createTableOrder/lib/state.js`
- Create: `cloudfunctions/markTableOrderExternalPaid/index.js`
- Create: `cloudfunctions/markTableOrderExternalPaid/package.json`
- Modify: `cloudfunctions/saveShopStore/index.js`
- Modify: `cloudfunctions/createSession/index.js`
- Modify: `cloudfunctions/getSessions/index.js`
- Modify: `cloudfunctions/closeSession/index.js`
- Modify: `cloudfunctions/createTableOrder/index.js`
- Modify: `miniprogram/pages/shop/table-types/index.js`
- Modify: `miniprogram/pages/shop/brand-add/index.js`
- Modify: `miniprogram/services/data.js`

- [ ] Write RED CloudBase-fake tests for store ownership, stable table IDs, immutable `pricePerHourFen`, same-table concurrency, cross-owner rejection, `active -> awaiting_payment`, client-field rejection, repeated checkout returning the same order, transaction rollback, and owner-only external payment with a required reason.
- [ ] Run `& $NODE tests/tableSessionOrderFlow.test.js`; verify failures are behavior failures.
- [ ] Normalize each saved table entry to `{tableId,name,pricePerHourFen,pricePerHour,image,bgColor,pricingRuleVersion:'hourly_exact_v1'}`. Preserve an existing `tableId`; otherwise derive one once with a collision-resistant 20-character identifier.
- [ ] In `createSession`, verify bound shop role and store ownership, locate the exact server-side table, and use deterministic occupancy document ID `storeId__tableId` inside a transaction. Save `schemaVersion=2`, `shopId=OPENID`, `pricingSnapshot`, `openedBy`, and server timestamps.
- [ ] In `createTableOrder`, reject every legacy finance input (`amount`, `durationMin`, `storeId`, `tableId`, rate fields), accept only `sessionId`, freeze `checkoutAt`, compute exact elapsed-millisecond hourly price as `Math.round(elapsedMs * pricePerHourFen / 3600000)`, and create deterministic `shop_orders/{orderIdForSession(sessionId)}` in the same transaction.
- [ ] New order snapshots include all approved amount, policy, payment, split, refund, and state fields; `channelFeeFen` and `platformNetFen` start as `null`.
- [ ] Make `closeSession` return `PRODUCT_RETIRED`; only payment notification or authorized external payment can close a version-2 session.
- [ ] Implement `markTableOrderExternalPaid({orderId,reason})` as an owner-only transaction setting `external_paid`, `not_applicable`, zero automatic cost, audit actor/time, closing session, and releasing occupancy.
- [ ] Make real finance mutations in `data.js` use `callCheckedCloud`; cloud-unavailable checkout must fail rather than write a local success. Keep demo-only display data separate.
- [ ] Run the focused test; verify green and run `node --check` on all changed cloud functions.

## Task 4: WeChat Pay APIv3 Reference Adapter

**Files:**
- Create: `tests/wechatPayV3Adapter.test.js`
- Create: `cloudfunctions/_shared/wechatpay-v3/client.js`
- Create: `cloudfunctions/_shared/wechatpay-v3/config.js`
- Create: `cloudfunctions/_shared/wechatpay-v3/http-event.js`
- Create: `cloudfunctions/_shared/wechatpay-v3/bill-parser.js`
- Create: `scripts/sync-table-finance-libs.ps1`
- Create: `tests/cloudSharedParity.test.js`
- Modify: `.gitignore`

- [ ] Write RED crypto tests using generated RSA fixtures for request canonical strings, `WECHATPAY2-SHA256-RSA2048` authorization, response/notification verification (`timestamp\nnonce\nbody\n`), timestamp skew rejection, unknown serial rejection, mini-program pay signature, RSA-OAEP sensitive-field encryption, and AES-256-GCM decryption with a 16-byte tag.
- [ ] Write RED HTTP tests for JSON and raw downloads, non-2xx error parsing, response signature required on API responses, timeouts, and fail-closed missing configuration.
- [ ] Implement the adapter using only Node built-ins. Required endpoints are:

```js
const ENDPOINTS = Object.freeze({
  createJsapi: '/v3/pay/partner/transactions/jsapi',
  queryByOutTradeNo: '/v3/pay/partner/transactions/out-trade-no/',
  refund: '/v3/refund/domestic/refunds',
  addReceiver: '/v3/profitsharing/receivers/add',
  split: '/v3/profitsharing/orders',
  splitReturn: '/v3/profitsharing/return-orders',
  unfreeze: '/v3/profitsharing/orders/unfreeze',
  tradeBill: '/v3/bill/tradebill',
  fundBill: '/v3/bill/fundflowbill'
});
```

- [ ] Read configuration only from server environment: `WXPAY_V3_ENABLED`, `WXPAY_SP_APPID`, `WXPAY_SP_MCHID`, `WXPAY_MERCHANT_SERIAL_NO`, `WXPAY_MERCHANT_PRIVATE_KEY`, `WXPAY_API_V3_KEY`, `WXPAY_PLATFORM_CERTS_JSON`, `WXPAY_TABLE_NOTIFY_URL`, `WXPAY_TABLE_REFUND_NOTIFY_URL`, `WXPAY_PLATFORM_RECEIVER_NAME`.
- [ ] Carry this disclaimer in adapter source: `AI 参考官方 Java 翻译生成，非官方维护。请开发人员自行审查 AI 生成的代码逻辑，上线前充分测试以确保其适用性与准确性，AI 不对生成代码的正确性承担责任。`
- [ ] Implement strict CSV parsing for official backtick-prefixed comma-separated trade bills and exact decimal-yuan-to-fen conversion. Validate downloaded bytes against `hash_type=SHA1` and `hash_value` before parsing.
- [ ] Add `.env`, `*.pem`, `*.p12`, `*.key`, and private certificate directories to `.gitignore`; never add credentials.
- [ ] Implement a sync script with an explicit destination allowlist and a parity test that byte-compares every deployed copy to its source.
- [ ] Run adapter and parity tests; verify green.

## Task 5: Customer Checkout and Verified Payment Lifecycle

**Files:**
- Create: `tests/tablePaymentFlow.test.js`
- Create: `cloudfunctions/getTableCheckoutOrder/index.js`
- Create: `cloudfunctions/getTableCheckoutOrder/package.json`
- Create: `cloudfunctions/genTableCheckoutCode/index.js`
- Create: `cloudfunctions/genTableCheckoutCode/package.json`
- Create: `cloudfunctions/createTablePayOrder/index.js`
- Create: `cloudfunctions/createTablePayOrder/package.json`
- Create: `cloudfunctions/tablePayNotifyV3/index.js`
- Create: `cloudfunctions/tablePayNotifyV3/package.json`
- Create: `cloudfunctions/reconcileTablePayments/index.js`
- Create: `cloudfunctions/reconcileTablePayments/package.json`
- Create: `cloudfunctions/reconcileTablePayments/config.json`
- Create: `miniprogram/pages/table-checkout/index.js`
- Create: `miniprogram/pages/table-checkout/index.wxml`
- Create: `miniprogram/pages/table-checkout/index.wxss`
- Create: `miniprogram/pages/table-checkout/index.json`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/services/data.js`

- [ ] Write RED tests for checkout-token privacy, one payer per order, payment-profile readiness, exact APIv3 request fields, `settle_info.profit_sharing=true`, callback signature/decryption, merchant/AppID/order/currency/amount matching, replay idempotency, notification/query race, and session/occupancy closure only after verified success.
- [ ] Implement a random 128-bit checkout token at order creation, store only its SHA-256 hash, and expose a mini-program code scene containing the token for `pages/table-checkout/index`.
- [ ] `getTableCheckoutOrder` returns only public store/table/time/amount/status fields when the token hash matches.
- [ ] `createTablePayOrder({token})` binds the first authenticated payer OPENID, rejects another payer, loads a ready `shop_payment_profiles` record, calls `/v3/pay/partner/transactions/jsapi` with `sp_appid`, `sp_mchid`, optional `sub_appid`, `sub_mchid`, `notify_url`, exact CNY amount, payer `sp_openid` or `sub_openid`, and `settle_info.profit_sharing=true`, then returns only signed `wx.requestPayment` parameters.
- [ ] `tablePayNotifyV3` extracts the raw body and `Wechatpay-*` headers, rejects stale/invalid signatures, decrypts the resource, validates all identity and amount fields, and transactionally writes one `payment_succeeded` financial event, marks order paid/complete/pending split, closes session, and releases occupancy.
- [ ] `reconcileTablePayments` accepts only its named timer event, queries stale unpaid orders, verifies signed responses, and calls the same idempotent payment-success transition as notification handling.
- [ ] Build the payer page so `wx.requestPayment` success only starts status polling; it never marks payment successful locally.
- [ ] Run the focused test and syntax checks; verify green.

## Task 6: T+1 Profit Sharing and Refunds

**Files:**
- Create: `tests/tableProfitSharing.test.js`
- Create: `tests/tableRefunds.test.js`
- Create: `cloudfunctions/settleTableProfitSharing/index.js`
- Create: `cloudfunctions/settleTableProfitSharing/package.json`
- Create: `cloudfunctions/requestTableRefund/index.js`
- Create: `cloudfunctions/requestTableRefund/package.json`
- Create: `cloudfunctions/tableRefundNotifyV3/index.js`
- Create: `cloudfunctions/tableRefundNotifyV3/package.json`
- Modify: `miniprogram/services/data.js`

- [ ] Write RED tests proving no split before an actual matched fee, receiver relationship `SERVICE_PROVIDER`, encrypted merchant name, exact platform-net split, fee-over-cost manual review, idempotent retries, final unfreeze, full/partial/multiple refund recomputation, refund upper bounds, post-split return, and full-refund total cost zero.
- [ ] Implement `settleTableProfitSharing` as timer/internal-only. It claims eligible orders, ensures the service-provider `MERCHANT_ID` receiver exists, requests split with `unfreeze_unsplit=false`, queries to terminal success, then calls `/v3/profitsharing/orders/unfreeze` and appends immutable events.
- [ ] If `platformNetFen <= 0`, do not create a negative/zero receiver split; unfreeze only when the order is otherwise reconciled. Keep fee-over-cost orders in `manual_review`.
- [ ] Implement owner-authorized `requestTableRefund({orderId,refundFen,reason,idempotencyKey})`. Recompute from the cumulative final retained paid table fee rather than summing incremental rounded cost.
- [ ] For a completed split, request the WeChat refund with the same deterministic refund number, use accepted/refund fee data to calculate the required platform share return, then call `/v3/profitsharing/return-orders` for the service-provider receiver when the return is positive.
- [ ] `tableRefundNotifyV3` verifies/decrypts the notification and idempotently updates the refund, cumulative order snapshot, payment/split state, and immutable events. Any uncertain return/refund combination becomes `manual_review`.
- [ ] Run both focused tests and syntax checks; verify green.

## Task 7: Bill Import, Reconciliation, Reporting, and Hall UI

**Files:**
- Create: `tests/tableReconciliation.test.js`
- Create: `tests/tableReporting.test.js`
- Create: `tests/hallStatusCheckoutContract.test.js`
- Create: `cloudfunctions/reconcileTableFinance/index.js`
- Create: `cloudfunctions/reconcileTableFinance/package.json`
- Create: `cloudfunctions/reconcileTableFinance/config.json`
- Modify: `cloudfunctions/getTodayRevenue/index.js`
- Modify: `cloudfunctions/getShopBizOverview/index.js`
- Modify: `miniprogram/pages/shop/hall-status/index.js`
- Modify: `miniprogram/pages/shop/hall-status/index.wxml`
- Modify: `miniprogram/pages/shop/hall-status/index.wxss`
- Modify: `miniprogram/pages/shop/biz-data/index.js`
- Modify: `miniprogram/pages/shop/biz-data/index.wxml`
- Modify: `miniprogram/services/data.js`

- [ ] Write RED tests for signed bill-link retrieval, SHA1 validation, duplicate imports, payment/refund/fee matching, missing or conflicting rows, finance anomaly creation, action freezing, and one reconciliation run lease per date.
- [ ] Implement the T+1 timer after official 10:00 bill generation. Download the per-sub-merchant `ALL` trade bill, upload raw verified bytes to `finance/bills/{date}/{subMchid}/trade.csv`, and store `wechat_bill_artifacts` hash/source/parse status.
- [ ] Match `商户订单号`, `微信订单号`, `特约商户号`, `交易状态`, `订单金额`, `退款金额`, and signed `手续费`; calculate net actual channel fee including negative refund-fee rows.
- [ ] Update eligible order settlement snapshots and append `channel_fee_confirmed`; create `finance_reconciliation_runs` and `finance_anomalies`. Missing/mismatched evidence sets `manual_review` and blocks split/refund automation.
- [ ] Write RED reporting tests proving legacy yuan orders remain historical-only, new paid and external orders are separate, awaiting-payment is excluded, and no fen/yuan mixing occurs.
- [ ] Modify revenue/overview functions to return `{legacyRevenueYuan, platformPaidFen, externalPaidFen, platformCoverageBps}` while keeping the former `total` compatibility field as display yuan.
- [ ] Write RED Hall contract tests proving only `sessionId` is submitted, quote comes from the server, `awaiting_payment` remains occupied, external reason is mandatory, and external payment never claims WeChat success or auto-awards verified-training benefits.
- [ ] Change Hall checkout to create a server quote, display the customer checkout code, show verified status, and offer a clearly separate owner-only external-payment sheet.
- [ ] Run all three focused tests plus existing Hall/check-in tests; verify green.

## Task 8: Deployment Contract, Documentation, and Final Verification

**Files:**
- Create: `tests/tablePaymentDeployment.test.js`
- Create: `docs/table-commission-deployment.md`
- Modify: `README.md`
- Modify: `docs/codex/HANDOFF.md`

- [ ] Write a RED static deployment test that requires every new function/package/config/page, exact timers, no secret literals, no active subscription trigger, environment variable documentation, required collections/indexes, and callback exposure instructions.
- [ ] Document service-provider onboarding, special-merchant profile schema, standard billing policy, callback HTTPS routes, CloudBase function deployment, collection permissions, compound indexes, timer names, environment variables, receiver authorization, and rollback switches.
- [ ] Document that local tests cannot replace real merchant validation and that release remains disabled until service-provider application, special-merchant onboarding, profit-sharing authorization, certificates/keys, finance/legal review, and a real small payment/split/refund cycle are complete.
- [ ] Run `& $NODE tests/tablePaymentDeployment.test.js`; verify green.
- [ ] Run the shared-library sync script and parity test once more.
- [ ] Use `superpowers:requesting-code-review` for a whole-change review; fix every Critical/Important finding with a focused regression test and re-review.
- [ ] Use `superpowers:verification-before-completion`; prepend the bundled Node directory to `PATH`, then run exactly once: `& .\scripts\codex-verify.ps1 -Baseline main`.
- [ ] Confirm the verifier reports every test/JS/text check with `STATUS=PASS`; separately validate every changed JSON file with `ConvertFrom-Json` and inspect the final untracked-file inventory because the repository has no commit diff.
- [ ] Update `docs/codex/HANDOFF.md` with completed code scope, exact verification evidence, and remaining external merchant-console acceptance steps.
- [ ] Notify Zhang for acceptance only after local implementation and verification are complete. Clearly distinguish “local code complete” from the external real-funds validation that cannot run without merchant credentials and approval state.

