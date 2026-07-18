// 账号编码 & 二维码 payload 工具（纯函数，无小程序 API 依赖，便于跨端复用与单测）。
//
// 设计：账号底层标识仍是 openid（与 data.js / mock.js 一致）。
// "账号编码" 是由 openid 确定性派生的对人友好短码（形如 CT-9F3AQK），
// 用于「我的」展示、手动输入添加、以及二维码内容。
// 二维码内容是一段紧凑 JSON payload，含 role/openid/code/name，扫码端据此识别对方账号。

var PREFIX = 'CT';
// Crockford Base32：去掉易混淆字符 I L O U，便于人工抄写
var ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
var SCHEME = 'cuetrace';

// FNV-1a 32-bit 哈希（纯整数运算，结果稳定，跨端一致）
function fnv1a(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (0x01000193 = 2^24 + 2^8 + 2^7 + 2^4 + 2^1 + 2^0) mod 2^32
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// 由 openid 生成 6 位 base32 短码，前缀 CT-（共 9 字符）。
// 取两个不同种子的哈希拼出 30bit 熵，碰撞概率对演示规模可忽略。
function codeOf(openid) {
  if (!openid) return '';
  var h1 = fnv1a(String(openid));
  var h2 = fnv1a(SCHEME + ':' + openid);
  var n = h1;
  var s = '';
  for (var i = 0; i < 6; i++) {
    if (i === 3) n = h2; // 后三位改用第二个哈希
    s += ALPHABET.charAt(n & 31);
    n = n >>> 5;
  }
  return PREFIX + '-' + s;
}

// 规范化用户输入的编码：大写、去空格、补全 CT- 前缀（允许用户只输 6 位本体）
function normalizeCode(input) {
  if (!input) return '';
  var s = ('' + input).trim().toUpperCase().replace(/\s+/g, '');
  if (/^[0-9A-Z]{6}$/.test(s)) return PREFIX + '-' + s; // 只输了 6 位本体
  return s;
}

// 生成二维码内容（紧凑 JSON）。acc: { role, openid, code?, name? }
function buildPayload(acc) {
  acc = acc || {};
  return JSON.stringify({
    a: SCHEME,
    t: 'acct',
    v: 1,
    r: acc.role || '',
    o: acc.openid || '',
    c: acc.code || codeOf(acc.openid),
    n: acc.name || ''
  });
}

// 解析扫码 / 手输结果，统一为 { openid, role, code, name, raw, source }。
// - 我方二维码 JSON：openid/role/name 直出，source='qr'
// - 纯文本（手输编码或原始 openid）：openid 留空、raw 保留，由 data.resolveAccount 落地，source='text'
// - 非本应用内容：返回 null
function parse(raw) {
  if (raw == null) return null;
  var s = ('' + raw).trim();
  if (!s) return null;
  if (s.charAt(0) === '{') {
    try {
      var o = JSON.parse(s);
      if (o && o.a === SCHEME && o.t === 'acct' && o.o) {
        return {
          openid: o.o,
          role: o.r || '',
          code: o.c || codeOf(o.o),
          name: o.n || '',
          raw: s,
          source: 'qr'
        };
      }
    } catch (e) {}
    return null; // 是 JSON 但不是本应用账号码
  }
  // 纯文本：可能是编码（CT-XXXXXX / 6 位本体）或直接的 openid
  return {
    openid: '',
    role: '',
    code: normalizeCode(s),
    name: '',
    raw: s,
    source: 'text'
  };
}

module.exports = {
  PREFIX: PREFIX,
  SCHEME: SCHEME,
  codeOf: codeOf,
  normalizeCode: normalizeCode,
  buildPayload: buildPayload,
  parse: parse,
  _fnv1a: fnv1a
};
