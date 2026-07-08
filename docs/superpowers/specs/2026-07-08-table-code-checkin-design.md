# 球桌码打卡核验设计

## 背景

当前项目已有门店到店码、到店请求队列、店主开台、结账后写入已核验训练记录的基础能力。新设计将“门店到店”升级为“球桌会话核验”：每张球桌拥有稳定球桌码，球员/教练扫码进入具体球桌页，点击加入和开打后，店主在球厅端核验有效训练。

## 设计目标

1. 每张球桌生成稳定球桌码，适合一次生成后物理打印并长期贴在桌上。
2. 店主也可以在「球厅」页面进入对应球桌详情，临时查看或生成该桌球桌码。
3. 球员扫码后进入球桌信息页，页面展示门店、球桌、桌型、参与者头像区。
4. 球员点击“加入”后头像显示在该球桌页；点击“开打”后头像显示已准备，计时开始。
5. 教练也可以扫码加入并开打，作为本次训练的教练参与者。
6. 店主在「球厅」页面对应球桌卡片点击“核验有效”，将本次计时写为球员已核验训练；若有教练，同步写教练课时。

## 非目标

第一版不做支付结算闭环、不做复杂多人排队、不做球员自行结束训练、不做跨设备实时 WebSocket。需要刷新或轮询即可。

## 球桌码

球桌码使用稳定 scene：

```text
s=<storeId>&t=<tableId>
```

可选附带桌名：

```text
s=<storeId>&t=<tableId>&tn=<tableName>
```

小程序码目标页建议为：

```text
pages/table/checkin/index
```

物理打印逻辑：

- 店主配置好门店和球桌后，可以批量生成每张桌的码。
- 码内容稳定绑定 `storeId + tableId`，即使重新生成图片，指向同一张桌。
- 店主在「球厅」页点击某张球桌，可进入详情页查看该桌码，用于临时展示或重新打印。

## 球员/教练扫码页

新增球桌页 `pages/table/checkin/index`：

- 解析 `scene` 或 query 中的 `storeId/tableId/tableName`。
- 拉取门店和球桌基本信息。
- 展示参与者头像区，区分球员和教练。
- “加入”：创建或更新该用户在该桌的待核验记录，状态为 `joined`。
- “开打”：将该用户状态更新为 `ready`，写入 `readyAt/startedAt`；店主端从该时间开始计算训练时长。

角色判定：

- 当前登录身份为球员时，加入为 `member`。
- 当前登录身份为教练时，加入为 `coach`。
- 教练账号以球员身份登录时按球员处理。

## 店主端球厅

「球厅」页面继续以球桌卡片为主。对于已有扫码开打但未核验的球桌：

- 卡片显示为“使用中/待核验”。
- 显示已加入并开打的球员/教练头像。
- 显示从最早 `readyAt` 到当前的计时。
- 操作按钮显示“核验有效”。

点击“核验有效”：

1. 计算训练时长，最少 1 分钟。
2. 写入球员 `training_sessions`，`verified: true`。
3. 若有教练，写入 `coach_lessons`，`verified: true`。
4. 将相关扫码记录标记为 `confirmed/verified`，从待核验列表移除。
5. 球桌卡片恢复空闲或进入已结束状态。

## 数据结构

复用现有 `checkin_requests`，增加字段：

```js
{
  storeId,
  storeName,
  tableId,
  tableName,
  memberOpenid,
  nickname,
  avatar,
  role: 'member' | 'coach',
  status: 'pending' | 'confirmed' | 'rejected',
  joinedAt,
  ready: true | false,
  readyAt,
  verifiedAt
}
```

第一版允许同一球桌同时存在一个球员和一个教练。后续若支持多人同桌，可扩展为参与者数组或独立 `table_participants` 集合。

## 与现有代码衔接

- `requestCheckin` 扩展 `role/ready/readyAt` 字段。
- `getPendingCheckins` 继续作为店主端拉取待核验数据的入口。
- `hall-status` 在渲染球桌状态时合并 active session 与 ready checkin。
- `recordVerifiedTraining` 继续作为最终写入已核验训练的入口。
- `genCheckinCode` 支持 `tableId/tableName/page`，同时保留旧门店码能力。

## 验收标准

1. 店主能为具体球桌生成稳定识别码，payload 至少包含 `s=<storeId>&t=<tableId>`。
2. 球员扫码进入的是具体球桌页，不是泛门店页。
3. 球员点击加入后，该桌页显示头像；点击开打后显示已准备并开始计时。
4. 教练扫码加入后，能作为教练参与者显示。
5. 店主端对应球桌卡片能看到参与者和计时。
6. 店主点击“核验有效”后，球员杆迹出现已核验训练记录；若有教练，教练课时同步增加。
7. 全量测试通过。
