exports.main = async () => ({
  ok: false,
  code: 'PRODUCT_RETIRED'
});

let protocolDatabase = null;

function getProtocolDatabase() {
  if (protocolDatabase) return protocolDatabase;
  const cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  protocolDatabase = cloud.database({ throwOnNotFound: false });
  return protocolDatabase;
}

const db = {
  collection(name) {
    return getProtocolDatabase().collection(name);
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
