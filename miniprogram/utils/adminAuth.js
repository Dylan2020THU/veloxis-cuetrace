// 客户端只保留公开账号名用于路由，不参与管理员授权。
const ADMIN_ACCOUNT = 'admin_zhx';
const ADMIN_ACCOUNTS = [{ account: ADMIN_ACCOUNT }];
const BOOTSTRAP_ADMIN_OPENIDS = [];

function isAdminAccount(account) {
  return ADMIN_ACCOUNTS.some((item) => item.account === account);
}

module.exports = {
  ADMIN_ACCOUNT,
  BOOTSTRAP_ADMIN_OPENIDS,
  ADMIN_ACCOUNTS,
  isAdminAccount
};
