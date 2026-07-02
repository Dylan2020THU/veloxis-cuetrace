const { MOCK_OPENID } = require('./mock');
const auth = require('./adminAuth');

const ADMIN_OPENIDS = [
  MOCK_OPENID,
  ...auth.BOOTSTRAP_ADMIN_OPENIDS
];

function isAdmin(openid) {
  return !!openid && ADMIN_OPENIDS.indexOf(openid) !== -1;
}

module.exports = { ADMIN_OPENIDS, isAdmin };
