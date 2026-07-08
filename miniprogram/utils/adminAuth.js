// 管理员权限规则：优先使用 admins 集合；集合未初始化时允许首位兜底管理员进入。
const BOOTSTRAP_ADMIN_OPENIDS = [
  'ovvdY3VKYCo7_jTzdpgGbuf26-tA'
];

const ADMIN_ACCOUNTS = [
  { account: 'admin_zhx', password: '2612694' }
];

function isAdminAccount(account) {
  return ADMIN_ACCOUNTS.some((item) => item.account === account);
}

function isActiveAdmin(openid, admins) {
  if (!openid || !Array.isArray(admins)) return false;
  return admins.some((item) => item && item._openid === openid && item.status === 'active');
}

function hasActiveAdmins(admins) {
  return Array.isArray(admins) && admins.some((item) => item && item.status === 'active');
}

function shouldBootstrapAdmin(openid, admins, bootstrapOpenids) {
  const seeds = Array.isArray(bootstrapOpenids) ? bootstrapOpenids : BOOTSTRAP_ADMIN_OPENIDS;
  return !!openid && !hasActiveAdmins(admins) && seeds.indexOf(openid) !== -1;
}

function canAdmin(openid, admins, bootstrapOpenids) {
  return isActiveAdmin(openid, admins) || shouldBootstrapAdmin(openid, admins, bootstrapOpenids);
}

module.exports = {
  BOOTSTRAP_ADMIN_OPENIDS,
  ADMIN_ACCOUNTS,
  isAdminAccount,
  isActiveAdmin,
  hasActiveAdmins,
  shouldBootstrapAdmin,
  canAdmin
};
