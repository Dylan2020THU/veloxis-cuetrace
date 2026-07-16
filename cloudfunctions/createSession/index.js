const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const VALID_ROLES = ['member', 'coach', 'shop'];
const MAX_CHECKIN_AGE_MS = 30 * 60 * 1000;
const MAX_CHECKIN_CLOCK_SKEW_MS = 60 * 1000;
const ALLOWED_KEYS = new Set([
  'storeId',
  'tableId',
  'memberOpenid',
  'memberCheckinId',
  'coachOpenid',
  'coachCheckinId',
  'coachLinkId',
  'coachJoinedAt',
  'verified'
]);

function bindingId(openid) {
  return crypto.createHash('sha256').update('wechat:' + openid).digest('hex');
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

function isBusinessId(value) {
  return typeof value === 'string'
    && /^[0-9A-Za-z_-]{1,64}$/.test(value)
    && value.indexOf('__') === -1;
}

function isOpenid(value) {
  return typeof value === 'string'
    && /^[0-9A-Za-z_-]{1,128}$/.test(value);
}

function isCurrentCheckinTime(value, now) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value >= now - MAX_CHECKIN_AGE_MS
    && value <= now + MAX_CHECKIN_CLOCK_SKEW_MS;
}

function isTrustedMemberCheckin(checkin, expected, now) {
  return !!checkin
    && checkin._id === expected.memberCheckinId
    && checkin.memberOpenid === expected.memberOpenid
    && checkin.storeId === expected.storeId
    && checkin.tableId === expected.tableId
    && checkin.role === 'member'
    && checkin.ready === true
    && checkin.status === 'pending'
    && (checkin.sessionId === undefined || checkin.sessionId === null || checkin.sessionId === '')
    && (checkin.boundAt === undefined || checkin.boundAt === null)
    && isCurrentCheckinTime(checkin.joinedAt, now)
    && isCurrentCheckinTime(checkin.readyAt, now);
}

function isTrustedCoachLink(link, expected) {
  return !!link
    && link._id === expected.coachLinkId
    && link.shopOpenid === expected.shopId
    && link.coachOpenid === expected.coachOpenid
    && link.status === 'active'
    && (!link.storeId || link.storeId === expected.storeId);
}

function isTrustedCoachCheckin(checkin, expected, now) {
  return !!checkin
    && checkin._id === expected.coachCheckinId
    && checkin.memberOpenid === expected.coachOpenid
    && checkin.storeId === expected.storeId
    && checkin.tableId === expected.tableId
    && checkin.role === 'coach'
    && checkin.ready === true
    && checkin.status === 'pending'
    && (checkin.sessionId === undefined || checkin.sessionId === null || checkin.sessionId === '')
    && (checkin.boundAt === undefined || checkin.boundAt === null)
    && isCurrentCheckinTime(checkin.joinedAt, now)
    && isCurrentCheckinTime(checkin.readyAt, now);
}

function checkinSlotId(storeId, tableId, role) {
  return crypto.createHash('sha256')
    .update(`checkin-slot\0${storeId}\0${tableId}\0${role}`)
    .digest('hex');
}

function isTrustedCheckinSlot(slot, expected) {
  return !!slot
    && slot._id === expected.slotId
    && slot.schemaVersion === 1
    && slot.storeId === expected.storeId
    && slot.tableId === expected.tableId
    && slot.role === expected.role
    && slot.currentRequestId === expected.requestId
    && slot.memberOpenid === expected.memberOpenid
    && slot.status === 'pending'
    && (slot.sessionId === undefined || slot.sessionId === null || slot.sessionId === '')
    && (slot.boundAt === undefined || slot.boundAt === null);
}

function occupancyIdFor(storeId, tableId) {
  return String(storeId.length) + '_' + storeId + '__' + tableId;
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

async function requireShopOwner(source, openid) {
  const userId = bindingId(openid);
  const binding = await getOptional(source.collection('wechat_bindings').doc(userId));
  if (
    !binding ||
    binding._id !== userId ||
    binding._openid !== openid ||
    !binding.accountId ||
    !binding.account
  ) {
    return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');
  }

  const account = await getOptional(source.collection('accounts').doc(binding.accountId));
  const user = await getOptional(source.collection('users').doc(userId));
  if (
    !account ||
    account._id !== binding.accountId ||
    account._openid !== openid ||
    account.account !== binding.account ||
    account.status !== 'active' ||
    !user ||
    user._id !== userId ||
    user._openid !== openid
  ) {
    return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');
  }

  const roles = Array.isArray(user.roles)
    ? user.roles.filter((role) => VALID_ROLES.indexOf(role) !== -1)
    : [];
  if (roles.indexOf('shop') === -1) {
    return fail('SHOP_ROLE_REQUIRED', 'An approved shop role is required');
  }
  return null;
}

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return fail('INVALID_INPUT', 'Input must be an object');
  }
  if (Object.keys(event).some((key) => !ALLOWED_KEYS.has(key))) {
    return fail('INVALID_INPUT', 'Unsupported session input');
  }
  if (
    typeof event.storeId !== 'string' ||
    !isBusinessId(event.storeId.trim()) ||
    typeof event.tableId !== 'string' ||
    !isBusinessId(event.tableId.trim())
  ) {
    return fail('INVALID_INPUT', 'storeId and tableId are invalid');
  }
  for (const key of ['memberOpenid', 'coachOpenid']) {
    if (event[key] !== undefined && typeof event[key] !== 'string') {
      return fail('INVALID_INPUT', key + ' must be a string');
    }
  }
  const memberOpenid = event.memberOpenid || '';
  const coachOpenid = event.coachOpenid || '';
  if ((memberOpenid && !isOpenid(memberOpenid)) || (coachOpenid && !isOpenid(coachOpenid))) {
    return fail('INVALID_INPUT', 'Participant OpenID is invalid');
  }
  for (const key of ['memberCheckinId', 'coachCheckinId', 'coachLinkId']) {
    if (
      event[key] !== undefined
      && event[key] !== ''
      && (typeof event[key] !== 'string' || !isBusinessId(event[key]))
    ) {
      return fail('INVALID_INPUT', key + ' is invalid');
    }
  }
  if (memberOpenid && !event.memberCheckinId) {
    return fail('MEMBER_CHECKIN_REQUIRED', 'A current member check-in is required');
  }
  if (!memberOpenid && event.memberCheckinId) {
    return fail('INVALID_INPUT', 'memberCheckinId requires memberOpenid');
  }
  if (coachOpenid && !event.coachLinkId) {
    return fail('COACH_LINK_REQUIRED', 'An active coach link is required');
  }
  if (coachOpenid && !event.coachCheckinId) {
    return fail('COACH_CHECKIN_REQUIRED', 'A current coach check-in is required');
  }
  if (!coachOpenid && (event.coachLinkId || event.coachCheckinId)) {
    return fail('INVALID_INPUT', 'Coach identifiers require coachOpenid');
  }
  if (
    event.coachJoinedAt !== undefined &&
    event.coachJoinedAt !== null &&
    !Number.isFinite(event.coachJoinedAt)
  ) {
    return fail('INVALID_INPUT', 'coachJoinedAt must be a finite timestamp');
  }
  return null;
}

function serverPricingSnapshot(table) {
  if (
    !table ||
    typeof table.name !== 'string' ||
    !table.name.trim() ||
    !Number.isSafeInteger(table.pricePerHourFen) ||
    table.pricePerHourFen <= 0 ||
    table.pricingRuleVersion !== 'hourly_exact_v1'
  ) {
    return null;
  }
  return {
    tableId: table.tableId,
    name: table.name.trim(),
    pricePerHourFen: table.pricePerHourFen,
    pricePerHour: table.pricePerHourFen / 100,
    pricingRuleVersion: 'hourly_exact_v1',
    minimumDurationMs: 0,
    billingStepMs: 1,
    roundingMode: 'nearest_fen'
  };
}

exports.main = async (event = {}) => {
  const invalid = validateInput(event);
  if (invalid) return invalid;

  const { OPENID } = cloud.getWXContext();
  const storeId = event.storeId.trim();
  const tableId = event.tableId.trim();

  try {
    return await db.runTransaction(async (transaction) => {
      const authorizationError = await requireShopOwner(transaction, OPENID);
      if (authorizationError) return authorizationError;

      const store = await getOptional(transaction.collection('stores').doc(storeId));
      if (!store || store._id !== storeId || store._openid !== OPENID) {
        return fail('STORE_NOT_OWNED', 'Store is not owned by the current shop');
      }

      const table = (Array.isArray(store.tableTypes) ? store.tableTypes : [])
        .find((item) => item && item.tableId === tableId);
      const snapshot = serverPricingSnapshot(table);
      if (!snapshot || snapshot.tableId !== tableId) {
        return fail('TABLE_CONFIG_INVALID', 'Trusted table configuration was not found');
      }

      const occupancyId = occupancyIdFor(storeId, tableId);
      const occupancyRef = transaction.collection('table_occupancies').doc(occupancyId);
      const occupancy = await getOptional(occupancyRef);
      if (occupancy) return fail('TABLE_OCCUPIED', 'Table is already occupied');

      const now = Date.now();
      const memberOpenid = event.memberOpenid || '';
      const memberCheckinId = event.memberCheckinId || '';
      const coachOpenid = event.coachOpenid || '';
      const coachLinkId = event.coachLinkId || '';
      let memberCheckin = null;
      let memberCheckinRef = null;
      let memberSlotRef = null;
      if (memberOpenid) {
        memberCheckinRef = transaction.collection('checkin_requests').doc(memberCheckinId);
        memberCheckin = await getOptional(memberCheckinRef);
        if (!isTrustedMemberCheckin(memberCheckin, {
          memberCheckinId,
          memberOpenid,
          storeId,
          tableId
        }, now)) {
          return fail('MEMBER_CHECKIN_INVALID', 'The member check-in is not current or reusable');
        }
        const memberSlotId = checkinSlotId(storeId, tableId, 'member');
        memberSlotRef = transaction.collection('table_checkin_slots').doc(memberSlotId);
        const memberSlot = await getOptional(memberSlotRef);
        if (
          memberCheckin.slotId !== memberSlotId
          || !isTrustedCheckinSlot(memberSlot, {
            slotId: memberSlotId,
            storeId,
            tableId,
            role: 'member',
            requestId: memberCheckinId,
            memberOpenid
          })
        ) {
          return fail('MEMBER_CHECKIN_SLOT_INVALID', 'The member check-in slot is inconsistent');
        }
      }
      const coachCheckinId = event.coachCheckinId || '';
      let coachCheckin = null;
      let coachCheckinRef = null;
      let coachSlotRef = null;
      if (coachOpenid) {
        coachCheckinRef = transaction.collection('checkin_requests').doc(coachCheckinId);
        coachCheckin = await getOptional(coachCheckinRef);
        if (!isTrustedCoachCheckin(coachCheckin, {
          coachCheckinId,
          coachOpenid,
          storeId,
          tableId
        }, now)) {
          return fail('COACH_CHECKIN_INVALID', 'The coach check-in is not current or reusable');
        }
        const coachSlotId = checkinSlotId(storeId, tableId, 'coach');
        coachSlotRef = transaction.collection('table_checkin_slots').doc(coachSlotId);
        const coachSlot = await getOptional(coachSlotRef);
        if (
          coachCheckin.slotId !== coachSlotId
          || !isTrustedCheckinSlot(coachSlot, {
            slotId: coachSlotId,
            storeId,
            tableId,
            role: 'coach',
            requestId: coachCheckinId,
            memberOpenid: coachOpenid
          })
        ) {
          return fail('COACH_CHECKIN_SLOT_INVALID', 'The coach check-in slot is inconsistent');
        }
        const coachLink = await getOptional(
          transaction.collection('shop_coach_links').doc(coachLinkId)
        );
        if (!isTrustedCoachLink(coachLink, {
          coachLinkId,
          coachOpenid,
          shopId: OPENID,
          storeId
        })) {
          return fail('COACH_LINK_INVALID', 'The coach link is not active for this store');
        }
      }
      const session = {
        schemaVersion: 2,
        _openid: OPENID,
        shopId: OPENID,
        storeId,
        tableId,
        pricingSnapshot: snapshot,
        status: 'active',
        startedAt: now,
        checkoutAt: null,
        closedAt: null,
        orderId: '',
        openedBy: OPENID,
        checkoutBy: '',
        memberOpenid,
        memberCheckinId,
        memberCheckinJoinedAt: memberCheckin ? memberCheckin.joinedAt : null,
        memberReadyAt: memberCheckin ? memberCheckin.readyAt : null,
        coachOpenid,
        coachCheckinId,
        coachCheckinJoinedAt: coachCheckin ? coachCheckin.joinedAt : null,
        coachReadyAt: coachCheckin ? coachCheckin.readyAt : null,
        coachLinkId,
        coachJoinedAt: coachOpenid ? now : null,
        verified: !!event.verified,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      };
      const added = await transaction.collection('sessions').add({ data: session });
      if (memberCheckinRef) {
        await memberCheckinRef.update({
          data: {
            status: 'confirmed',
            sessionId: added._id,
            boundAt: now,
            resolvedAt: now
          }
        });
        await memberSlotRef.update({
          data: {
            status: 'confirmed',
            sessionId: added._id,
            boundAt: now,
            updatedAt: db.serverDate()
          }
        });
      }
      if (coachCheckinRef) {
        await coachCheckinRef.update({
          data: {
            status: 'confirmed',
            sessionId: added._id,
            boundAt: now,
            resolvedAt: now
          }
        });
        await coachSlotRef.update({
          data: {
            status: 'confirmed',
            sessionId: added._id,
            boundAt: now,
            updatedAt: db.serverDate()
          }
        });
      }
      await occupancyRef.set({
        data: {
          shopId: OPENID,
          storeId,
          tableId,
          sessionId: added._id,
          status: 'active',
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      return { ok: true, sessionId: added._id };
    });
  } catch (error) {
    return fail('SESSION_CREATE_FAILED', 'Session could not be created');
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
