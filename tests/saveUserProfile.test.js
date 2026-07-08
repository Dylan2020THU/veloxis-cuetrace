const assert = require('assert');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');

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

async function testCloudFunctionUpdatesUserProfile() {
  const updates = [];
  const adds = [];
  const fakeDb = {
    serverDate: () => 'SERVER_DATE',
    collection(name) {
      assert.strictEqual(name, 'users');
      return {
        where(query) {
          assert.deepStrictEqual(query, { _openid: 'user_openid' });
          return {
            async get() {
              return { data: [{ _id: 'user_doc_id' }] };
            }
          };
        },
        doc(id) {
          assert.strictEqual(id, 'user_doc_id');
          return {
            async update({ data }) {
              updates.push(data);
            }
          };
        },
        async add({ data }) {
          adds.push(data);
        }
      };
    }
  };
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database() {
      return fakeDb;
    },
    getWXContext() {
      return { OPENID: 'user_openid' };
    }
  };

  const fnPath = path.join(root, 'cloudfunctions/saveUserProfile/index.js');
  const saveUserProfile = withWxServerSdk(fakeCloud, () => require(fnPath));

  const result = await saveUserProfile.main({
    nickname: '张三',
    avatar: 'cloud://avatar',
    gender: '男',
    birthDate: '1999-01-01',
    phone: '13800138000',
    locationCity: '北京',
    hometown: ['云南省', '玉溪市'],
    years: '1年以下',
    level: '0级（纯萌新）',
    canSeeGender: false,
    canSeeBirthDate: true,
    canSeeHometown: false,
    canSeePhone: false
  });

  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(adds.length, 0);
  assert.strictEqual(updates.length, 1);
  assert.deepStrictEqual(updates[0], {
    nickname: '张三',
    avatar: 'cloud://avatar',
    gender: '男',
    birthDate: '1999-01-01',
    phone: '13800138000',
    locationCity: '北京',
    hometown: ['云南省', '玉溪市'],
    years: '1年以下',
    level: '0级（纯萌新）',
    canSeeGender: false,
    canSeeBirthDate: true,
    canSeeHometown: false,
    canSeePhone: false,
    roles: ['member'],
    currentRole: 'member',
    role: 'member',
    updatedAt: 'SERVER_DATE'
  });
}

async function testCloudFunctionPreservesExistingFieldsOnPartialUpdate() {
  const updates = [];
  const fakeDb = {
    serverDate: () => 'SERVER_DATE',
    collection(name) {
      assert.strictEqual(name, 'users');
      return {
        where(query) {
          assert.deepStrictEqual(query, { _openid: 'user_openid' });
          return {
            async get() {
              return {
                data: [{
                  _id: 'user_doc_id',
                  role: 'coach',
                  nickname: 'Coach A',
                  avatar: 'cloud://old-avatar',
                  gender: '男',
                  birthDate: '1990-01-01',
                  phone: '13800138000',
                  locationCity: '北京',
                  hometown: ['北京', '北京市'],
                  years: '5年以上',
                  level: '4级',
                  canSeeGender: false,
                  canSeeBirthDate: false,
                  canSeeHometown: true,
                  canSeePhone: false
                }]
              };
            }
          };
        },
        doc(id) {
          assert.strictEqual(id, 'user_doc_id');
          return {
            async update({ data }) {
              updates.push(data);
            }
          };
        }
      };
    }
  };
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database() {
      return fakeDb;
    },
    getWXContext() {
      return { OPENID: 'user_openid' };
    }
  };

  const fnPath = path.join(root, 'cloudfunctions/saveUserProfile/index.js');
  delete require.cache[require.resolve(fnPath)];
  const saveUserProfile = withWxServerSdk(fakeCloud, () => require(fnPath));

  const result = await saveUserProfile.main({ avatar: 'cloud://new-avatar' });

  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(updates.length, 1);
  assert.deepStrictEqual(updates[0], {
    nickname: 'Coach A',
    avatar: 'cloud://new-avatar',
    gender: '男',
    birthDate: '1990-01-01',
    phone: '13800138000',
    locationCity: '北京',
    hometown: ['北京', '北京市'],
    years: '5年以上',
    level: '4级',
    canSeeGender: false,
    canSeeBirthDate: false,
    canSeeHometown: true,
    canSeePhone: false,
    roles: ['member', 'coach'],
    currentRole: 'coach',
    role: 'coach',
    updatedAt: 'SERVER_DATE'
  });
}

async function testDataServiceForwardsVisibilityFields() {
  const captured = [];
  global.getApp = () => ({ globalData: { cloudReady: true } });
  global.wx = {
    cloud: {
      callFunction(args) {
        captured.push(args);
        return Promise.resolve({ result: { ok: true } });
      }
    }
  };

  const data = require(path.join(root, 'miniprogram/services/data.js'));
  await data.saveUserProfile({
    nickname: '张三',
    avatar: '',
    gender: '男',
    birthDate: '',
    phone: '13800138000',
    locationCity: '北京',
    hometown: ['云南省', '玉溪市'],
    years: '1年以下',
    level: '0级（纯萌新）',
    canSeeGender: false,
    canSeeBirthDate: true,
    canSeeHometown: false,
    canSeePhone: false
  });

  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].name, 'saveUserProfile');
  assert.strictEqual(captured[0].data.canSeeGender, false);
  assert.strictEqual(captured[0].data.canSeeBirthDate, true);
  assert.strictEqual(captured[0].data.canSeeHometown, false);
  assert.strictEqual(captured[0].data.canSeePhone, false);
}

async function testGetUserProfileReturnsSavedProfileFields() {
  const fakeDb = {
    collection(name) {
      assert.strictEqual(name, 'users');
      return {
        where(query) {
          assert.deepStrictEqual(query, { _openid: 'user_openid' });
          return {
            async get() {
              return {
                data: [{
                  _id: 'user_doc_id',
                  role: 'member',
                  nickname: '张三',
                  avatar: 'cloud://avatar',
                  gender: '男',
                  birthDate: '1999-01-01',
                  phone: '13800138000',
                  locationCity: '北京',
                  hometown: ['云南省', '玉溪市'],
                  years: '1年以下',
                  level: '0级（纯萌新）',
                  canSeeGender: false,
                  canSeeBirthDate: true,
                  canSeeHometown: false,
                  canSeePhone: false
                }]
              };
            }
          };
        }
      };
    }
  };
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database() {
      return fakeDb;
    },
    getWXContext() {
      return { OPENID: 'user_openid' };
    }
  };

  const fnPath = path.join(root, 'cloudfunctions/getUserProfile/index.js');
  delete require.cache[require.resolve(fnPath)];
  const getUserProfile = withWxServerSdk(fakeCloud, () => require(fnPath));
  const result = await getUserProfile.main();

  assert.deepStrictEqual(result.user, {
    openid: 'user_openid',
    role: 'member',
    roles: ['member'],
    currentRole: 'member',
    nickname: '张三',
    avatar: 'cloud://avatar',
    gender: '男',
    birthDate: '1999-01-01',
    phone: '13800138000',
    locationCity: '北京',
    hometown: ['云南省', '玉溪市'],
    years: '1年以下',
    level: '0级（纯萌新）',
    canSeeGender: false,
    canSeeBirthDate: true,
    canSeeHometown: false,
    canSeePhone: false
  });
}

(async () => {
  await testCloudFunctionUpdatesUserProfile();
  await testCloudFunctionPreservesExistingFieldsOnPartialUpdate();
  await testDataServiceForwardsVisibilityFields();
  await testGetUserProfileReturnsSavedProfileFields();
})();
