const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function matches(record, query) {
  return Object.keys(query || {}).every((key) => {
    const expected = query[key];
    const actual = record[key];
    if (expected && Array.isArray(expected.$in)) return expected.$in.indexOf(actual) !== -1;
    return actual === expected;
  });
}

function project(record, fields) {
  if (!fields) return record;
  const out = {};
  Object.keys(fields).forEach((key) => {
    if (fields[key]) out[key] = record[key];
  });
  return out;
}

function createFakeDb(seed) {
  class Query {
    constructor(name) {
      this.name = name;
      this.query = {};
      this.fields = null;
      this.skipCount = 0;
      this.limitCount = null;
    }

    where(query) {
      this.query = query || {};
      return this;
    }

    field(fields) {
      this.fields = fields;
      return this;
    }

    skip(n) {
      this.skipCount = Number(n) || 0;
      return this;
    }

    limit(n) {
      this.limitCount = Number(n) || 0;
      return this;
    }

    orderBy() {
      return this;
    }

    async get() {
      let data = (seed[this.name] || []).filter((item) => matches(item, this.query));
      if (this.skipCount) data = data.slice(this.skipCount);
      if (this.limitCount) data = data.slice(0, this.limitCount);
      if (this.fields) data = data.map((item) => project(item, this.fields));
      return { data };
    }
  }

  return {
    command: {
      in(values) {
        return { $in: values || [] };
      }
    },
    collection(name) {
      return new Query(name);
    },
    serverDate() {
      return 'SERVER_DATE';
    }
  };
}

function withWxServerSdk(fakeCloud, fn) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

function loadCloudFunction(relPath, openid, seed) {
  const fnPath = path.join(root, relPath);
  delete require.cache[require.resolve(fnPath)];
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database() {
      return createFakeDb(seed);
    },
    getWXContext() {
      return { OPENID: openid };
    }
  };
  return withWxServerSdk(fakeCloud, () => require(fnPath));
}

async function testCoachMembersUseUserAvatars() {
  const fn = loadCloudFunction('cloudfunctions/getMyMembers/index.js', 'coach_1', {
    coach_member_links: [
      { coachOpenid: 'coach_1', memberOpenid: 'member_1', status: 'active' }
    ],
    users: [
      { _openid: 'member_1', nickname: 'Player One', avatar: 'cloud://player-avatar' }
    ]
  });
  const res = await fn.main();
  assert.strictEqual(res.members.length, 1);
  assert.strictEqual(res.members[0].avatar, 'cloud://player-avatar');
}

async function testShopCoachStudentsUseUserAvatars() {
  const fn = loadCloudFunction('cloudfunctions/getCoachStudents/index.js', 'shop_1', {
    shop_coach_links: [
      { shopOpenid: 'shop_1', coachOpenid: 'coach_1', status: 'active' }
    ],
    coach_member_links: [
      { coachOpenid: 'coach_1', memberOpenid: 'member_1', status: 'active' }
    ],
    users: [
      { _openid: 'member_1', nickname: 'Player One', avatar: 'cloud://student-avatar' }
    ]
  });
  const res = await fn.main({ coachOpenid: 'coach_1' });
  assert.strictEqual(res.students.length, 1);
  assert.strictEqual(res.students[0].avatar, 'cloud://student-avatar');
}

async function testShopMembersUseUserAvatars() {
  const fn = loadCloudFunction('cloudfunctions/getShopMembers/index.js', 'shop_1', {
    shops: [
      { _openid: 'shop_1', storeId: 'store_1', hallId: 'legacy_hall' }
    ],
    training_sessions: [
      { _openid: 'member_1', hallId: 'store_1', date: '2026-07-01', durationMinutes: 90 }
    ],
    users: [
      { _openid: 'member_1', nickname: 'Player One', avatar: 'cloud://shop-member-avatar' }
    ]
  });
  const res = await fn.main({ storeId: 'store_1' });
  assert.strictEqual(res.members.length, 1);
  assert.strictEqual(res.members[0].avatar, 'cloud://shop-member-avatar');
}

async function testHallStatusProfileIndexUsesUserAndCoachAvatars() {
  const fn = loadCloudFunction('cloudfunctions/getMembers/index.js', 'shop_1', {
    members: [
      { _openid: 'shop_1', openid: 'legacy_member', nickname: 'Legacy Member', avatar: 'cloud://legacy-avatar' }
    ],
    sessions: [
      { _openid: 'shop_1', status: 'active', memberOpenid: 'member_1', coachOpenid: 'coach_1' }
    ],
    users: [
      { _openid: 'member_1', role: 'member', nickname: 'Player One', avatar: 'cloud://player-avatar' },
      { _openid: 'coach_1', role: 'coach', nickname: 'Coach In Users', avatar: 'cloud://coach-user-avatar' }
    ],
    coaches: [
      { _openid: 'coach_1', nickname: 'Coach One', avatar: 'cloud://coach-avatar' }
    ]
  });
  const res = await fn.main();
  const byOpenid = {};
  res.members.forEach((item) => { byOpenid[item.openid] = item; });
  assert.strictEqual(byOpenid.member_1.avatar, 'cloud://player-avatar');
  assert.strictEqual(byOpenid.coach_1.avatar, 'cloud://coach-avatar');
  assert.strictEqual(byOpenid.legacy_member.avatar, 'cloud://legacy-avatar');
}

function testAvatarRenderingSurfaces() {
  const surfaces = [
    ['coach members', 'miniprogram/pages/coach/members/index.wxml', /<image[^>]+wx:if="\{\{item\.avatar\}\}"[^>]+src="\{\{item\.avatar\}\}"/],
    ['shop members', 'miniprogram/pages/shop/members/index.wxml', /<image[^>]+wx:if="\{\{item\.avatar\}\}"[^>]+src="\{\{item\.avatar\}\}"/],
    ['shop hall status players', 'miniprogram/pages/shop/hall-status/index.wxml', /<image[^>]+wx:if="\{\{player\.avatar\}\}"[^>]+src="\{\{player\.avatar\}\}"/],
    ['shop hall status pending', 'miniprogram/pages/shop/hall-status/index.wxml', /<image[^>]+wx:if="\{\{item\.avatar\}\}"[^>]+class="use-avatar"[^>]+src="\{\{item\.avatar\}\}"/],
    ['shop coaches', 'miniprogram/pages/shop/coaches/index.wxml', /<image[^>]+wx:if="\{\{item\.avatar\}\}"[^>]+src="\{\{item\.avatar\}\}"/],
    ['shop coach students', 'miniprogram/pages/shop/coach-students/index.wxml', /<image[^>]+wx:if="\{\{item\.avatar\}\}"[^>]+src="\{\{item\.avatar\}\}"/],
    ['coach bookings', 'miniprogram/pages/coach/bookings/index.wxml', /<image[^>]+wx:if="\{\{item\.bookerAvatar\}\}"[^>]+src="\{\{item\.bookerAvatar\}\}"/],
    ['community feed', 'miniprogram/pages/community/index.wxml', /<image[^>]+wx:if="\{\{item\.authorAvatar\}\}"[^>]+src="\{\{item\.authorAvatar\}\}"/],
    ['community detail post', 'miniprogram/pages/community/detail.wxml', /<image[^>]+wx:if="\{\{post\.authorAvatar\}\}"[^>]+src="\{\{post\.authorAvatar\}\}"/],
    ['match list', 'miniprogram/pages/match/index.wxml', /<image[^>]+wx:if="\{\{item\.avatar\}\}"[^>]+src="\{\{item\.avatar\}\}"/],
    ['match detail joiners', 'miniprogram/pages/match/detail/index.wxml', /<image[^>]+wx:if="\{\{item\.avatar\}\}"[^>]+src="\{\{item\.avatar\}\}"/],
    ['profile qrcode', 'miniprogram/pages/profile/qrcode/index.wxml', /<image[^>]+wx:if="\{\{avatar\}\}"[^>]+src="\{\{avatar\}\}"/]
  ];

  surfaces.forEach(([label, file, pattern]) => {
    assert(pattern.test(read(file)), `${label} should render avatar images.`);
  });

  const hallStatusJs = read('miniprogram/pages/shop/hall-status/index.js');
  assert(hallStatusJs.includes('data.getMembers()'), 'Hall status should load profile index with avatars.');
  assert(hallStatusJs.includes('avatar: member && member.avatar ? member.avatar :'), 'Hall status should copy member avatar into table players.');
  assert(hallStatusJs.includes('avatar: coach && coach.avatar ? coach.avatar :'), 'Hall status should copy coach avatar into table players.');
}

(async () => {
  await testCoachMembersUseUserAvatars();
  await testShopCoachStudentsUseUserAvatars();
  await testShopMembersUseUserAvatars();
  await testHallStatusProfileIndexUsesUserAndCoachAvatars();
  testAvatarRenderingSurfaces();
})();
