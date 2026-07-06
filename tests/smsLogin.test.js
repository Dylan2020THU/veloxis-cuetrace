const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

assert(exists('cloudfunctions/sendSmsCode/index.js'), 'sendSmsCode cloud function should exist.');
assert(exists('cloudfunctions/sendSmsCode/package.json'), 'sendSmsCode package.json should exist.');
assert(exists('cloudfunctions/verifySmsCode/index.js'), 'verifySmsCode cloud function should exist.');
assert(exists('cloudfunctions/verifySmsCode/package.json'), 'verifySmsCode package.json should exist.');

const sendSmsCode = read('cloudfunctions/sendSmsCode/index.js');
assert(sendSmsCode.includes('CUETRACE_SMS_SECRET_ID'), 'sendSmsCode should read Tencent Cloud secret id from env.');
assert(sendSmsCode.includes('CUETRACE_SMS_SECRET_KEY'), 'sendSmsCode should read Tencent Cloud secret key from env.');
assert(sendSmsCode.includes('CUETRACE_SMS_SDK_APP_ID'), 'sendSmsCode should read Tencent SMS app id from env.');
assert(sendSmsCode.includes('CUETRACE_SMS_SIGN_NAME'), 'sendSmsCode should read Tencent SMS sign name from env.');
assert(sendSmsCode.includes('CUETRACE_SMS_TEMPLATE_ID'), 'sendSmsCode should read Tencent SMS template id from env.');
assert(!sendSmsCode.includes('TENCENTCLOUD_'), 'sendSmsCode should not use Tencent Cloud reserved env prefixes.');
assert(sendSmsCode.includes('CONFIG_MISSING'), 'sendSmsCode should fail clearly when SMS is not configured.');
assert(sendSmsCode.includes('sms_codes'), 'sendSmsCode should persist generated codes in sms_codes.');
assert(sendSmsCode.includes('crypto.createHash'), 'sendSmsCode should store a hashed code, not plaintext.');
assert(!sendSmsCode.includes('123456'), 'sendSmsCode should not hardcode demo verification codes.');
assert(!sendSmsCode.includes('.orderBy('), 'sendSmsCode should not require a database index for resend checks.');

const verifySmsCode = read('cloudfunctions/verifySmsCode/index.js');
assert(!verifySmsCode.includes('TENCENTCLOUD_'), 'verifySmsCode should not use Tencent Cloud reserved env prefixes.');
assert(verifySmsCode.includes('sms_codes'), 'verifySmsCode should read sms_codes.');
assert(verifySmsCode.includes('expiresAt'), 'verifySmsCode should reject expired codes.');
assert(verifySmsCode.includes('used'), 'verifySmsCode should mark successful codes as used.');
assert(verifySmsCode.includes('INVALID_CODE'), 'verifySmsCode should report invalid codes clearly.');
assert(!verifySmsCode.includes('.orderBy('), 'verifySmsCode should not require a database index for code checks.');
assert(verifySmsCode.includes("db.collection('users')"), 'verifySmsCode should bind the verified phone to the current user.');
assert(verifySmsCode.includes('phoneVerifiedAt'), 'verifySmsCode should record when the phone was verified.');

const dataJs = read('miniprogram/services/data.js');
assert(dataJs.includes('function sendSmsCode'), 'data.js should expose sendSmsCode().');
assert(dataJs.includes("callCloud('sendSmsCode'"), 'sendSmsCode() should call the sendSmsCode cloud function.');
assert(dataJs.includes('function verifySmsCode'), 'data.js should expose verifySmsCode().');
assert(dataJs.includes("callCloud('verifySmsCode'"), 'verifySmsCode() should call the verifySmsCode cloud function.');
assert(/module\.exports\s*=\s*\{[\s\S]*sendSmsCode[\s\S]*verifySmsCode/.test(dataJs), 'data.js should export SMS helpers.');

const loginJs = read('miniprogram/pages/login/index.js');
assert(/data\s*\.\s*sendSmsCode\(phone\)/.test(loginJs), 'Login page should call data.sendSmsCode().');
assert(
  loginJs.search(/data\s*\.\s*sendSmsCode\(phone\)/) < loginJs.indexOf('this.startCodeCountdown()'),
  'Login page should call data.sendSmsCode() before starting the countdown.'
);
assert(/data\s*\.\s*verifySmsCode/.test(loginJs), 'SMS login should call data.verifySmsCode().');
assert(
  /data\s*\.\s*verifySmsCode\([\s\S]*?\.then\(\(\)\s*=>\s*\{[\s\S]*?this\.doLogin\(role,\s*phone\)/.test(loginJs),
  'SMS login should call doLogin() only after verifySmsCode() succeeds.'
);
assert(!/验证码已发送[\s\S]{0,120}setInterval/.test(loginJs), 'Login page should not show success and start countdown before cloud send succeeds.');
