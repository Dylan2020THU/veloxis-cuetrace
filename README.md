# 大川激流 · 台球训练数据智能管理系统（里程碑 1-4）

微信小程序端的台球训练数据管理系统。已实现**第一代会员端**（GitHub 风格打卡热力图 + 训练明细）、**教练端**（资料认证 / 可约时段 / 收费标准 / 绑定学员看数据）、**店家端**（统一管理教练 / 本店会员训练统计）与**台球社区**（视频/图文发帖、动态流、点赞、评论，类小红书）。基于微信云开发；在未配置云环境时自动回退到内置 mock 数据，可直接在开发者工具中演示。

品牌色「大川蓝」：`#067EF9`（RGB 6,126,249）。

## 功能一览

### 里程碑 1 · 会员端

- 训练打卡热力图：53 周 × 7 天网格，类 GitHub contributions
  - 当天训练次数 ≥ 1 即点亮格子
  - 按当日训练总时长分 3 个颜色深度：0-3h（浅）/ 3-8h（中）/ 8h+（深），均为大川蓝深浅
- 点击格子：顶部 tooltip 显示「今日训练总时长」，下方明细栏列出当天每条记录（台球厅 + 时长），同一天多家分别成行
- 训练记录录入；顶部汇总：累计打卡天数 / 累计时长 / 连续打卡天数

### 里程碑 2 · 教练端

- 身份切换：「我的」页可在会员 / 教练身份间切换；**会员身份看不到教练工作台**（界面隔离）
- 教练资料：昵称、球龄、教龄、个人照片、资格证书（多图）、一句话介绍
- 可预约时段（按星期 + 起止时间，可增删）与收费标准（X 元/分钟）
- 师生绑定：教练绑定会员后，可进入「学员训练数据」只读查看该会员的热力图与明细；
  云函数侧基于 `coach_member_links` 做**授权校验**，无绑定关系无法查看（会员也无法反向查看教练界面）

### 里程碑 3 · 店家端

- 三身份切换（会员 / 教练 / 店家），各身份工作台相互隔离
- 店铺资料：店铺名称 + 所属台球厅；工作台概览（在管教练数 / 本店会员数 / 总训练时长）
- 教练管理：统一管理本店台球教练（添加 / 移除 / 查看教练资料）
- 会员训练统计：按店铺所属台球厅，统计每位会员的**打卡天数**与**训练时长**（去重日期计天数、累计分钟计时长），按时长降序展示

### 里程碑 4 · 台球社区（类小红书）

- 动态流：双列瀑布流，封面图自适应高度，视频帖带播放角标；支持下拉刷新
- 发帖：图文（最多 9 图）/ 视频两种形式，含标题与正文；底部「＋」浮动按钮发起
- 帖子详情：图片轮播（点击大图预览）/ 视频播放、作者与正文、**点赞**切换、**评论**列表与即时发表
- 数据：`posts` / `post_likes` / `post_comments` 三集合，点赞按用户去重、评论与帖子计数同步

## 目录结构

```
veloxis-cuetrace/
├── miniprogram/
│   ├── app.js / app.json / app.wxss
│   ├── components/heatmap/     # 热力图组件（会员/教练页面复用）
│   ├── pages/checkin/          # 会员打卡热力图 + 明细（首页）
│   ├── pages/training/         # 新增训练记录
│   ├── pages/profile/          # 我的（身份切换 / 教练入口）
│   ├── pages/coach/profile/    # 教练资料编辑
│   ├── pages/coach/members/    # 我的学员（绑定 / 列表）
│   ├── pages/coach/member/     # 查看某学员训练数据（只读）
│   ├── pages/shop/dashboard/   # 店家工作台（店铺设置 / 概览 / 入口）
│   ├── pages/shop/coaches/     # 教练管理（添加 / 移除）
│   ├── pages/shop/members/     # 本店会员训练统计
│   ├── pages/community/index   # 社区动态流（双列瀑布流）
│   ├── pages/community/detail  # 帖子详情（图/视频 + 点赞 + 评论）
│   ├── pages/community/post    # 发布动态（图文 / 视频）
│   ├── services/data.js        # 数据服务层（云开发 / mock 自动切换）
│   └── utils/                  # date / color / mock
├── cloudfunctions/             # login / getHalls / getHeatmap / getDayDetail / addTraining
│                               # + saveCoachProfile / getCoachProfile / linkMember / getMyMembers
│                               # + saveShopProfile / getShopProfile / getShopCoaches
│                               # + getLinkableCoaches / addShopCoach / removeShopCoach / getShopMembers
│                               # + createPost / getFeed / getPostDetail / toggleLike / addComment
├── project.config.json
└── README.md
```

## 运行方式

### 方式 A：本地演示（无需云环境，开箱即用）

1. 用微信开发者工具「导入项目」，选择本目录。
2. AppID 可使用「测试号」或你的小程序 AppID（`project.config.json` 默认 `touristappid`）。
3. 直接编译运行。`miniprogram/app.js` 中 `cloudEnv` 为空时，系统使用内置 mock 数据（首次启动自动播种约 300 天的演示训练记录）。
4. 「我的」页可点击「重置演示数据」重新生成。

### 方式 B：接入微信云开发

1. 在开发者工具中开通「云开发」，获得环境 ID。
2. 修改 `miniprogram/app.js`：

```js
globalData: {
  cloudReady: false,
  cloudEnv: '你的云开发环境ID',
  ...
}
```

3. 依次右键 `cloudfunctions/` 下每个函数目录 →「上传并部署：云端安装依赖」。
4. 在云数据库中创建集合：`users`、`halls`、`training_sessions`、`coaches`、`coach_member_links`、`shops`、`shop_coach_links`、`posts`、`post_likes`、`post_comments`，并给 `halls` 录入若干台球厅、`training_sessions` 录入测试数据（或在小程序内通过「记录训练」写入）。

> 教练端绑定会员 / 店家端添加教练：mock 模式下从演示候选中选择；云端模式下输入对方编码（openid）绑定。

## 数据模型（云数据库集合）

- `users`：`_openid`、`role`(member/coach/shop)、`nickname`、`avatar`
- `halls`：`name`、`address`
- `training_sessions`：`_openid`、`hallId`、`hallName`、`date`(YYYY-MM-DD)、`startTime`、`durationMinutes`
- `coaches`：`_openid`、`nickname`、`playYears`(球龄)、`coachYears`(教龄)、`avatar`、`certificates`(图片数组)、`intro`、`availability`(可约时段数组)、`pricePerMinute`
- `coach_member_links`：`coachOpenid`、`memberOpenid`、`status`、`createdAt`
- `shops`：`_openid`、`name`、`hallId`、`hallName`
- `shop_coach_links`：`shopOpenid`、`coachOpenid`、`status`、`createdAt`
- `posts`：`_openid`、`authorName`、`authorAvatar`、`type`(image/video)、`title`、`content`、`images`(数组)、`video`、`cover`、`likeCount`、`commentCount`、`createdAt`
- `post_likes`：`_openid`、`postId`、`createdAt`
- `post_comments`：`_openid`、`postId`、`content`、`authorName`、`authorAvatar`、`createdAt`

颜色分级规则（`utils/color.js` 与 `cloudfunctions/getHeatmap` 保持一致）：

| 等级 | 当日总时长 | 颜色 |
| --- | --- | --- |
| 0 | 无训练 | `#EBEDF0` |
| 1 | 0–3 小时 | `rgba(6,126,249,0.35)` |
| 2 | 3–8 小时 | `rgba(6,126,249,0.65)` |
| 3 | 8 小时以上 | `rgba(6,126,249,1)` |

## 后续路线图

- 里程碑 1：会员端打卡可视化（已完成）
- 里程碑 2：教练端（资料/资格认证、可约时段、收费标准、绑定会员看数据）（已完成）
- 里程碑 3：店家端（教练管理、本店会员打卡与时长统计）（已完成）
- 里程碑 4：台球社区（视频/图文发帖、动态流、点赞、评论）（已完成）
- 里程碑 5（第二代）：摄像头单人训练 / 双人 PK 数据采集与分析
