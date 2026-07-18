# 球员申请成为教练设计

## 背景

当前项目已经支持账号先登录、再选择身份。普通新账号默认只有 `member` 身份；教练账号应拥有 `member + coach` 两个身份，并能以球员身份继续查看自己的训练数据。

项目里也已经存在教练与球厅绑定链路：

- 教练资料页可提交绑定球厅申请。
- 店主端「教练名单」可查看待确认绑定申请，并通过或驳回。
- 通过后会建立 `shop_coach_links` 绑定关系。

本次功能不是新建一套复杂教练资质后台，而是在球员端「我的 / 设置」增加「成为教练」入口，复用现有店主审核链路，并补齐“审核通过后才开通教练身份”的权限闭环。

## 目标

1. 球员端「我的 / 设置」增加「成为教练」入口。
2. 点击后进入申请页，按折中方案填写必要资料：头像、教练昵称、简单说明、申请绑定的球厅。
3. 提交申请后，该账号仍只能以球员身份使用，不能直接进入教练端。
4. 店主在自己端侧「教练名单」审核该申请。
5. 店主通过后，该账号追加 `coach` 身份，最终身份集合为 `['member', 'coach']`。
6. 之后用户重新进入身份选择页时，可选择「教练」进入教练端。
7. 店主驳回后，球员可看到驳回状态和原因，并可修改后重新提交。

## 非目标

首版不做平台管理员审核教练资质，不做复杂证书认证，不做多球厅同时申请，不做教练身份收费开通，也不做即时消息通知。

证书、收费标准、可预约时段等完整教练资料仍放在教练端资料页中，通过审核后再完善。

## 推荐方案

采用“球员申请页 + 现有店主审核链路”的轻量闭环。

球员申请页负责收集最小必要信息，并写入 `coach_shop_applications`。店主端继续在「教练名单」处理待审核申请。审核通过时，服务端同时完成两件事：

1. 创建或激活 `shop_coach_links` 绑定。
2. 更新 `users.roles`，把当前账号从 `['member']` 升级为 `['member', 'coach']`。

这样既符合“教练身份由店主认证开通”，又不会让小程序出现额外管理员后台。

## 页面与入口

### 球员设置页

路径：`miniprogram/pages/settings/index`

仅当当前身份为 `member` 且账号未开通 `coach` 时，显示入口：

```text
成为教练
```

点击进入新页面：

```text
/pages/coach/apply/index
```

如果账号已经开通教练身份，则不显示该入口，避免重复申请。

### 成为教练申请页

新页面：`miniprogram/pages/coach/apply/index`

字段：

- 头像：默认读取当前用户头像，可点击更换。
- 教练昵称：默认读取当前用户昵称，可修改。
- 申请球厅：从已认证/已配置店主的球厅列表选择。
- 简单说明：用于给店主判断，例如“常驻本店，擅长中式八球基础教学”。

状态展示：

- `none`：可提交申请。
- `pending`：显示“待店主审核”，提交按钮禁用。
- `rejected`：显示驳回原因，可修改后重新提交。
- `approved`：显示“教练身份已开通”，提供“去完善教练资料”入口。

### 店主端审核

复用现有页面：

```text
miniprogram/pages/shop/coaches/index
```

待确认申请卡片展示：

- 申请人头像
- 教练昵称
- 申请绑定球厅
- 简单说明
- 通过 / 驳回

通过后申请人可登录教练端；驳回后申请人可重新提交。

## 数据设计

复用 `coach_shop_applications`，补充字段：

```js
{
  _openid,
  coachOpenid,
  coachNickname,
  coachAvatar,
  intro,
  shopOpenid,
  storeId,
  storeName,
  status: 'pending' | 'approved' | 'rejected',
  reason,
  createdAt,
  updatedAt,
  reviewedBy,
  reviewedAt
}
```

复用 `shop_coach_links`：

```js
{
  shopOpenid,
  coachOpenid,
  storeId,
  storeName,
  status: 'active',
  source: 'coach_apply',
  applicationId,
  createdAt,
  updatedAt
}
```

用户身份写在 `users`：

```js
{
  roles: ['member', 'coach'],
  currentRole: 'coach' | 'member',
  role: currentRole
}
```

审核通过时必须追加 `coach`，不能覆盖掉 `member`。

## 服务接口

复用并扩展现有接口：

- `applyCoachShopBinding({ storeId, coachNickname, coachAvatar, intro })`
- `getMyCoachShopBindingStatus()`
- `getCoachBindingApplications(status)`
- `reviewCoachBindingApplication({ applicationId, approve, reason })`

关键规则：

- `applyCoachShopBinding` 只创建申请，不开通教练身份。
- `saveCoachProfile` 不能再作为开通教练身份的入口；只有已开通 `coach` 身份的账号才能保存完整教练资料。
- `reviewCoachBindingApplication` 通过申请时，负责给 `users.roles` 追加 `coach`。
- `login` 继续以 `users.roles` 作为身份选择依据。

## 权限规则

1. 普通球员提交申请后，不能选择未开通的「教练」身份进入。
2. 店主只能审核申请绑定到自己球厅的申请。
3. 通过后，教练账号保留球员身份，不能丢失训练数据。
4. 被驳回后，只允许申请人本人重新提交。
5. 管理员账号不受此流程限制，仍按现有管理员逻辑处理。

## 状态流转

```text
none -> pending -> approved
none -> pending -> rejected -> pending -> approved
```

`approved` 后不可重复提交同一球厅的开通申请。后续如需要支持更换或增加绑定球厅，应另做“更换绑定球厅/多球厅任教”设计。

## 测试方案

新增专项测试，覆盖：

1. 球员设置页只有未开通教练身份时显示「成为教练」。
2. 申请页存在头像、昵称、球厅、说明字段。
3. 提交申请调用 `applyCoachShopBinding`，且不直接调用 `login('coach')` 或写入教练身份。
4. 店主端待审核卡片显示申请说明。
5. 店主通过申请后，云函数把 `users.roles` 更新为 `['member', 'coach']`。
6. 店主驳回申请后，申请人能看到原因并重新提交。
7. 全量现有登录和教练兼容测试继续通过。

## 验收标准

1. 球员端「我的 / 设置」能看到「成为教练」入口。
2. 球员提交申请后，店主端「教练名单」能看到待审核申请。
3. 店主未通过前，该账号不能进入教练端。
4. 店主通过后，该账号可在身份选择页选择「教练」。
5. 该账号仍可选择「球员」，且原训练数据不丢失。
6. 店主驳回后，球员能看到驳回原因并重新提交。
7. 全量测试通过。

## 需要部署的云函数

实现后预计需要重新部署：

- `applyCoachShopBinding`
- `reviewCoachBindingApplication`
- `saveCoachProfile`
- 如登录身份刷新逻辑调整，需部署 `login`
