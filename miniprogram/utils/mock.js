// 本地 mock 数据层：在未部署云开发环境时，保证小程序可端到端运行与演示。
// 数据持久化在 wx.storage 中，结构与云数据库集合保持一致。

const { toKey, today, addDays } = require('./date');

const KEY_HALLS = 'dc_halls';
const KEY_SESSIONS = 'dc_sessions';
const KEY_SEEDED = 'dc_seeded';
const KEY_ROLE = 'dc_role';
const KEY_COACH = 'dc_coach_profile';
const KEY_LINKS = 'dc_links';
const KEY_MEMBERS = 'dc_members';
const KEY_SHOP = 'dc_shop';
const KEY_SHOP_COACHES = 'dc_shop_coaches';
const KEY_ALL_COACHES = 'dc_all_coaches';
const KEY_POSTS = 'dc_posts';
const KEY_POST_LIKES = 'dc_post_likes';
const KEY_COMMENTS = 'dc_comments';
const KEY_FOLLOWS = 'dc_follows';
const KEY_MATCHES = 'dc_matches';
const KEY_BOOKINGS = 'dc_bookings';
const KEY_JOINS = 'dc_match_joins';

const MOCK_OPENID = 'local-demo-user';

const DEFAULT_HALLS = [
  { _id: 'hall_01', name: '大川激流·旗舰店', address: '城市中心广场 3F' },
  { _id: 'hall_02', name: '大川激流·滨江店', address: '滨江路 88 号' },
  { _id: 'hall_03', name: '星河台球俱乐部', address: '高新区软件园' }
];

// 演示用会员（供教练绑定与查看其训练数据）
const DEMO_MEMBERS = [
  { openid: 'member_zhao', nickname: '赵晓川', avatar: '' },
  { openid: 'member_qian', nickname: '钱多多', avatar: '' },
  { openid: 'member_sun', nickname: '孙一鸣', avatar: '' }
];

// 演示用教练（供店家"教练管理"添加）
const DEMO_COACHES = [
  {
    openid: 'coach_lin',
    nickname: '林教练',
    playYears: 15,
    coachYears: 8,
    pricePerMinute: 4,
    intro: '前省队队员，专攻斯诺克',
    avatar: '',
    certificates: [],
    availability: []
  },
  {
    openid: 'coach_wang',
    nickname: '王教练',
    playYears: 10,
    coachYears: 4,
    pricePerMinute: 3,
    intro: '中式八球实战派，擅长基础纠错',
    avatar: '',
    certificates: [],
    availability: []
  },
  {
    openid: 'coach_chen',
    nickname: '陈教练',
    playYears: 20,
    coachYears: 12,
    pricePerMinute: 5,
    intro: '青少年培训专家，耐心细致',
    avatar: '',
    certificates: [],
    availability: []
  }
];

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

// 为某个用户生成一段时间内的训练记录，制造出不同的颜色深度，便于演示。
// seedOffset 让不同用户拥有不同的打卡分布。
function generateSessions(openid, seedOffset = 0) {
  const halls = DEFAULT_HALLS;
  const sessions = [];
  const end = today();
  let seq = 0;

  for (let i = 0; i < 300; i++) {
    const date = addDays(end, -i);
    const r = pseudoRandom(i + seedOffset);
    if (r > 0.55) continue; // 这天没训练

    const dateKey = toKey(date);
    const tier = pseudoRandom(i + 1000 + seedOffset);
    let totalMinutes;
    if (tier < 0.45) {
      totalMinutes = 40 + Math.floor(pseudoRandom(i + 1 + seedOffset) * 130); // 0-3h
    } else if (tier < 0.8) {
      totalMinutes = 200 + Math.floor(pseudoRandom(i + 2 + seedOffset) * 250); // 3-8h
    } else {
      totalMinutes = 500 + Math.floor(pseudoRandom(i + 3 + seedOffset) * 200); // 8h+
    }

    const multiHall = pseudoRandom(i + 7 + seedOffset) > 0.7 && totalMinutes > 180;
    if (multiHall) {
      const firstHall = halls[i % halls.length];
      const secondHall = halls[(i + 1) % halls.length];
      const firstMin = Math.floor(totalMinutes * 0.6);
      sessions.push(makeSession(openid, seq++, firstHall, dateKey, '14:00', firstMin));
      sessions.push(makeSession(openid, seq++, secondHall, dateKey, '19:30', totalMinutes - firstMin));
    } else {
      const hall = halls[i % halls.length];
      sessions.push(makeSession(openid, seq++, hall, dateKey, '15:00', totalMinutes));
    }
  }

  return sessions;
}

// 演示社区帖子（图文 / 视频）。封面用占位图，便于在开发者工具中直观演示。
function generatePosts() {
  const now = Date.now();
  const hour = 3600 * 1000;
  const img = (s) => `https://picsum.photos/seed/${s}/600/${700 + (s % 3) * 120}`;
  const raw = [
    {
      openid: 'member_zhao',
      authorName: '赵晓川',
      type: 'image',
      title: '中八实战：清台思路复盘',
      content: '今天打了三小时，重点练习了走位和加塞控制，分享几张关键球的站位。坚持就是大川蓝！',
      images: [img(11), img(12), img(13)]
    },
    {
      openid: 'member_qian',
      authorName: '钱多多',
      type: 'image',
      title: '新手如何握杆？避开这些坑',
      content: '很多球友握杆太紧，导致出杆发力变形。放松手腕，找到自然摆动的节奏更重要。',
      images: [img(21), img(22)]
    },
    {
      openid: 'member_sun',
      authorName: '孙一鸣',
      type: 'video',
      title: '一杆十二颗清台慢动作',
      content: '录了个慢动作，重点看母球的回旋控制。',
      images: [img(31)],
      video: ''
    },
    {
      openid: 'coach_lin',
      authorName: '林教练',
      type: 'image',
      title: '斯诺克防守的三个原则',
      content: '做斯诺克不是把球藏起来就行，要让对手既打不到目标球、又难以做安全球。',
      images: [img(41), img(42), img(43)]
    },
    {
      openid: 'member_zhao',
      authorName: '赵晓川',
      type: 'image',
      title: '今日打卡｜旗舰店夜场',
      content: '夜场人少，专心练直线长台。大川激流旗舰店的台子手感真不错。',
      images: [img(51)]
    },
    {
      openid: 'coach_chen',
      authorName: '陈教练',
      type: 'image',
      title: '青少年训练｜从瞄准开始',
      content: '孩子学球别急着打花式，先把瞄准和出杆直线练扎实。',
      images: [img(61), img(62)]
    }
  ];

  // 为演示帖子分配城市，保证默认城市「北京」有内容
  const regions = ['北京', '青岛', '北京', '昆明', '北京', '上海'];

  return raw.map((p, i) => ({
    _id: `mock_p_${i}`,
    _openid: p.openid,
    authorName: p.authorName,
    authorAvatar: '',
    type: p.type,
    title: p.title,
    content: p.content,
    images: p.images || [],
    video: p.video || '',
    cover: (p.images && p.images[0]) || '',
    region: regions[i % regions.length],
    likeCount: 3 + ((i * 7) % 40),
    commentCount: 0,
    createdAt: now - i * 5 * hour
  }));
}

// 演示约球邀约
function generateMatches() {
  const now = Date.now();
  const hour = 3600 * 1000;
  const raw = [
    {
      openid: 'member_zhao',
      authorName: '赵晓川',
      hallId: 'hall_01',
      hallName: '大川激流·旗舰店',
      datetime: '今晚 20:00',
      gameType: '中式八球',
      note: '求一位水平相近的球友，一起练练手',
      joinCount: 2
    },
    {
      openid: 'member_qian',
      authorName: '钱多多',
      hallId: 'hall_02',
      hallName: '大川激流·滨江店',
      datetime: '周六 14:00',
      gameType: '斯诺克',
      note: '练习防守与做球，欢迎切磋',
      joinCount: 1
    },
    {
      openid: 'member_sun',
      authorName: '孙一鸣',
      hallId: 'hall_03',
      hallName: '星河台球俱乐部',
      datetime: '周日 10:00',
      gameType: '九球',
      note: '新手友好，重在交流',
      joinCount: 0
    }
  ];
  return raw.map((m, i) => ({
    _id: `mock_m_${i}`,
    _openid: m.openid,
    authorName: m.authorName,
    hallId: m.hallId,
    hallName: m.hallName,
    datetime: m.datetime,
    gameType: m.gameType,
    note: m.note,
    joinCount: m.joinCount,
    status: 'open',
    createdAt: now - i * 3 * hour
  }));
}

// 演示预约：他人（演示会员）预约「当前用户作为教练」，用于教练端「谁约了我」
function generateBookings() {
  const now = Date.now();
  const hour = 3600 * 1000;
  return [
    {
      _id: 'mock_b_seed_1',
      _openid: 'member_zhao',
      bookerName: '赵晓川',
      type: 'coach',
      targetId: MOCK_OPENID,
      targetName: '我',
      hallName: '大川激流·旗舰店',
      datetime: '明天 19:00',
      note: '想纠正一下握杆姿势',
      price: 4,
      status: 'pending',
      createdAt: now - 2 * hour
    },
    {
      _id: 'mock_b_seed_2',
      _openid: 'member_qian',
      bookerName: '钱多多',
      type: 'coach',
      targetId: MOCK_OPENID,
      targetName: '我',
      hallName: '大川激流·滨江店',
      datetime: '周六 15:00',
      note: '',
      price: 4,
      status: 'pending',
      createdAt: now - 5 * hour
    }
  ];
}

function ensureSeeded() {
  const seeded = wx.getStorageSync(KEY_SEEDED);

  // 已播种过：仅补齐后续里程碑新增的演示数据（向前兼容旧的本地数据）
  if (seeded) {
    if (!readArray(KEY_MEMBERS).length) {
      writeArray(KEY_MEMBERS, DEMO_MEMBERS);
      let extra = [];
      DEMO_MEMBERS.forEach((m, idx) => {
        extra = extra.concat(generateSessions(m.openid, (idx + 1) * 137));
      });
      writeArray(KEY_SESSIONS, readArray(KEY_SESSIONS).concat(extra));
    }
    if (!readArray(KEY_ALL_COACHES).length) {
      writeArray(KEY_ALL_COACHES, DEMO_COACHES);
      writeArray(KEY_SHOP_COACHES, []);
    }
    if (!readArray(KEY_POSTS).length) {
      writeArray(KEY_POSTS, generatePosts());
      writeArray(KEY_POST_LIKES, []);
      writeArray(KEY_COMMENTS, []);
    }
    if (!readArray(KEY_FOLLOWS).length) {
      // 默认关注两位演示作者，使「关注」页有内容
      writeArray(KEY_FOLLOWS, ['member_zhao', 'coach_lin']);
    }
    if (!readArray(KEY_MATCHES).length) {
      writeArray(KEY_MATCHES, generateMatches());
    }
    if (!readArray(KEY_BOOKINGS).length) {
      writeArray(KEY_BOOKINGS, generateBookings());
      writeArray(KEY_JOINS, []);
    }
    return;
  }

  writeArray(KEY_HALLS, DEFAULT_HALLS);
  writeArray(KEY_MEMBERS, DEMO_MEMBERS);
  writeArray(KEY_ALL_COACHES, DEMO_COACHES);
  writeArray(KEY_POSTS, generatePosts());
  writeArray(KEY_POST_LIKES, []);
  writeArray(KEY_COMMENTS, []);
  writeArray(KEY_FOLLOWS, ['member_zhao', 'coach_lin']);

  // 当前用户（本人）+ 各演示会员，各自生成训练数据
  let all = generateSessions(MOCK_OPENID, 0);
  DEMO_MEMBERS.forEach((m, idx) => {
    all = all.concat(generateSessions(m.openid, (idx + 1) * 137));
  });
  writeArray(KEY_SESSIONS, all);

  writeObject(KEY_ROLE, 'member');
  writeObject(KEY_COACH, null);
  writeArray(KEY_LINKS, []);
  writeObject(KEY_SHOP, null);
  writeArray(KEY_SHOP_COACHES, []);
  writeArray(KEY_MATCHES, generateMatches());
  writeArray(KEY_BOOKINGS, generateBookings());
  writeArray(KEY_JOINS, []);

  try {
    wx.setStorageSync(KEY_SEEDED, true);
  } catch (e) {}
}

// 角色：member / coach（演示态下本地可自由切换）
function getRole() {
  return readObject(KEY_ROLE, 'member');
}

function setRole(role) {
  writeObject(KEY_ROLE, role);
}

module.exports = {
  MOCK_OPENID,
  KEY_HALLS,
  KEY_SESSIONS,
  KEY_ROLE,
  KEY_COACH,
  KEY_LINKS,
  KEY_MEMBERS,
  KEY_SHOP,
  KEY_SHOP_COACHES,
  KEY_ALL_COACHES,
  KEY_POSTS,
  KEY_POST_LIKES,
  KEY_COMMENTS,
  KEY_FOLLOWS,
  KEY_MATCHES,
  KEY_BOOKINGS,
  KEY_JOINS,
  DEFAULT_HALLS,
  DEMO_MEMBERS,
  DEMO_COACHES,
  readArray,
  writeArray,
  readObject,
  writeObject,
  getRole,
  setRole,
  ensureSeeded
};
