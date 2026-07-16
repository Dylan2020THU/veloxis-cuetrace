'use strict';

const AUTH_CONTROL_ID = 'main';

const ERROR_RESULTS = Object.freeze({
  AUTH_MAINTENANCE: Object.freeze({
    ok: false,
    code: 'AUTH_MAINTENANCE',
    msg: '认证服务维护中，请稍后重试'
  }),
  CLIENT_UPDATE_REQUIRED: Object.freeze({
    ok: false,
    code: 'CLIENT_UPDATE_REQUIRED',
    msg: '客户端版本过低，请更新后重试'
  }),
  AUTH_INTERNAL_ERROR: Object.freeze({
    ok: false,
    code: 'AUTH_INTERNAL_ERROR',
    msg: '认证服务异常，请稍后重试'
  })
});

function failure(code) {
  return { ...ERROR_RESULTS[code] };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isProtocolVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function validControl(control) {
  return isPlainObject(control)
    && (
      !Object.prototype.hasOwnProperty.call(control, '_id')
      || control._id === AUTH_CONTROL_ID
    )
    && typeof control.maintenance === 'boolean'
    && isProtocolVersion(control.schemaVersion)
    && isProtocolVersion(control.minClientProtocol)
    && control.minClientProtocol <= control.schemaVersion;
}

function validSupportedSchemaVersions(versions) {
  return Array.isArray(versions)
    && versions.length > 0
    && versions.every(isProtocolVersion);
}

async function guardClientRequest(options) {
  const {
    db,
    event,
    supportedSchemaVersions
  } = isPlainObject(options) ? options : {};
  let control;
  try {
    if (!db || typeof db.collection !== 'function') {
      throw new TypeError('guard database is invalid');
    }
    const result = await db
      .collection('auth_control')
      .doc(AUTH_CONTROL_ID)
      .get();
    control = result && result.data;
  } catch (_error) {
    return failure('AUTH_INTERNAL_ERROR');
  }

  if (!validControl(control)) {
    return failure('AUTH_INTERNAL_ERROR');
  }
  if (control.maintenance) {
    return failure('AUTH_MAINTENANCE');
  }
  if (!validSupportedSchemaVersions(supportedSchemaVersions)) {
    return failure('AUTH_INTERNAL_ERROR');
  }

  const request = isPlainObject(event) ? event : null;
  if (!request) {
    return failure('CLIENT_UPDATE_REQUIRED');
  }
  const hasProtocol = request
    && Object.prototype.hasOwnProperty.call(request, 'authProtocol');
  let clientProtocol;
  if (!hasProtocol) {
    if (control.minClientProtocol > 1) {
      return failure('CLIENT_UPDATE_REQUIRED');
    }
    clientProtocol = 1;
  } else {
    clientProtocol = request.authProtocol;
  }

  if (
    !isProtocolVersion(clientProtocol)
    || clientProtocol < control.minClientProtocol
    || clientProtocol !== control.schemaVersion
    || !supportedSchemaVersions.includes(clientProtocol)
  ) {
    return failure('CLIENT_UPDATE_REQUIRED');
  }

  return {
    ok: true,
    clientProtocol,
    control
  };
}

module.exports = {
  AUTH_CONTROL_ID,
  guardClientRequest
};
