const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });

const VALID_ROLES = ['member', 'coach', 'shop'];

function bindingId(openid) {
  return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

function tableConfigError(message) {
  const error = new Error(message);
  error.code = 'INVALID_TABLE_CONFIG';
  return error;
}

function isBusinessId(value) {
  return typeof value === 'string'
    && /^[0-9A-Za-z_-]{1,64}$/.test(value)
    && value.indexOf('__') === -1;
}

function priceFenFromTable(table) {
  if (Object.prototype.hasOwnProperty.call(table, 'pricePerHourFen')) {
    if (!Number.isSafeInteger(table.pricePerHourFen) || table.pricePerHourFen <= 0) {
      throw tableConfigError('pricePerHourFen must be a positive safe integer');
    }
    return table.pricePerHourFen;
  }

  const text = typeof table.pricePerHour === 'number'
    ? String(table.pricePerHour)
    : String(table.pricePerHour == null ? '' : table.pricePerHour).trim();
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(text)) {
    throw tableConfigError('pricePerHour must use at most two decimal places');
  }
  const parts = text.split('.');
  const fen = BigInt(parts[0]) * 100n + BigInt((parts[1] || '').padEnd(2, '0') || '0');
  if (fen <= 0n || fen > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw tableConfigError('pricePerHour is outside the supported range');
  }
  return Number(fen);
}

function reusableIdsByName(tableTypes) {
  const ids = new Map();
  (Array.isArray(tableTypes) ? tableTypes : []).forEach((table) => {
    const name = typeof table.name === 'string' ? table.name.trim() : '';
    const tableId = typeof table.tableId === 'string' ? table.tableId.trim() : '';
    if (!name || !isBusinessId(tableId)) return;
    if (ids.has(name)) ids.set(name, '');
    else ids.set(name, tableId);
  });
  return ids;
}

function generateTableId(unavailable) {
  let tableId;
  do {
    tableId = crypto.randomBytes(10).toString('hex');
  } while (unavailable.has(tableId));
  return tableId;
}

function normalizeTableTypes(submitted, persisted) {
  if (!Array.isArray(submitted)) {
    throw tableConfigError('tableTypes must be an array');
  }
  const reusable = reusableIdsByName(persisted);
  const persistedIds = new Set(
    (Array.isArray(persisted) ? persisted : [])
      .map((table) => (typeof table.tableId === 'string' ? table.tableId.trim() : ''))
      .filter(isBusinessId)
  );
  const used = new Set();

  return submitted.map((table) => {
    if (!table || typeof table !== 'object') {
      throw tableConfigError('table entry must be an object');
    }
    const name = typeof table.name === 'string' ? table.name.trim() : '';
    if (!name) throw tableConfigError('table name is required');

    let tableId = typeof table.tableId === 'string' ? table.tableId.trim() : '';
    if (!tableId) {
      const reusableId = reusable.get(name);
      if (reusableId && !used.has(reusableId)) tableId = reusableId;
    }
    if (!tableId) tableId = generateTableId(new Set([...persistedIds, ...used]));
    if (!isBusinessId(tableId)) throw tableConfigError('tableId is invalid');
    if (used.has(tableId)) throw tableConfigError('duplicate tableId');
    used.add(tableId);

    const pricePerHourFen = priceFenFromTable(table);
    return {
      tableId,
      name,
      pricePerHourFen,
      pricePerHour: pricePerHourFen / 100,
      image: typeof table.image === 'string' ? table.image : '',
      bgColor: typeof table.bgColor === 'string' ? table.bgColor : '',
      pricingRuleVersion: 'hourly_exact_v1'
    };
  });
}

async function getDocument(collection, id) {
  const result = await db.collection(collection).doc(id).get();
  return result && result.data ? result.data : null;
}

async function getBoundUser(openid) {
  const userId = bindingId(openid);
  const binding = await getDocument('wechat_bindings', userId);
  if (
    !binding ||
    binding._id !== userId ||
    binding._openid !== openid ||
    !binding.accountId ||
    !binding.account
  ) return null;

  const account = await getDocument('accounts', binding.accountId);
  if (
    !account ||
    account._id !== binding.accountId ||
    account._openid !== openid ||
    account.account !== binding.account ||
    account.status !== 'active'
  ) return null;

  const user = await getDocument('users', userId);
  if (!user || user._id !== userId || user._openid !== openid) return null;
  return user;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const { store } = event;

  if (!store || typeof store.name !== 'string' || !store.name.trim()) {
    return fail('INVALID_INPUT', '门店名称不能为空');
  }

  try {
    const user = await getBoundUser(OPENID);
    if (!user) return fail('ACCOUNT_NOT_BOUND', '账号绑定信息不完整');
    const roles = Array.isArray(user.roles)
      ? user.roles.filter((role) => VALID_ROLES.indexOf(role) !== -1)
      : [];
    if (roles.indexOf('shop') === -1) {
      return fail('SHOP_ROLE_REQUIRED', '当前用户尚未通过店主审核');
    }

    const hasStoreId = Object.prototype.hasOwnProperty.call(store, '_id');
    if (hasStoreId && !isBusinessId(store._id)) {
      return fail('INVALID_INPUT', 'storeId is invalid');
    }
    const existingStore = hasStoreId ? await getDocument('stores', store._id) : null;
    if (hasStoreId && (!existingStore || existingStore._openid !== OPENID)) {
      return fail('STORE_NOT_OWNED', 'Store is not owned by the current shop');
    }
    const tableTypes = normalizeTableTypes(
      Array.isArray(store.tableTypes) ? store.tableTypes : [],
      existingStore && existingStore.tableTypes
    );

    const profile = {
      name: store.name.trim(),
      address: store.address || '',
      brandId: store.brandId || '',
      cover: store.cover || '',
      region: store.region || '',
      // 到店打卡 / 距离：经纬度 + 打卡开关（白名单，未列入的字段会被丢弃）
      lat: typeof store.lat === 'number' ? store.lat : null,
      lng: typeof store.lng === 'number' ? store.lng : null,
      checkinEnabled: !!store.checkinEnabled,
      tableTypes,
      // 球厅信息编辑新增字段：营业时间 / 简介
      businessHours: store.businessHours || '',
      intro: store.intro || '',
      updatedAt: db.serverDate()
    };

    if (hasStoreId) {
      if (!existingStore || existingStore._openid !== OPENID) {
        return fail('STORE_NOT_OWNED', '门店不存在或不属于当前店主');
      }
      await db.collection('stores').doc(store._id).update({ data: profile });
      return { ok: true, storeId: store._id, tableTypes };
    }

    profile._openid = OPENID;
    profile.createdAt = db.serverDate();
    const res = await db.collection('stores').add({ data: profile });
    return { ok: true, storeId: res._id, tableTypes };
  } catch (error) {
    if (error && error.code === 'INVALID_TABLE_CONFIG') {
      return fail('INVALID_TABLE_CONFIG', error.message);
    }
    return fail('STORE_WRITE_FAILED', '门店保存失败，请重试');
  }
};

const { guardClientRequest } = require('./lib/auth/protocol-guard');
const protocolGuardedMain = exports.main;

exports.main = async (event = {}, ...args) => {
  const gate = await guardClientRequest({
    db,
    event,
    supportedSchemaVersions: [1]
  });
  if (!gate.ok) return gate;
  let businessEvent = event;
  if (Object.prototype.hasOwnProperty.call(event, 'authProtocol')) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(businessEvent, ...args);
};
