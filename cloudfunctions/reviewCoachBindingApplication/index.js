const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const VALID_ROLES = ['member', 'coach', 'shop'];

function bindingId(openid) {
  return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
}

function linkId(storeId, coachOpenid) {
  return crypto.createHash('sha256').update(`shop-coach:${storeId}:${coachOpenid}`).digest('hex');
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

async function getDocument(transaction, collection, id) {
  const result = await transaction.collection(collection).doc(id).get();
  return result && result.data ? result.data : null;
}

async function getBoundIdentity(transaction, openid) {
  const userId = bindingId(openid);
  const binding = await getDocument(transaction, 'wechat_bindings', userId);
  if (
    !binding ||
    binding._id !== userId ||
    binding._openid !== openid ||
    !binding.accountId ||
    !binding.account
  ) return null;

  const account = await getDocument(transaction, 'accounts', binding.accountId);
  if (
    !account ||
    account._id !== binding.accountId ||
    account._openid !== openid ||
    account.account !== binding.account ||
    account.status !== 'active'
  ) return null;

  const user = await getDocument(transaction, 'users', userId);
  if (!user || user._id !== userId || user._openid !== openid) return null;
  return { binding, account, user, userId };
}

function mergeCoachRole(user) {
  const roles = Array.isArray(user && user.roles)
    ? user.roles.filter((role) => VALID_ROLES.indexOf(role) !== -1)
    : [];
  if (roles.indexOf('coach') === -1) roles.push('coach');
  return Array.from(new Set(roles));
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const { applicationId, approve, reason } = event;
  if (!applicationId) return fail('INVALID_INPUT', '缺少申请 ID');

  try {
    return await db.runTransaction(async (transaction) => {
      const applicationRef = transaction.collection('coach_shop_applications').doc(applicationId);
      const application = await getDocument(
        transaction,
        'coach_shop_applications',
        applicationId
      );
      if (!application) return fail('APPLICATION_NOT_FOUND', '申请不存在');
      if (application.status !== 'pending') {
        return fail('APPLICATION_NOT_PENDING', '申请已处理，请刷新后重试');
      }
      if (!application.coachOpenid || application._openid !== application.coachOpenid) {
        return fail('ACCOUNT_NOT_BOUND', '申请人账号绑定信息不完整');
      }

      const store = await getDocument(transaction, 'stores', application.storeId);
      if (
        !store ||
        !store._openid ||
        application.shopOpenid !== store._openid
      ) return fail('STORE_NOT_OWNED', '申请门店信息不可信');

      const reviewer = await getBoundIdentity(transaction, OPENID);
      if (!reviewer) return fail('ACCOUNT_NOT_BOUND', '审核者账号绑定信息不完整');
      if (!Array.isArray(reviewer.user.roles) || reviewer.user.roles.indexOf('shop') === -1) {
        return fail('SHOP_ROLE_REQUIRED', '当前用户尚未通过店主审核');
      }
      if (store._openid !== OPENID) {
        return fail('STORE_NOT_OWNED', '无权审核其他门店的申请');
      }
      if (application.coachOpenid === OPENID) {
        return fail('SELF_REVIEW_NOT_ALLOWED', '不能审核自己的申请');
      }

      const applicant = await getBoundIdentity(transaction, application.coachOpenid);
      if (!applicant) return fail('ACCOUNT_NOT_BOUND', '申请人账号绑定信息不完整');

      const deterministicLinkId = linkId(store._id, application.coachOpenid);
      const existingLink = approve
        ? await getDocument(transaction, 'shop_coach_links', deterministicLinkId)
        : null;
      const existingCoach = approve
        ? await getDocument(transaction, 'coaches', applicant.userId)
        : null;
      const status = approve ? 'approved' : 'rejected';
      const now = db.serverDate();

      await applicationRef.update({
        data: {
          status,
          reason: approve ? '' : (reason || '店家未通过绑定申请'),
          reviewedBy: OPENID,
          reviewedAt: now,
          updatedAt: now
        }
      });

      if (approve) {
        await transaction.collection('shop_coach_links').doc(deterministicLinkId).set({
          data: {
            _id: deterministicLinkId,
            shopOpenid: OPENID,
            coachOpenid: application.coachOpenid,
            storeId: store._id,
            storeName: store.name || '',
            status: 'active',
            source: 'coach_apply',
            applicationId,
            createdAt: existingLink && existingLink.createdAt ? existingLink.createdAt : now,
            updatedAt: now
          }
        });

        await transaction.collection('users').doc(applicant.userId).update({
          data: {
            roles: mergeCoachRole(applicant.user),
            updatedAt: now
          }
        });

        const coachProfile = Object.assign({}, existingCoach || {}, {
          _id: applicant.userId,
          _openid: application.coachOpenid,
          nickname: application.coachNickname || (existingCoach && existingCoach.nickname) || '',
          avatar: application.coachAvatar || (existingCoach && existingCoach.avatar) || '',
          intro: application.intro || (existingCoach && existingCoach.intro) || '',
          hallId: store._id,
          hallName: store.name || '',
          bindingStatus: 'approved',
          updatedAt: now
        });
        if (!coachProfile.createdAt) coachProfile.createdAt = now;
        await transaction.collection('coaches').doc(applicant.userId).set({ data: coachProfile });
      }

      return { ok: true, status };
    });
  } catch (error) {
    return fail('REVIEW_FAILED', '审核失败，请重试');
  }
};
