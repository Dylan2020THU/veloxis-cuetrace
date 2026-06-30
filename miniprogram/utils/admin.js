// 系统管理员白名单（客户端）：仅用于在设置页显示「店主资质审核」入口。
// 真正的鉴权以云函数 getPendingShopApplications / reviewShopApplication 的服务端白名单为准；
// 客户端这份只控制入口可见性，篡改也无法越权调用云函数。
// 部署后把管理员真实 openid 加进来；mock/devtools 演示默认放行 MOCK_OPENID。
const { MOCK_OPENID } = require('./mock');

const ADMIN_OPENIDS = [
  MOCK_OPENID,
  'ovvdY3VKYCo7_jTzdpgGbuf26-tA' // 管理员真实 openid（张总，与云函数白名单一致）
];

function isAdmin(openid) {
  return !!openid && ADMIN_OPENIDS.indexOf(openid) !== -1;
}

module.exports = { ADMIN_OPENIDS, isAdmin };
