// 本地 mock 数据层：在未部署云开发环境时，保证小程序可端到端运行与演示。
// 数据持久化在 wx.storage 中，结构与云数据库集合保持一致。

const { toKey, today, addDays } = require('./date');

const KEY_HALLS = 'dc_halls';
const KEY_BRANDS = 'dc_brands';
const KEY_STORES = 'dc_stores';
const KEY_SESSIONS = 'dc_sessions';
const KEY_SEEDED = 'dc_seeded_v2';
const KEY_ROLE = 'dc_role';
const KEY_COACH = 'dc_coach_profile';
const KEY_LINKS = 'dc_links';
const KEY_MEMBERS = 'dc_members';
const KEY_SHOP = 'dc_shop';
const KEY_SHOP_STORES = 'dc_shop_stores';
const KEY_SHOP_COACHES = 'dc_shop_coaches';
const KEY_SHOP_MEMBERS = 'dc_shop_members'; // 店主手动添加（扫码/编码）的会员关系（按门店）
const KEY_ALL_COACHES = 'dc_all_coaches';
const KEY_POSTS = 'dc_posts';
const KEY_POST_LIKES = 'dc_post_likes';
const KEY_COMMENTS = 'dc_comments';
const KEY_FOLLOWS = 'dc_follows';
const KEY_MATCHES = 'dc_matches';
const KEY_BOOKINGS = 'dc_bookings';
const KEY_JOINS = 'dc_match_joins';
const KEY_BILLING = 'dc_billing';
const KEY_COACH_LESSONS = 'dc_coach_lessons'; // 教练课时（教练身份计时）：热力图金色来源（与 data.js 同名 key）
const KEY_COACH_SETTLEMENTS = 'dc_coach_settlements'; // 教练结算流水（店主结算教练）

const MOCK_OPENID = 'local-demo-user';

function avatarFor(openid) {
  if (!openid) return '';
  return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(openid)}&backgroundColor=067ef9,3b82f6,10b981,f59e0b,ef4444,8b5cf6&backgroundType=gradientLinear&fontSize=38&fontWeight=600`;
}

function readArray(key) {
  try {
    return wx.getStorageSync(key) || [];
  } catch (e) {
    return [];
  }
}

function writeArray(key, arr) {
  try {
    wx.setStorageSync(key, arr);
  } catch (e) {
    // ignore
  }
}

function readObject(key, fallback) {
  try {
    return wx.getStorageSync(key) || fallback;
  } catch (e) {
    return fallback;
  }
}

function writeObject(key, obj) {
  try {
    wx.setStorageSync(key, obj);
  } catch (e) {
    // ignore
  }
}

// 可复现的伪随机数 [0,1)
function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// 简单确定性 hash
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

// ===== 数据定义 =====

// 品牌
const BRANDS = [
  {
    _id: 'brand_01',
    name: '大川激流',
    logo: '',
    createdAt: Date.now()
  }
];

// 门店（原 HALLS，归属到品牌下）
const STORES = [
  {
    _id: 'hall_01',
    brandId: 'brand_01',
    name: '大川激流·旗舰店',
    address: '城市中心广场 3F',
    cover: '',
    region: '北京',
    lat: 39.908,
    lng: 116.404,
    checkinEnabled: true,
    tableTypes: [
      { name: '乔氏金腿', pricePerHour: 78 },
      { name: '乔氏银腿', pricePerHour: 68 },
      { name: '美洲豹', pricePerHour: 58 }
    ]
  },
  {
    _id: 'hall_02',
    brandId: 'brand_01',
    name: '大川激流·滨江店',
    address: '滨江路 88 号',
    cover: '',
    region: '北京',
    lat: 39.924,
    lng: 116.432,
    checkinEnabled: true,
    tableTypes: [
      { name: '乔氏金腿', pricePerHour: 78 },
      { name: '乔氏银腿', pricePerHour: 68 }
    ]
  },
  {
    _id: 'hall_03',
    brandId: 'brand_02',
    name: '星河台球俱乐部',
    address: '高新区软件园',
    cover: '',
    region: '北京',
    lat: 39.881,
    lng: 116.463,
    checkinEnabled: true,
    tableTypes: [
      { name: '星牌钢库', pricePerHour: 48 },
      { name: '星牌木库', pricePerHour: 38 }
    ]
  }
];

// 兼容别名：外部仍用 HALLS，内部映射到 STORES
const HALLS = STORES;

// 10 位教练，分配到 3 个门店（4/3/3）
const COACHES = [
  // hall_01 教练 4 位
  {
    openid: 'coach_01',
    nickname: '周明辉',
    playYears: 15,
    coachYears: 10,
    pricePerMinute: 5,
    intro: '前省队队员，专攻斯诺克，擅长大赛心态调整',
    avatar: '',
    certificates: ['国家一级运动员', '高级教练员证'],
    availability: ['周一至周五 14:00-21:00', '周六日 10:00-21:00'],
    hallId: 'hall_01',
    hallName: '大川激流·旗舰店',
    brandId: 'brand_01',
    gameTypes: ['斯诺克', '中式八球']
  },
  {
    openid: 'coach_02',
    nickname: '吴建国',
    playYears: 12,
    coachYears: 6,
    pricePerMinute: 4,
    intro: '中式八球实战派，擅长基础动作纠错与发力训练',
    avatar: '',
    certificates: ['国家二级运动员', '中级教练员证'],
    availability: ['周二至周日 12:00-20:00'],
    hallId: 'hall_01',
    hallName: '大川激流·旗舰店',
    brandId: 'brand_01',
    gameTypes: ['中式八球', '九球']
  },
  {
    openid: 'coach_03',
    nickname: '郑海涛',
    playYears: 18,
    coachYears: 8,
    pricePerMinute: 4,
    intro: '九球与美式大师，擅长攻防转换与战术设计',
    avatar: '',
    certificates: ['国家二级运动员'],
    availability: ['周一至周六 15:00-22:00'],
    hallId: 'hall_01',
    hallName: '大川激流·旗舰店',
    brandId: 'brand_01',
    gameTypes: ['九球', '美式八球']
  },
  {
    openid: 'coach_04',
    nickname: '冯志刚',
    playYears: 10,
    coachYears: 3,
    pricePerMinute: 3,
    intro: '专注新手入门，耐心讲解，课堂氛围轻松',
    avatar: '',
    certificates: [],
    availability: ['周三至周日 10:00-18:00'],
    hallId: 'hall_01',
    hallName: '大川激流·旗舰店',
    brandId: 'brand_01',
    gameTypes: ['中式八球']
  },
  // hall_02 教练 3 位
  {
    openid: 'coach_05',
    nickname: '顾小东',
    playYears: 14,
    coachYears: 7,
    pricePerMinute: 4,
    intro: '擅长进阶提升，主攻杆法与走位精细化训练',
    avatar: '',
    certificates: ['国家二级运动员', '中级教练员证'],
    availability: ['周一至周五 13:00-21:00', '周六 10:00-18:00'],
    hallId: 'hall_02',
    hallName: '大川激流·滨江店',
    brandId: 'brand_01',
    gameTypes: ['中式八球', '斯诺克']
  },
  {
    openid: 'coach_06',
    nickname: '蒋伟文',
    playYears: 20,
    coachYears: 12,
    pricePerMinute: 5,
    intro: '青少年培训专家，因材施教，学员遍布各大高校',
    avatar: '',
    certificates: ['国家一级运动员', '高级教练员证', '青少年培训师'],
    availability: ['周二至周六 10:00-19:00'],
    hallId: 'hall_02',
    hallName: '大川激流·滨江店',
    brandId: 'brand_01',
    gameTypes: ['中式八球', '斯诺克']
  },
  {
    openid: 'coach_07',
    nickname: '马晓龙',
    playYears: 8,
    coachYears: 2,
    pricePerMinute: 3,
    intro: '年轻教练，沟通无代沟，带你快速上手',
    avatar: '',
    certificates: [],
    availability: ['周三至周日 14:00-22:00'],
    hallId: 'hall_02',
    hallName: '大川激流·滨江店',
    brandId: 'brand_01',
    gameTypes: ['中式八球', '九球']
  },
  // hall_03 教练 3 位
  {
    openid: 'coach_08',
    nickname: '姚志勇',
    playYears: 16,
    coachYears: 9,
    pricePerMinute: 4,
    intro: '社区台球圈元老，实战经验丰富，擅长战术分析',
    avatar: '',
    certificates: ['国家二级运动员', '中级教练员证'],
    availability: ['周一至周日 12:00-21:00'],
    hallId: 'hall_03',
    hallName: '星河台球俱乐部',
    brandId: 'brand_02',
    gameTypes: ['中式八球', '美式八球']
  },
  {
    openid: 'coach_09',
    nickname: '贺云鹏',
    playYears: 22,
    coachYears: 15,
    pricePerMinute: 5,
    intro: '半辈子都在打台球，理论实践兼备，教会你思考台球',
    avatar: '',
    certificates: ['国家一级运动员', '高级教练员证'],
    availability: ['周二至周日 10:00-20:00'],
    hallId: 'hall_03',
    hallName: '星河台球俱乐部',
    brandId: 'brand_02',
    gameTypes: ['中式八球', '斯诺克', '九球']
  },
  {
    openid: 'coach_10',
    nickname: '谭海峰',
    playYears: 9,
    coachYears: 4,
    pricePerMinute: 3,
    intro: '技术流教练，专注杆法与旋转训练',
    avatar: '',
    certificates: ['中级教练员证'],
    availability: ['周一至周五 15:00-22:00', '周日 10:00-18:00'],
    hallId: 'hall_03',
    hallName: '星河台球俱乐部',
    brandId: 'brand_02',
    gameTypes: ['中式八球']
  }
];

// 20 位球员，多个球员分布在不同门店，每位球员绑定 1~4 个教练
const LEVEL_MAP = {
  '进阶': '6级（业余进阶）',
  '中级': '5级（业余中级）',
  '初级': '3级（初学者）',
  '新手': '2级（新手）'
};

const MEMBERS = [
  // hall_01 常客 9 人
  { openid: 'member_01', nickname: '李晨曦', avatar: '', level: '6级（业余进阶）', playYears: 3, hallIds: ['hall_01'] },
  { openid: 'member_02', nickname: '王浩然', avatar: '', level: '3级（初学者）', playYears: 1, hallIds: ['hall_01'] },
  { openid: 'member_03', nickname: '张雨萱', avatar: '', level: '5级（业余中级）', playYears: 2, hallIds: ['hall_01'] },
  { openid: 'member_04', nickname: '刘子琪', avatar: '', level: '6级（业余进阶）', playYears: 4, hallIds: ['hall_01'] },
  { openid: 'member_05', nickname: '陈俊豪', avatar: '', level: '2级（新手）', playYears: 0, hallIds: ['hall_01'] },
  { openid: 'member_06', nickname: '黄思远', avatar: '', level: '5级（业余中级）', playYears: 2, hallIds: ['hall_01'] },
  { openid: 'member_07', nickname: '林诗涵', avatar: '', level: '6级（业余进阶）', playYears: 3, hallIds: ['hall_01'] },
  { openid: 'member_08', nickname: '徐子墨', avatar: '', level: '5级（业余中级）', playYears: 2, hallIds: ['hall_01'] },
  { openid: 'member_09', nickname: '孙一凡', avatar: '', level: '2级（新手）', playYears: 0, hallIds: ['hall_01'] },
  // hall_02 常客 6 人
  { openid: 'member_10', nickname: '马锦程', avatar: '', level: '6级（业余进阶）', playYears: 5, hallIds: ['hall_02'] },
  { openid: 'member_11', nickname: '朱雅婷', avatar: '', level: '5级（业余中级）', playYears: 2, hallIds: ['hall_02'] },
  { openid: 'member_12', nickname: '胡泽楷', avatar: '', level: '6级（业余进阶）', playYears: 3, hallIds: ['hall_02'] },
  { openid: 'member_13', nickname: '何欣怡', avatar: '', level: '5级（业余中级）', playYears: 1, hallIds: ['hall_02'] },
  { openid: 'member_14', nickname: '罗文博', avatar: '', level: '2级（新手）', playYears: 0, hallIds: ['hall_02'] },
  { openid: 'member_15', nickname: '梁志远', avatar: '', level: '3级（初学者）', playYears: 1, hallIds: ['hall_02'] },
  // hall_03 常客 5 人
  { openid: 'member_16', nickname: '宋雨泽', avatar: '', level: '5级（业余中级）', playYears: 2, hallIds: ['hall_03'] },
  { openid: 'member_17', nickname: '唐梦瑶', avatar: '', level: '6级（业余进阶）', playYears: 4, hallIds: ['hall_03'] },
  { openid: 'member_18', nickname: '许天翔', avatar: '', level: '3级（初学者）', playYears: 1, hallIds: ['hall_03'] },
  { openid: 'member_19', nickname: '韩思琪', avatar: '', level: '5级（业余中级）', playYears: 2, hallIds: ['hall_03'] },
  { openid: 'member_20', nickname: '曹宇航', avatar: '', level: '2级（新手）', playYears: 0, hallIds: ['hall_03'] }
];

// 教练↔学员 多对多绑定关系
const COACH_MEMBER_LINKS = [
  // coach_01 带 5 名学员
  { coachOpenid: 'coach_01', memberOpenid: 'member_01', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_01', memberOpenid: 'member_04', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_01', memberOpenid: 'member_07', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_01', memberOpenid: 'member_10', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_01', memberOpenid: 'member_17', status: 'active', createdAt: Date.now() },
  // coach_02 带 4 名学员
  { coachOpenid: 'coach_02', memberOpenid: 'member_02', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_02', memberOpenid: 'member_05', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_02', memberOpenid: 'member_08', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_02', memberOpenid: 'member_11', status: 'active', createdAt: Date.now() },
  // coach_03 带 4 名学员
  { coachOpenid: 'coach_03', memberOpenid: 'member_03', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_03', memberOpenid: 'member_06', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_03', memberOpenid: 'member_09', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_03', memberOpenid: 'member_13', status: 'active', createdAt: Date.now() },
  // coach_04 带 4 名学员
  { coachOpenid: 'coach_04', memberOpenid: 'member_02', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_04', memberOpenid: 'member_05', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_04', memberOpenid: 'member_09', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_04', memberOpenid: 'member_14', status: 'active', createdAt: Date.now() },
  // coach_05 带 4 名学员
  { coachOpenid: 'coach_05', memberOpenid: 'member_10', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_05', memberOpenid: 'member_12', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_05', memberOpenid: 'member_15', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_05', memberOpenid: 'member_01', status: 'active', createdAt: Date.now() },
  // coach_06 带 4 名学员
  { coachOpenid: 'coach_06', memberOpenid: 'member_11', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_06', memberOpenid: 'member_13', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_06', memberOpenid: 'member_16', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_06', memberOpenid: 'member_19', status: 'active', createdAt: Date.now() },
  // coach_07 带 3 名学员
  { coachOpenid: 'coach_07', memberOpenid: 'member_14', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_07', memberOpenid: 'member_15', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_07', memberOpenid: 'member_20', status: 'active', createdAt: Date.now() },
  // coach_08 带 4 名学员
  { coachOpenid: 'coach_08', memberOpenid: 'member_16', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_08', memberOpenid: 'member_17', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_08', memberOpenid: 'member_18', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_08', memberOpenid: 'member_04', status: 'active', createdAt: Date.now() },
  // coach_09 带 3 名学员
  { coachOpenid: 'coach_09', memberOpenid: 'member_17', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_09', memberOpenid: 'member_19', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_09', memberOpenid: 'member_10', status: 'active', createdAt: Date.now() },
  // coach_10 带 4 名学员
  { coachOpenid: 'coach_10', memberOpenid: 'member_18', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_10', memberOpenid: 'member_19', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_10', memberOpenid: 'member_20', status: 'active', createdAt: Date.now() },
  { coachOpenid: 'coach_10', memberOpenid: 'member_07', status: 'active', createdAt: Date.now() }
];

// 教练↔门店 绑定关系（1个教练只能绑定1个门店）
const SHOP_COACH_LINKS = COACHES.map((c) => ({
  shopOpenid: MOCK_OPENID,
  coachOpenid: c.openid,
  status: 'active',
  createdAt: Date.now()
}));

// ===== 生成函数 =====

function makeSession(openid, seq, hall, dateKey, startTime, durationMinutes) {
  return {
    _id: `mock_s_${openid}_${seq}`,
    _openid: openid,
    hallId: hall._id,
    hallName: hall.name,
    date: dateKey,
    startTime,
    durationMinutes,
    createdAt: Date.now()
  };
}

function generateSessions(openid, seedOffset = 0) {
  const halls = HALLS;
  const sessions = [];
  const end = today();
  let seq = 0;

  for (let i = 0; i < 300; i++) {
    const date = addDays(end, -i);
    const r = pseudoRandom(i + seedOffset);
    if (r > 0.55) continue;

    const dateKey = toKey(date);
    const tier = pseudoRandom(i + 1000 + seedOffset);
    let totalMinutes;
    if (tier < 0.45) {
      totalMinutes = 40 + Math.floor(pseudoRandom(i + 1 + seedOffset) * 130);
    } else if (tier < 0.8) {
      totalMinutes = 200 + Math.floor(pseudoRandom(i + 2 + seedOffset) * 250);
    } else {
      totalMinutes = 500 + Math.floor(pseudoRandom(i + 3 + seedOffset) * 200);
    }

    const multiHall = pseudoRandom(i + 7 + seedOffset) > 0.75 && totalMinutes > 180;
    if (multiHall) {
      const firstHall = halls[(i + seedOffset) % halls.length];
      const secondHall = halls[(i + 1 + seedOffset) % halls.length];
      const firstMin = Math.floor(totalMinutes * 0.6);
      sessions.push(makeSession(openid, seq++, firstHall, dateKey, '14:00', firstMin));
      sessions.push(makeSession(openid, seq++, secondHall, dateKey, '19:30', totalMinutes - firstMin));
    } else {
      const hall = halls[(i + seedOffset) % halls.length];
      sessions.push(makeSession(openid, seq++, hall, dateKey, '15:00', totalMinutes));
    }
  }

  return sessions;
}

function generatePosts() {
  const now = Date.now();
  const hour = 3600 * 1000;
  const img = (s) => `https://picsum.photos/seed/${s}/600/${700 + (s % 3) * 120}`;

  const raw = [
    { openid: 'member_01', authorName: '李晨曦', type: 'image', title: '旗舰店夜场三小时训练复盘', content: '今晚在旗舰店练了三个小时，重点练了加塞和走位控制。乔氏金腿的台泥确实很舒服，回弹非常精准。', images: [img(101), img(102), img(103)], region: '北京' },
    { openid: 'member_04', authorName: '刘子琪', type: 'image', title: '进阶心得：如何练好高杆？', content: '高杆的控制关键在于手腕的爆发力，不要用手臂推。出杆要稳，拉杆要直。分享我的日常练习方法。', images: [img(104), img(105)], region: '北京' },
    { openid: 'member_07', authorName: '林诗涵', type: 'image', title: '今日打卡｜旗舰店下午场', content: '下午人少，包了整张台。练了两个小时直线长台，命中率提升明显。周教练的建议很有用！', images: [img(107)], region: '北京' },
    { openid: 'member_10', authorName: '马锦程', type: 'image', title: '滨江店实战：连胜五局', content: '今晚在滨江店和球友切磋，连胜五局！对手是位斯诺克老手，学到了很多防守思路。', images: [img(201), img(202)], region: '北京' },
    { openid: 'member_11', authorName: '朱雅婷', type: 'image', title: '新手必看：握杆的常见错误', content: '很多新手握杆太紧，导致出杆抖动变形。我整理了几个常见的握杆误区，欢迎大家补充讨论。', images: [img(211), img(212), img(213)], region: '北京' },
    { openid: 'member_16', authorName: '宋雨泽', type: 'image', title: '星河俱乐部九球局记录', content: '在星河打了两个半小时的九球，对手是一位资深球友。九球的节奏和中八完全不同，更考验叫位能力。', images: [img(301), img(302)], region: '北京' },
    { openid: 'member_17', authorName: '唐梦瑶', type: 'video', title: '一杆清台慢动作解析', content: '录了一段清台慢动作，重点看母球的旋转控制和走位路径。谭教练说我最近杆法进步很大。', images: [img(311)], video: '', region: '北京' },
    { openid: 'member_17', authorName: '唐梦瑶', type: 'image', title: '练球日记｜第100次打卡', content: '坚持练球一百天了，从最初连球杆都握不稳到现在可以稳定清台。感谢教练们的耐心指导！', images: [img(312), img(313)], region: '北京' },
    { openid: 'coach_01', authorName: '周明辉教练', type: 'image', title: '斯诺克防守的三个核心原则', content: '做安全球不是把球藏起来，而是让对手既打不到目标球，又难以做出安全球回应。三个原则：线路、力量、角度。', images: [img(401), img(402), img(403)], region: '北京' },
    { openid: 'coach_06', authorName: '蒋伟文教练', type: 'image', title: '青少年台球培训：因材施教的重要性', content: '每个孩子的接受能力不同，教学方法也要调整。我总结了三种不同类型学员的教学策略，欢迎同行交流。', images: [img(601), img(602)], region: '北京' },
    { openid: 'coach_09', authorName: '贺云鹏教练', type: 'image', title: '台球是一项需要思考的运动', content: '很多人以为台球靠手感，其实七分靠思考，三分靠技术。练球时多问自己：为什么走这步？有没有更好的选择？', images: [img(901), img(902)], region: '北京' },
    { openid: 'member_03', authorName: '张雨萱', type: 'image', title: '旗舰店练球：专注带来进步', content: '今天在旗舰店关掉手机，练了两个半小时。专注的状态下，杆法和走位都有明显提升。', images: [img(1031)], region: '北京' },
    { openid: 'member_12', authorName: '胡泽楷', type: 'image', title: '滨江店夜场切磋', content: '周五晚上滨江店人不多，和球友约了一场友谊赛。比分胶着到最后一局，非常过瘾。', images: [img(1231), img(1232)], region: '北京' }
  ];

  return raw.map((p, i) => ({
    _id: `mock_p_${i}`,
    _openid: p.openid,
    authorName: p.authorName,
    authorAvatar: avatarFor(p.openid),
    type: p.type,
    title: p.title,
    content: p.content,
    images: p.images || [],
    video: p.video || '',
    cover: (p.images && p.images[0]) || '',
    region: p.region,
    likeCount: 2 + ((i * 17 + 3) % 60),
    commentCount: 0,
    createdAt: now - i * 7 * hour
  }));
}

function generateMatches() {
  const now = Date.now();
  const hour = 3600 * 1000;

  const raw = [
    { openid: 'member_01', authorName: '李晨曦', hallId: 'hall_01', hallName: '大川激流·旗舰店', datetime: '今晚 20:00', gameType: '中式八球', note: '求一位进阶球友，一起练练攻防转换', myLevel: '6级（业余进阶）', targetLevel: '6级（业余进阶）', gender: '', age: '' },
    { openid: 'member_04', authorName: '刘子琪', hallId: 'hall_01', hallName: '大川激流·旗舰店', datetime: '周六 14:00', gameType: '中式八球', note: '新手友好，重在交流', myLevel: '6级（业余进阶）', targetLevel: '5级（业余中级）', gender: '不限', age: '' },
    { openid: 'member_10', authorName: '马锦程', hallId: 'hall_02', hallName: '大川激流·滨江店', datetime: '周日 10:00', gameType: '斯诺克', note: '想练练长台，欢迎同等水平球友', myLevel: '6级（业余进阶）', targetLevel: '6级（业余进阶）', gender: '', age: '' },
    { openid: 'member_11', authorName: '朱雅婷', hallId: 'hall_02', hallName: '大川激流·滨江店', datetime: '周五 19:30', gameType: '中式八球', note: '刚学球不久，找个新手一起进步', myLevel: '5级（业余中级）', targetLevel: '3级（初学者）', gender: '女', age: '' },
    { openid: 'member_16', authorName: '宋雨泽', hallId: 'hall_03', hallName: '星河台球俱乐部', datetime: '周六 15:00', gameType: '九球', note: '九球爱好者召集令，欢迎切磋', myLevel: '5级（业余中级）', targetLevel: '5级（业余中级）', gender: '', age: '' },
    { openid: 'member_17', authorName: '唐梦瑶', hallId: 'hall_03', hallName: '星河台球俱乐部', datetime: '周日 11:00', gameType: '中式八球', note: '约个上午场，头脑清醒练练准度', myLevel: '6级（业余进阶）', targetLevel: '5级（业余中级）', gender: '', age: '' },
    { openid: 'member_03', authorName: '张雨萱', hallId: 'hall_01', hallName: '大川激流·旗舰店', datetime: '今晚 21:00', gameType: '中式八球', note: '打了一会儿了，再来一局收尾', myLevel: '5级（业余中级）', targetLevel: '5级（业余中级）', gender: '', age: '' },
    { openid: 'member_15', authorName: '梁志远', hallId: 'hall_02', hallName: '大川激流·滨江店', datetime: '周四 20:00', gameType: '中式八球', note: '周四之夜，有没有一起打球的？', myLevel: '3级（初学者）', targetLevel: '3级（初学者）', gender: '', age: '' }
  ];

  return raw.map((m, i) => ({
    _id: `mock_m_${i}`,
    _openid: m.openid,
    authorName: m.authorName,
    avatar: avatarFor(m.openid),
    hallId: m.hallId,
    hallName: m.hallName,
    datetime: m.datetime,
    gameType: m.gameType,
    myLevel: m.myLevel || '',
    targetLevel: m.targetLevel || '',
    gender: m.gender || '',
    age: m.age || '',
    note: m.note,
    joinCount: 1 + (i % 3),
    status: 'open',
    createdAt: now - i * 5 * hour
  }));
}

function generateBookings() {
  const now = Date.now();
  const hour = 3600 * 1000;

  return [
    { _id: 'mock_b_01', _openid: 'member_01', bookerName: '李晨曦', bookerAvatar: avatarFor('member_01'), type: 'coach', targetId: 'coach_01', targetName: '周明辉教练', hallName: '大川激流·旗舰店', datetime: '明天 19:00', note: '想重点练习高杆控制', price: 5, status: 'pending', createdAt: now - 1 * hour },
    { _id: 'mock_b_02', _openid: 'member_04', bookerName: '刘子琪', bookerAvatar: avatarFor('member_04'), type: 'coach', targetId: 'coach_01', targetName: '周明辉教练', hallName: '大川激流·旗舰店', datetime: '周六 14:00', note: '预约本周第二次课', price: 5, status: 'pending', createdAt: now - 3 * hour },
    { _id: 'mock_b_03', _openid: 'member_10', bookerName: '马锦程', bookerAvatar: avatarFor('member_10'), type: 'coach', targetId: 'coach_06', targetName: '蒋伟文教练', hallName: '大川激流·滨江店', datetime: '周五 15:00', note: '', price: 5, status: 'pending', createdAt: now - 5 * hour },
    { _id: 'mock_b_04', _openid: 'member_11', bookerName: '朱雅婷', bookerAvatar: avatarFor('member_11'), type: 'coach', targetId: 'coach_06', targetName: '蒋伟文教练', hallName: '大川激流·滨江店', datetime: '周六 10:00', note: '青少年课程第一节', price: 5, status: 'pending', createdAt: now - 8 * hour },
    { _id: 'mock_b_05', _openid: 'member_16', bookerName: '宋雨泽', bookerAvatar: avatarFor('member_16'), type: 'table', targetId: 'hall_03', targetName: '星河台球俱乐部', hallName: '星河台球俱乐部', datetime: '今晚 20:00', note: '预约乔氏金腿', tableType: '星牌钢库', price: 48, status: 'pending', createdAt: now - 2 * hour },
    { _id: 'mock_b_06', _openid: 'member_17', bookerName: '唐梦瑶', bookerAvatar: avatarFor('member_17'), type: 'table', targetId: 'hall_01', targetName: '大川激流·旗舰店', hallName: '大川激流·旗舰店', datetime: '周日 10:00', note: '上午包台练习', tableType: '乔氏金腿', price: 78, status: 'pending', createdAt: now - 6 * hour }
  ];
}

// 生成当前登录用户的模拟训练记录（用于打卡热力图展示）
// 策略：365天跨度，约55%天数有训练，周末更长，工作日较短
function generateUserSessions(openid) {
  const halls = HALLS;
  const sessions = [];
  const end = today();
  let seq = 0;

  for (let i = 0; i < 365; i++) {
    const date = addDays(end, -i);
    const r = pseudoRandom(i + 9999);
    if (r > 0.55) continue; // ~55% 训练日

    const dateKey = toKey(date);
    const d = new Date(date);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;

    // 一天内训练段数：85% 单次，12% 两次，3% 三次
    const segments = pseudoRandom(i + 7777) < 0.85 ? 1
      : pseudoRandom(i + 8888) < 0.8 ? 2 : 3;

    for (let seg = 0; seg < segments; seg++) {
      // 时长：工作日 60~200 分钟，周末 80~360 分钟
      let totalMinutes;
      if (isWeekend) {
        totalMinutes = 80 + Math.floor(pseudoRandom(i + seg * 111 + 5000) * 280);
      } else {
        totalMinutes = 60 + Math.floor(pseudoRandom(i + seg * 111 + 5000) * 140);
      }

      const hall = halls[(i + seg) % halls.length];
      const startHour = isWeekend
        ? 10 + Math.floor(pseudoRandom(i + seg * 222 + 6000) * 10)
        : 18 + Math.floor(pseudoRandom(i + seg * 222 + 6000) * 4);
      const startMin = [0, 15, 30, 45][Math.floor(pseudoRandom(i + seg * 333 + 7000) * 4)];
      const startTime = `${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`;

      sessions.push(makeSession(openid, seq++, hall, dateKey, startTime, totalMinutes));
    }
  }

  return sessions;
}

// 生成当前演示用户「以教练身份计时」的课时记录（热力图金色来源）。
// 与 generateUserSessions（自主练球·蓝色）并存：部分日期重叠（重叠日热力图取金色），
// 部分仅教学（金色），其余仅自主练球（蓝色）。约 32% 天有教学。
function generateCoachLessons(coachOpenid) {
  const halls = HALLS;
  const lessons = [];
  const end = today();
  let seq = 0;

  for (let i = 0; i < 365; i++) {
    const r = pseudoRandom(i + 4242);
    if (r > 0.32) continue; // ~32% 教学日

    const date = addDays(end, -i);
    const dateKey = toKey(date);
    const segments = pseudoRandom(i + 2024) < 0.8 ? 1 : 2;

    for (let seg = 0; seg < segments; seg++) {
      const dur = 60 + Math.floor(pseudoRandom(i + seg * 53 + 333) * 120); // 60~180 分
      const hall = halls[(i + seg) % halls.length];
      const member = MEMBERS[(i * 2 + seg) % MEMBERS.length];
      const hh = 9 + Math.floor(pseudoRandom(i + seg * 71 + 900) * 10);
      const startTime = (hh < 10 ? '0' + hh : '' + hh) + ':00';
      lessons.push({
        _id: `mock_l_seed_${coachOpenid}_${seq++}`,
        coachOpenid,
        coachNickname: '我',
        memberOpenid: member.openid,
        memberNickname: member.nickname,
        hallId: hall._id,
        hallName: hall.name,
        date: dateKey,
        startTime,
        durationMinutes: dur,
        amount: dur * 5,
        verified: true,
        createdAt: Date.now()
      });
    }
  }

  return lessons;
}

// 给本店教练 coach_01..10 在各自门店补种课时（带 amount = 时长 × 单价），供「教练结算」演示。
// 确定性生成，约 30% 天有课；settled 默认 false。
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

// 演示阶段确定性派生「教练-学员」关系
function coachStudents(coachOpenid) {
  const members = MEMBERS;
  if (!members.length) return [];
  const picked = members.filter((m) => hashCode(`${coachOpenid}|${m.openid}`) % 3 !== 0);
  return picked.length ? picked : [members[hashCode(coachOpenid) % members.length]];
}

// ===== 初始化 =====

function ensureSeeded() {
  const seeded = wx.getStorageSync(KEY_SEEDED);
  if (seeded) {
    // 迁移：补充缺失的种子数据
    try {
      const existing = wx.getStorageSync(KEY_SESSIONS) || [];
      const hasCurrentUser = existing.some((s) => s._openid === MOCK_OPENID);
      console.log('[ensureSeeded migration] seeded=true, sessions count:', existing.length, 'hasCurrentUser:', hasCurrentUser);
      if (!hasCurrentUser) {
        const userSessions = generateUserSessions(MOCK_OPENID);
        writeArray(KEY_SESSIONS, existing.concat(userSessions));
        console.log('[ensureSeeded] wrote', userSessions.length, 'sessions for MOCK_OPENID');
      }
      // 补当前用户「教练身份」课时（热力图金色来源），缺失才补
      const existingLessons = wx.getStorageSync(KEY_COACH_LESSONS) || [];
      const hasCoachOwn = existingLessons.some((l) => l.coachOpenid === MOCK_OPENID);
      if (!hasCoachOwn) {
        writeArray(KEY_COACH_LESSONS, existingLessons.concat(generateCoachLessons(MOCK_OPENID)));
        console.log('[ensureSeeded] wrote coach lessons for MOCK_OPENID');
      }
      // 补本店教练课时（教练结算演示），缺失才补
      const lessonsNow = wx.getStorageSync(KEY_COACH_LESSONS) || [];
      if (!lessonsNow.some((l) => /^coach_/.test(l.coachOpenid || ''))) {
        writeArray(KEY_COACH_LESSONS, lessonsNow.concat(generateShopCoachLessons()));
        console.log('[ensureSeeded] backfilled shop coach lessons');
      }
      // 补演示订单（经营数据看板），缺失才补
      if (!(wx.getStorageSync('dc_shop_orders') || []).length) {
        writeArray('dc_shop_orders', generateShopOrders());
        console.log('[ensureSeeded] backfilled shop orders');
      }
      // 核心集合自愈：标记已播种但某集合为空（老数据 / 异常 / 部分清缓存）时回补演示数据。
      // 只在「为空」时补，绝不覆盖店主已添加的门店/品牌等；不改 dc_role。
      // 修复：店主端「球厅主页 / 门店管理」门店、教练、会员全为 0。
      if (!(wx.getStorageSync(KEY_BRANDS) || []).length) writeArray(KEY_BRANDS, BRANDS);
      if (!(wx.getStorageSync(KEY_STORES) || []).length) {
        writeArray(KEY_STORES, STORES.map((s) => Object.assign({}, s)));
        console.log('[ensureSeeded] backfilled KEY_STORES');
      }
      if (!(wx.getStorageSync(KEY_ALL_COACHES) || []).length) writeArray(KEY_ALL_COACHES, COACHES);
      if (!(wx.getStorageSync(KEY_SHOP_COACHES) || []).length) writeArray(KEY_SHOP_COACHES, SHOP_COACH_LINKS);
      if (!(wx.getStorageSync(KEY_MEMBERS) || []).length) writeArray(KEY_MEMBERS, MEMBERS);
      if (!(wx.getStorageSync(KEY_LINKS) || []).length) writeArray(KEY_LINKS, COACH_MEMBER_LINKS);
      // 会员训练记录（getShopMembers 按门店聚合用）：若 sessions 中无任何会员记录则回补
      const sessNow = wx.getStorageSync(KEY_SESSIONS) || [];
      if (!sessNow.some((s) => /^member_/.test(s._openid || ''))) {
        let memberSessions = [];
        MEMBERS.forEach((m, idx) => { memberSessions = memberSessions.concat(generateSessions(m.openid, (idx + 1) * 137)); });
        writeArray(KEY_SESSIONS, sessNow.concat(memberSessions));
        console.log('[ensureSeeded] backfilled member sessions');
      }
      // 补门店数据
      const existingStores = wx.getStorageSync(KEY_SHOP_STORES) || [];
      console.log('[ensureSeeded] shop_stores count:', existingStores.length);
      if (!existingStores.length) {
        writeArray(KEY_SHOP_STORES, STORES.map((s) => Object.assign({}, s)));
        console.log('[ensureSeeded] wrote shop_stores');
      }
      // 补店家资料的 storeId（shop 数据可能已有，但缺少 storeId 字段）
      const existingShop = wx.getStorageSync(KEY_SHOP) || null;
      console.log('[ensureSeeded] shop data:', JSON.stringify(existingShop));
      if (!existingShop || !existingShop.storeId) {
        writeObject(KEY_SHOP, Object.assign({}, existingShop || {}, {
          _openid: MOCK_OPENID,
          name: existingShop && existingShop.name ? existingShop.name : '大川激流',
          storeId: STORES[0]._id,
          hallId: STORES[0]._id,
          hallName: STORES[0].name,
          brandId: STORES[0].brandId
        }));
        console.log('[ensureSeeded] wrote shop with storeId');
      }
    } catch (e) {
      console.error('[ensureSeeded migration error]', e);
    }
    return;
  }

  // 清理旧版本种子残留（兼容从 dc_seeded 迁移的用户）
  try { wx.removeStorageSync('dc_seeded'); } catch (e) {}

  writeArray(KEY_HALLS, HALLS);
  writeArray(KEY_BRANDS, BRANDS);
  writeArray(KEY_STORES, STORES);
  // 店家自管门店：默认指向系统门店，店主可在「桌型管理」里进一步配置
  writeArray(KEY_STORES, STORES.map((s) => Object.assign({}, s)));
  writeArray(KEY_ALL_COACHES, COACHES);
  writeArray(KEY_MEMBERS, MEMBERS);
  writeArray(KEY_SHOP_COACHES, SHOP_COACH_LINKS);
  writeArray(KEY_LINKS, COACH_MEMBER_LINKS);

  let allSessions = [];
  MEMBERS.forEach((m, idx) => {
    allSessions = allSessions.concat(generateSessions(m.openid, (idx + 1) * 137));
  });
  // 为当前登录用户生成一年模拟训练记录
  allSessions = allSessions.concat(generateUserSessions(MOCK_OPENID));
  writeArray(KEY_SESSIONS, allSessions);
  // 当前用户作为「教练身份」的演示课时（热力图金色来源）+ 本店教练课时（教练结算）
  writeArray(KEY_COACH_LESSONS, generateCoachLessons(MOCK_OPENID).concat(generateShopCoachLessons()));
  // 演示订单（经营数据看板营收/开台/趋势）
  writeArray('dc_shop_orders', generateShopOrders());

  // 默认身份 member；但若已存在身份（如清缓存仅保留 dc_role）则保留，避免店主被降级
  if (!wx.getStorageSync(KEY_ROLE)) writeObject(KEY_ROLE, 'member');
  writeObject(KEY_COACH, null);
  // 默认店家资料：storeId 指向第一个门店，用于「本店会员」统计等场景
  writeObject(KEY_SHOP, {
    _openid: MOCK_OPENID,
    name: '大川激流',
    hallId: STORES[0]._id,
    hallName: STORES[0].name,
    storeId: STORES[0]._id,
    brandId: STORES[0].brandId,
    tableTypes: []
  });

  writeArray(KEY_POSTS, generatePosts());
  writeArray(KEY_POST_LIKES, []);
  writeArray(KEY_COMMENTS, []);
  writeArray(KEY_FOLLOWS, ['member_01', 'member_04', 'member_10', 'coach_01', 'coach_06']);

  writeArray(KEY_MATCHES, generateMatches());
  writeArray(KEY_BOOKINGS, generateBookings());
  writeArray(KEY_JOINS, []);

  try {
    wx.setStorageSync(KEY_SEEDED, true);
  } catch (e) {}
}

function getRole() {
  return readObject(KEY_ROLE, 'member');
}

function setRole(role) {
  writeObject(KEY_ROLE, role);
}

// 读取某会员的所有打卡记录，聚合为按日期统计的数组
// 用于「球员主页」热力图展示
function getMemberCheckins(openid) {
  const sessions = readArray(KEY_SESSIONS).filter(
    (s) => s._openid === openid && s.status !== 'closed'
  );
  const map = {};
  sessions.forEach((s) => {
    if (!map[s.date]) map[s.date] = { date: s.date, totalMinutes: 0, sessionCount: 0 };
    map[s.date].totalMinutes += s.durationMinutes || 0;
    map[s.date].sessionCount += 1;
  });
  return Object.keys(map).map((k) => map[k]);
}

// 根据 openid 查找教练资料（从 KEY_ALL_COACHES 数组）
function getCoachProfileByOpenid(openid) {
  const coaches = readArray(KEY_ALL_COACHES);
  return coaches.find((c) => c.openid === openid) || null;
}

module.exports = {
  MOCK_OPENID,
  KEY_HALLS,
  KEY_BRANDS,
  KEY_STORES,
  KEY_SESSIONS,
  KEY_ROLE,
  KEY_COACH,
  KEY_LINKS,
  KEY_MEMBERS,
  KEY_SHOP,
  KEY_SHOP_STORES,
  KEY_SHOP_COACHES,
  KEY_SHOP_MEMBERS,
  KEY_ALL_COACHES,
  KEY_POSTS,
  KEY_POST_LIKES,
  KEY_COMMENTS,
  KEY_FOLLOWS,
  KEY_MATCHES,
  KEY_BOOKINGS,
  KEY_JOINS,
  KEY_BILLING,
  KEY_COACH_LESSONS,
  KEY_COACH_SETTLEMENTS,
  HALLS,
  BRANDS,
  STORES,
  MEMBERS,
  COACHES,
  readArray,
  writeArray,
  readObject,
  writeObject,
  coachStudents,
  generateCoachLessons,
  generateShopCoachLessons,
  generateShopOrders,
  avatarFor,
  getRole,
  setRole,
  getMemberCheckins,
  getCoachProfileByOpenid,
  ensureSeeded
};
