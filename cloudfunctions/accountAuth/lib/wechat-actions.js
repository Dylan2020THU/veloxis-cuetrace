'use strict';

const crypto = require('crypto');
const {
  candidateHmacIds,
  deriveKey
} = require('./auth/keyring');
const { normalizePhone, newAccountId } = require('./auth/identifiers');
const { prepareSessionToken } = require('./auth/session');
const { consumeSmsChallenge } = require('./auth/sms');
const {
  maskNormalizedPhone,
  migratePhoneBinding,
  newPhoneBindingRecord,
  phoneCandidates,
  readAccountGraph,
  readAccountNameProjection,
  readPhoneCandidateItems,
  selectPhoneBinding
} = require('./account-actions');
const {
  authError,
  failure,
  issueAccountSession,
  newAccountRecord,
  newUserRecord,
  optionalDocument,
  sessionIssuedResponse,
  validDate,
  validPhoneBinding,
  withoutDocumentId
} = require('./store');

const PROOF_TTL_MS = 300 * 1000;
const VERSION_PATTERN = /^[A-Z0-9_]+$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HMAC_NAMESPACE = Buffer.from('cuetrace-auth-v2-hmac\0');

function copyDate(value) {
  return new Date(value.getTime());
}

function lengthPrefixed(value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function exactVersionedHmacId(
  keyring,
  version,
  purpose,
  value,
  prefix
) {
  if (
    !keyring
    || !(keyring.keys instanceof Map)
    || !VERSION_PATTERN.test(version)
    || !keyring.keys.has(version)
    || typeof value !== 'string'
    || !value
    || typeof prefix !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(prefix)
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  try {
    const digest = crypto
      .createHmac('sha256', deriveKey(keyring, version, purpose))
      .update(Buffer.concat([
        HMAC_NAMESPACE,
        lengthPrefixed(purpose),
        lengthPrefixed(prefix),
        lengthPrefixed(value)
      ]))
      .digest('base64url');
    return prefix + '.' + version + '.' + digest;
  } catch (_) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
}

function hasTrustedWechat(trustedWechat) {
  return Boolean(
    trustedWechat
    && trustedWechat.identity
    && typeof trustedWechat.identity.bindingInput === 'string'
    && trustedWechat.identity.bindingInput
    && typeof trustedWechat.appid === 'string'
    && trustedWechat.appid
    && typeof trustedWechat.openid === 'string'
    && trustedWechat.openid
    && (
      trustedWechat.unionid === ''
      || (
        typeof trustedWechat.unionid === 'string'
        && trustedWechat.unionid
      )
    )
  );
}

function candidateMap(candidates) {
  return new Map(candidates.map((candidate) => (
    [candidate.keyVersion, candidate]
  )));
}

function wechatMaterial(keyring, trustedWechat) {
  if (!hasTrustedWechat(trustedWechat)) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  try {
    const bindings = candidateHmacIds(
      keyring,
      'wechat-binding',
      trustedWechat.identity.bindingInput,
      'wechat'
    );
    const appids = candidateMap(candidateHmacIds(
      keyring,
      'wechat-binding',
      trustedWechat.appid,
      'wechat-appid'
    ));
    const openids = candidateMap(candidateHmacIds(
      keyring,
      'wechat-binding',
      trustedWechat.openid,
      'wechat-openid'
    ));
    const unionids = trustedWechat.unionid
      ? candidateMap(candidateHmacIds(
        keyring,
        'wechat-binding',
        trustedWechat.unionid,
        'wechat-unionid'
      ))
      : new Map();
    return {
      candidates: bindings.map((candidate) => ({
        ...candidate,
        appidHash: appids.get(candidate.keyVersion).id,
        openidHash: openids.get(candidate.keyVersion).id,
        unionidHash: trustedWechat.unionid
          ? unionids.get(candidate.keyVersion).id
          : ''
      }))
    };
  } catch (_) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
}

function validVersionedId(value, prefix, version) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return parts.length === 3
    && parts[0] === prefix
    && parts[1] === version
    && DIGEST_PATTERN.test(parts[2]);
}

function validWechatBindingShape(binding, candidate) {
  return Boolean(
    binding
    && typeof binding === 'object'
    && !Array.isArray(binding)
    && binding._id === candidate.id
    && validVersionedId(binding._id, 'wechat', candidate.keyVersion)
    && binding.keyVersion === candidate.keyVersion
    && /^acct_[A-Za-z0-9_-]{22,}$/.test(binding.accountId)
    && validVersionedId(
      binding.appidHash,
      'wechat-appid',
      candidate.keyVersion
    )
    && validVersionedId(
      binding.openidHash,
      'wechat-openid',
      candidate.keyVersion
    )
    && (
      binding.unionidHash === ''
      || validVersionedId(
        binding.unionidHash,
        'wechat-unionid',
        candidate.keyVersion
      )
    )
    && ['active', 'revoked'].includes(binding.status)
    && validDate(binding.consentedAt)
    && validDate(binding.createdAt)
    && validDate(binding.updatedAt)
    && (
      (
        binding.status === 'active'
        && !Object.prototype.hasOwnProperty.call(binding, 'revokeReason')
        && !Object.prototype.hasOwnProperty.call(binding, 'revokedAt')
      )
      || (
        binding.status === 'revoked'
        && binding.revokeReason === 'key_rotated'
        && validDate(binding.revokedAt)
      )
    )
  );
}

async function readWechatCandidateItems(source, material) {
  const items = [];
  for (const candidate of material.candidates) {
    const ref = source.collection('wechat_bindings').doc(candidate.id);
    const binding = await optionalDocument(ref, candidate.id);
    if (binding && !validWechatBindingShape(binding, candidate)) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    if (
      binding
      && (
        binding.appidHash !== candidate.appidHash
        || binding.openidHash !== candidate.openidHash
        || (
          candidate.unionidHash
          && binding.unionidHash
          && binding.unionidHash !== candidate.unionidHash
        )
      )
    ) {
      console.warn('WeChat identity audit conflict', {
        code: 'WECHAT_IDENTITY_CONFLICT'
      });
      throw authError('WECHAT_IDENTITY_CONFLICT');
    }
    items.push({ candidate, ref, binding });
  }
  return items;
}

function selectWechatBinding(items) {
  const existing = items.filter((item) => item.binding);
  const active = existing.filter(
    (item) => item.binding.status === 'active'
  );
  if (!active.length) {
    if (existing.length) throw authError('WECHAT_IDENTITY_CONFLICT');
    return null;
  }
  if (active.length !== 1) {
    throw authError('WECHAT_IDENTITY_CONFLICT');
  }
  const selected = active[0];
  if (existing.some(
    (item) => item.binding.accountId !== selected.binding.accountId
  )) {
    throw authError('WECHAT_IDENTITY_CONFLICT');
  }
  return selected;
}

function newWechatBindingRecord({
  candidate,
  accountId,
  now,
  consentedAt,
  createdAt
}) {
  return {
    _id: candidate.id,
    accountId,
    keyVersion: candidate.keyVersion,
    appidHash: candidate.appidHash,
    openidHash: candidate.openidHash,
    unionidHash: candidate.unionidHash,
    status: 'active',
    consentedAt: consentedAt
      ? copyDate(consentedAt)
      : copyDate(now),
    createdAt: createdAt ? copyDate(createdAt) : copyDate(now),
    updatedAt: copyDate(now)
  };
}

async function migrateWechatBinding({
  items,
  selected,
  account,
  accountRef,
  now
}) {
  if (account.wechatBindingId !== selected.binding._id) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  const activeItem = items[0];
  if (!selected.candidate.isActive) {
    if (activeItem.binding) {
      throw authError('WECHAT_IDENTITY_CONFLICT');
    }
    if (
      selected.binding.unionidHash
      && !activeItem.candidate.unionidHash
    ) {
      return { account, binding: selected.binding };
    }
    const binding = newWechatBindingRecord({
      candidate: activeItem.candidate,
      accountId: account._id,
      now,
      consentedAt: selected.binding.consentedAt,
      createdAt: selected.binding.createdAt
    });
    await activeItem.ref.set({ data: withoutDocumentId(binding) });
    await selected.ref.update({
      data: {
        status: 'revoked',
        revokeReason: 'key_rotated',
        revokedAt: copyDate(now),
        updatedAt: copyDate(now)
      }
    });
    await accountRef.update({
      data: {
        wechatBindingId: binding._id,
        updatedAt: copyDate(now)
      }
    });
    return {
      binding,
      account: {
        ...account,
        wechatBindingId: binding._id,
        updatedAt: copyDate(now)
      }
    };
  }
  if (
    !selected.binding.unionidHash
    && selected.candidate.unionidHash
  ) {
    await selected.ref.update({
      data: {
        unionidHash: selected.candidate.unionidHash,
        updatedAt: copyDate(now)
      }
    });
    return {
      account,
      binding: {
        ...selected.binding,
        unionidHash: selected.candidate.unionidHash,
        updatedAt: copyDate(now)
      }
    };
  }
  return { account, binding: selected.binding };
}

async function readPhoneProjection(source, account) {
  if (!account.phoneBindingId) return null;
  const parts = account.phoneBindingId.split('.');
  const candidate = {
    id: account.phoneBindingId,
    keyVersion: parts.length === 3 ? parts[1] : ''
  };
  const binding = await optionalDocument(
    source
      .collection('phone_bindings')
      .doc(account.phoneBindingId),
    account.phoneBindingId
  );
  if (
    !binding
    || !validPhoneBinding(binding, candidate)
    || binding.status !== 'active'
    || binding.accountId !== account._id
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  return binding;
}

function newProofToken(keyring) {
  let random;
  try {
    random = crypto.randomBytes(32);
  } catch (_) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  if (!Buffer.isBuffer(random) || random.length !== 32) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  return 'v2.'
    + keyring.activeVersion
    + '.'
    + random.toString('base64url');
}

function parseProofToken(proofToken, keyring) {
  if (typeof proofToken !== 'string') return null;
  const parts = proofToken.split('.');
  if (
    parts.length !== 3
    || parts[0] !== 'v2'
    || !VERSION_PATTERN.test(parts[1])
    || !DIGEST_PATTERN.test(parts[2])
  ) {
    return null;
  }
  let random;
  try {
    random = Buffer.from(parts[2], 'base64url');
  } catch (_) {
    return null;
  }
  if (
    random.length !== 32
    || random.toString('base64url') !== parts[2]
  ) {
    return null;
  }
  try {
    return {
      keyVersion: parts[1],
      proofId: exactVersionedHmacId(
      keyring,
      parts[1],
      'auth-proof',
      proofToken,
      'auth-proof'
      )
    };
  } catch (_) {
    return null;
  }
}

function proofClientHash(keyring, clientInstanceId, version) {
  try {
    return exactVersionedHmacId(
      keyring,
      version,
      'auth-proof',
      clientInstanceId,
      'proof-client'
    );
  } catch (_) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
}

function proofIdentity(material, version) {
  const candidate = material.candidates.find(
    (item) => item.keyVersion === version
  );
  if (!candidate) throw authError('AUTH_CONFLICT');
  return candidate;
}

function validProofRecord(record, parsed, keyring) {
  const forbiddenFields = [
    'proofToken',
    'token',
    'phone',
    'appid',
    'openid',
    'unionid'
  ];
  return Boolean(
    record
    && typeof record === 'object'
    && !Array.isArray(record)
    && record._id === parsed.proofId
    && validVersionedId(
      record._id,
      'auth-proof',
      parsed.keyVersion
    )
    && record.keyVersion === parsed.keyVersion
    && record.purpose === 'wechat_entry'
    && Array.isArray(record.phoneBindingCandidateIds)
    && record.phoneBindingCandidateIds.length
      === 1 + keyring.historicalVersions.length
    && new Set(record.phoneBindingCandidateIds).size
      === record.phoneBindingCandidateIds.length
    && record.phoneBindingCandidateIds[0]
      === record.phoneBindingId
    && record.phoneBindingCandidateIds.every((id, index) => {
      if (typeof id !== 'string') return false;
      const parts = id.split('.');
      const expectedVersions = [
        keyring.activeVersion,
        ...keyring.historicalVersions
      ];
      return parts.length === 3
        && parts[0] === 'phone'
        && parts[1] === expectedVersions[index]
        && DIGEST_PATTERN.test(parts[2]);
    })
    && /^phone\.[A-Z0-9_]+\.[A-Za-z0-9_-]{43}$/.test(
      record.phoneBindingId
    )
    && /^1\d{2}\*{4}\d{4}$/.test(record.phoneMasked)
    && validVersionedId(
      record.wechatBindingId,
      'wechat',
      parsed.keyVersion
    )
    && validVersionedId(
      record.appidHash,
      'wechat-appid',
      parsed.keyVersion
    )
    && validVersionedId(
      record.openidHash,
      'wechat-openid',
      parsed.keyVersion
    )
    && (
      record.unionidHash === ''
      || validVersionedId(
        record.unionidHash,
        'wechat-unionid',
        parsed.keyVersion
      )
    )
    && validVersionedId(
      record.clientInstanceHash,
      'proof-client',
      parsed.keyVersion
    )
    && typeof record.termsVersion === 'string'
    && typeof record.privacyVersion === 'string'
    && validDate(record.createdAt)
    && validDate(record.expiresAt)
    && record.expiresAt.getTime()
      === record.createdAt.getTime() + PROOF_TTL_MS
    && typeof record.used === 'boolean'
    && (
      (record.used && validDate(record.usedAt))
      || (!record.used && record.usedAt === null)
    )
    && forbiddenFields.every(
      (field) => !Object.prototype.hasOwnProperty.call(record, field)
    )
  );
}

async function loginWechat({
  db,
  event,
  now,
  keyring,
  trustedWechat
}) {
  const material = wechatMaterial(keyring, trustedWechat);
  const preliminaryItems = await readWechatCandidateItems(db, material);
  if (!selectWechatBinding(preliminaryItems)) {
    return failure('WECHAT_NOT_BOUND', { next: 'wechat_phone' });
  }
  const preparedSessionToken = prepareSessionToken(keyring);
  return db.runTransaction(async (transaction) => {
    const items = await readWechatCandidateItems(transaction, material);
    const selected = selectWechatBinding(items);
    if (!selected) throw authError('AUTH_CONFLICT');
    const graph = await readAccountGraph(
      transaction,
      selected.binding.accountId
    );
    if (graph.account.status !== 'active') {
      throw authError('ACCOUNT_DISABLED');
    }
    const migrated = await migrateWechatBinding({
      items,
      selected,
      account: graph.account,
      accountRef: transaction
        .collection('accounts')
        .doc(graph.account._id),
      now
    });
    const accountNameRelation = await readAccountNameProjection(
      transaction,
      migrated.account
    );
    const phoneBinding = await readPhoneProjection(
      transaction,
      migrated.account
    );
    const issued = await issueAccountSession({
      transaction,
      db,
      account: migrated.account,
      user: graph.user,
      clientInstanceId: event.clientInstanceId,
      method: 'wechat',
      now,
      keyring,
      preparedSessionToken
    });
    return sessionIssuedResponse({
      issued,
      user: issued.user,
      accountNameRelation,
      phoneBinding,
      method: 'wechat',
      now
    });
  });
}

async function verifyWechatEntryPhone({
  db,
  event,
  now,
  keyring,
  trustedWechat
}) {
  const normalizedPhone = normalizePhone(event.phone);
  const candidates = phoneCandidates(keyring, normalizedPhone);
  const material = wechatMaterial(keyring, trustedWechat);
  const proofToken = newProofToken(keyring);
  const proofId = exactVersionedHmacId(
    keyring,
    keyring.activeVersion,
    'auth-proof',
    proofToken,
    'auth-proof'
  );
  const identity = proofIdentity(material, keyring.activeVersion);
  const clientInstanceHash = proofClientHash(
    keyring,
    event.clientInstanceId,
    keyring.activeVersion
  );
  const expectedScope = {
    purpose: 'wechat_entry',
    clientInstanceId: event.clientInstanceId,
    wechatBindingInput: trustedWechat.identity.bindingInput,
    accountId: '',
    sessionId: ''
  };
  return db.runTransaction(async (transaction) => {
    const consumed = await consumeSmsChallenge({
      transaction,
      challengeId: event.challengeId,
      code: event.code,
      expectedPurpose: 'wechat_entry',
      expectedScope,
      now,
      keyring
    });
    if (!consumed.ok) return failure(consumed.code);
    if (!candidates.some(
      (candidate) => candidate.id === consumed.phoneBindingId
    )) {
      throw authError('SMS_CODE_INVALID');
    }
    if (consumed.phoneMasked !== maskNormalizedPhone(normalizedPhone)) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    const proofRef = transaction.collection('auth_proofs').doc(proofId);
    const collision = await optionalDocument(proofRef, proofId);
    if (collision) throw authError('AUTH_INTERNAL_ERROR');
    await proofRef.set({
      data: {
        purpose: 'wechat_entry',
        keyVersion: keyring.activeVersion,
        phoneBindingId: candidates[0].id,
        phoneBindingCandidateIds: candidates.map(
          (candidate) => candidate.id
        ),
        phoneMasked: consumed.phoneMasked,
        wechatBindingId: identity.id,
        appidHash: identity.appidHash,
        openidHash: identity.openidHash,
        unionidHash: identity.unionidHash,
        clientInstanceHash,
        termsVersion: event.termsVersion,
        privacyVersion: event.privacyVersion,
        createdAt: copyDate(now),
        expiresAt: new Date(now.getTime() + PROOF_TTL_MS),
        used: false,
        usedAt: null
      }
    });
    return {
      ok: true,
      kind: 'wechat_phone_proof',
      proofToken,
      expiresIn: 300
    };
  });
}

async function completeWechatEntry({
  db,
  event,
  now,
  keyring,
  trustedWechat
}) {
  const parsed = parseProofToken(event.proofToken, keyring);
  if (!parsed) throw authError('AUTH_CONFLICT');
  const material = wechatMaterial(keyring, trustedWechat);
  const expectedIdentity = proofIdentity(material, parsed.keyVersion);
  const expectedClientHash = proofClientHash(
    keyring,
    event.clientInstanceId,
    parsed.keyVersion
  );
  const preparedSessionToken = prepareSessionToken(keyring);
  const accountId = newAccountId();

  return db.runTransaction(async (transaction) => {
    const proofRef = transaction
      .collection('auth_proofs')
      .doc(parsed.proofId);
    const proof = await optionalDocument(proofRef, parsed.proofId);
    if (
      !proof
      || !validProofRecord(proof, parsed, keyring)
      || proof.used
      || now.getTime() >= proof.expiresAt.getTime()
      || proof.wechatBindingId !== expectedIdentity.id
      || proof.appidHash !== expectedIdentity.appidHash
      || proof.openidHash !== expectedIdentity.openidHash
      || proof.unionidHash !== expectedIdentity.unionidHash
      || proof.clientInstanceHash !== expectedClientHash
      || proof.termsVersion !== event.termsVersion
      || proof.privacyVersion !== event.privacyVersion
    ) {
      throw authError('AUTH_CONFLICT');
    }

    const proofPhoneCandidates = proof.phoneBindingCandidateIds.map(
      (id, index) => ({
        id,
        keyVersion: id.split('.')[1],
        isActive: index === 0
      })
    );
    if (
      proofPhoneCandidates[0].keyVersion !== keyring.activeVersion
    ) {
      throw authError('AUTH_CONFLICT');
    }
    const phoneItems = await readPhoneCandidateItems(
      transaction,
      proofPhoneCandidates
    );
    const selectedPhone = selectPhoneBinding(phoneItems);
    let account;
    let user;
    let phoneBinding;
    if (selectedPhone) {
      if (selectedPhone.binding.phoneMasked !== proof.phoneMasked) {
        throw authError('AUTH_CONFLICT');
      }
      const graph = await readAccountGraph(
        transaction,
        selectedPhone.binding.accountId
      );
      account = graph.account;
      user = graph.user;
      if (account.status !== 'active') {
        throw authError('ACCOUNT_DISABLED');
      }
      const migrated = await migratePhoneBinding({
        items: phoneItems,
        selected: selectedPhone,
        accountRef: transaction
          .collection('accounts')
          .doc(account._id),
        account,
        phoneMasked: proof.phoneMasked,
        now
      });
      account = migrated.account;
      phoneBinding = migrated.binding;
    } else {
      const accountRef = transaction.collection('accounts').doc(accountId);
      const userRef = transaction.collection('users').doc(accountId);
      const accountCollision = await optionalDocument(accountRef, accountId);
      const userCollision = await optionalDocument(userRef, accountId);
      if (accountCollision || userCollision) {
        throw authError('AUTH_INTERNAL_ERROR');
      }
      phoneBinding = newPhoneBindingRecord({
        id: proof.phoneBindingId,
        accountId,
        keyVersion: proofPhoneCandidates[0].keyVersion,
        phoneMasked: proof.phoneMasked,
        now,
        verifiedAt: proof.createdAt
      });
      account = newAccountRecord({
        accountId,
        passwordRecord: null,
        accountNameBindingId: '',
        consent: {
          termsVersion: event.termsVersion,
          privacyVersion: event.privacyVersion
        },
        now
      });
      account.phoneBindingId = phoneBinding._id;
      user = newUserRecord(accountId, now);
      await accountRef.set({ data: withoutDocumentId(account) });
      await phoneItems[0].ref.set({
        data: withoutDocumentId(phoneBinding)
      });
      await userRef.set({ data: withoutDocumentId(user) });
    }

    if (event.bindWechat) {
      if (account.wechatBindingId) {
        throw authError('ACCOUNT_WECHAT_ALREADY_BOUND');
      }
      const wechatItems = await readWechatCandidateItems(
        transaction,
        material
      );
      if (selectWechatBinding(wechatItems)) {
        throw authError('WECHAT_ALREADY_BOUND');
      }
      const wechatBinding = newWechatBindingRecord({
        candidate: material.candidates[0],
        accountId: account._id,
        now
      });
      await wechatItems[0].ref.set({
        data: withoutDocumentId(wechatBinding)
      });
      const updatedAt = copyDate(now);
      await transaction
        .collection('accounts')
        .doc(account._id)
        .update({
          data: {
            wechatBindingId: wechatBinding._id,
            updatedAt
          }
        });
      account = {
        ...account,
        wechatBindingId: wechatBinding._id,
        updatedAt
      };
    }

    await proofRef.update({
      data: {
        used: true,
        usedAt: copyDate(now)
      }
    });
    const accountNameRelation = await readAccountNameProjection(
      transaction,
      account
    );
    const issued = await issueAccountSession({
      transaction,
      db,
      account,
      user,
      clientInstanceId: event.clientInstanceId,
      method: 'sms',
      now,
      keyring,
      preparedSessionToken
    });
    return sessionIssuedResponse({
      issued,
      user: issued.user,
      accountNameRelation,
      phoneBinding,
      method: 'sms',
      now
    });
  });
}

module.exports = {
  completeWechatEntry,
  loginWechat,
  migrateWechatBinding,
  newWechatBindingRecord,
  readPhoneProjection,
  readWechatCandidateItems,
  selectWechatBinding,
  validWechatBindingShape,
  verifyWechatEntryPhone,
  wechatMaterial
};
