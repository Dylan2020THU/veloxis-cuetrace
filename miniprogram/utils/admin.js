// 客户端不得判定管理员；管理权限只认云函数的确定性 admins 记录。
const ADMIN_OPENIDS = [];

function isAdmin() {
  return false;
}

module.exports = { ADMIN_OPENIDS, isAdmin };
