const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const guardPath = path.join(root, 'cloudfunctions', '_shared', 'auth', 'protocol-guard.js');
const {
  AUTH_CONTROL_ID,
  guardClientRequest
} = require(guardPath);

const ERRORS = Object.freeze({
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

function validControl(overrides) {
  return Object.assign({
    _id: 'main',
    maintenance: false,
    schemaVersion: 1,
    minClientProtocol: 1
  }, overrides || {});
}

function createDb(options) {
  const settings = options || {};
  const reads = [];
  return {
    reads,
    collection(name) {
      reads.push({ operation: 'collection', name });
      assert.strictEqual(name, 'auth_control');
      return {
        doc(id) {
          reads.push({ operation: 'doc', id });
          assert.strictEqual(id, 'main');
          return {
            async get() {
              reads.push({ operation: 'get' });
              if (settings.error) throw settings.error;
              return { data: settings.control === undefined ? null : settings.control };
            }
          };
        }
      };
    }
  };
}

async function guard(options) {
  const settings = options || {};
  const db = settings.db || createDb({ control: settings.control });
  const request = {
    db,
    event: Object.prototype.hasOwnProperty.call(settings, 'event')
      ? settings.event
      : {},
    supportedSchemaVersions: Object.prototype.hasOwnProperty.call(
      settings,
      'supportedSchemaVersions'
    )
      ? settings.supportedSchemaVersions
      : [1]
  };
  return { db, result: await guardClientRequest(request) };
}

async function main() {
  assert.strictEqual(AUTH_CONTROL_ID, 'main');
  assert.strictEqual(typeof guardClientRequest, 'function');
  assert.deepStrictEqual(
    await guardClientRequest(),
    ERRORS.AUTH_INTERNAL_ERROR
  );
  assert.deepStrictEqual(
    await guardClientRequest(null),
    ERRORS.AUTH_INTERNAL_ERROR
  );

  const v1Control = validControl();
  const missingProtocol = await guard({ control: v1Control });
  assert.deepStrictEqual(missingProtocol.result, {
    ok: true,
    clientProtocol: 1,
    control: v1Control
  });
  assert.deepStrictEqual(missingProtocol.db.reads, [
    { operation: 'collection', name: 'auth_control' },
    { operation: 'doc', id: 'main' },
    { operation: 'get' }
  ]);

  const controlWithoutId = validControl();
  delete controlWithoutId._id;
  const noReturnedId = await guard({ control: controlWithoutId });
  assert.deepStrictEqual(noReturnedId.result, {
    ok: true,
    clientProtocol: 1,
    control: controlWithoutId
  });

  const explicitV1 = await guard({
    control: validControl(),
    event: { authProtocol: 1 }
  });
  assert.strictEqual(explicitV1.result.ok, true);
  assert.strictEqual(explicitV1.result.clientProtocol, 1);

  const v2Control = validControl({
    schemaVersion: 2,
    minClientProtocol: 2
  });
  const explicitV2 = await guard({
    control: v2Control,
    event: { authProtocol: 2 },
    supportedSchemaVersions: [2]
  });
  assert.deepStrictEqual(explicitV2.result, {
    ok: true,
    clientProtocol: 2,
    control: v2Control
  });

  const maintenance = await guard({
    control: validControl({ maintenance: true }),
    event: { authProtocol: 999 },
    supportedSchemaVersions: []
  });
  assert.deepStrictEqual(maintenance.result, ERRORS.AUTH_MAINTENANCE);

  const missingBelowMinimum = await guard({
    control: validControl({ schemaVersion: 2, minClientProtocol: 2 }),
    supportedSchemaVersions: [2]
  });
  assert.deepStrictEqual(missingBelowMinimum.result, ERRORS.CLIENT_UPDATE_REQUIRED);

  const presentUndefinedIsNotMissing = await guard({
    control: validControl(),
    event: { authProtocol: undefined }
  });
  assert.deepStrictEqual(
    presentUndefinedIsNotMissing.result,
    ERRORS.CLIENT_UPDATE_REQUIRED
  );

  for (const event of [null, [], 'request']) {
    const invalidEvent = await guard({
      control: validControl(),
      event
    });
    assert.deepStrictEqual(
      invalidEvent.result,
      ERRORS.CLIENT_UPDATE_REQUIRED,
      `invalid event projection changed for ${JSON.stringify(event)}`
    );
  }

  for (const authProtocol of [0, -1, 1.5, '1', null, {}, []]) {
    const invalidProtocol = await guard({
      control: validControl(),
      event: { authProtocol }
    });
    assert.deepStrictEqual(
      invalidProtocol.result,
      ERRORS.CLIENT_UPDATE_REQUIRED,
      `invalid authProtocol projection changed for ${JSON.stringify(authProtocol)}`
    );
  }

  const higherClaimAgainstV1 = await guard({
    control: validControl(),
    event: { authProtocol: 2 },
    supportedSchemaVersions: [1, 2]
  });
  assert.deepStrictEqual(higherClaimAgainstV1.result, ERRORS.CLIENT_UPDATE_REQUIRED);

  const lowerClaimAgainstV2 = await guard({
    control: validControl({ schemaVersion: 2, minClientProtocol: 1 }),
    event: { authProtocol: 1 },
    supportedSchemaVersions: [1, 2]
  });
  assert.deepStrictEqual(lowerClaimAgainstV2.result, ERRORS.CLIENT_UPDATE_REQUIRED);

  const unsupportedSchema = await guard({
    control: validControl({ schemaVersion: 2, minClientProtocol: 1 }),
    event: { authProtocol: 2 },
    supportedSchemaVersions: [1]
  });
  assert.deepStrictEqual(unsupportedSchema.result, ERRORS.CLIENT_UPDATE_REQUIRED);

  const malformedControls = [
    null,
    [],
    validControl({ _id: 'other' }),
    validControl({ maintenance: 'false' }),
    validControl({ schemaVersion: 0 }),
    validControl({ schemaVersion: 1.5 }),
    validControl({ schemaVersion: '1' }),
    validControl({ minClientProtocol: 0 }),
    validControl({ minClientProtocol: 2 }),
    (() => {
      const control = validControl();
      delete control.maintenance;
      return control;
    })(),
    (() => {
      const control = validControl();
      delete control.schemaVersion;
      return control;
    })(),
    (() => {
      const control = validControl();
      delete control.minClientProtocol;
      return control;
    })()
  ];
  for (const control of malformedControls) {
    const malformed = await guard({ control });
    assert.deepStrictEqual(
      malformed.result,
      ERRORS.AUTH_INTERNAL_ERROR,
      `malformed auth_control projection changed for ${JSON.stringify(control)}`
    );
  }

  for (const supportedSchemaVersions of [null, {}, [], [0], [1.5], ['1']]) {
    const invalidSupported = await guard({
      control: validControl(),
      event: { authProtocol: 1 },
      supportedSchemaVersions
    });
    assert.deepStrictEqual(
      invalidSupported.result,
      ERRORS.AUTH_INTERNAL_ERROR,
      `invalid supportedSchemaVersions projection changed for ${JSON.stringify(
        supportedSchemaVersions
      )}`
    );
  }

  const failedDb = createDb({ error: new Error('database unavailable') });
  const databaseFailure = await guard({
    db: failedDb,
    event: { authProtocol: 1 }
  });
  assert.deepStrictEqual(databaseFailure.result, ERRORS.AUTH_INTERNAL_ERROR);

  console.log('AUTH_PROTOCOL_GUARD_OK');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
