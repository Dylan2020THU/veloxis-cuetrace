function safeDecode(value) {
  try {
    return decodeURIComponent(value || '');
  } catch (e) {
    return value || '';
  }
}

function decodeCompactHex(value) {
  if (!value) return '';
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  let bytes;
  if (typeof wx !== 'undefined' && typeof wx.base64ToArrayBuffer === 'function') {
    bytes = new Uint8Array(wx.base64ToArrayBuffer(padded));
  } else if (typeof Buffer !== 'undefined') {
    bytes = Uint8Array.from(Buffer.from(padded, 'base64'));
  } else {
    return '';
  }
  return Array.prototype.map.call(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseTableCode(options) {
  const raw = (options && (options.scene || options.q || options.payload)) || '';
  let str = raw ? safeDecode(raw) : '';
  if (!str && options) {
    return {
      storeId: safeDecode(options.storeId || options.s),
      tableId: safeDecode(options.tableId || options.t),
      tableName: safeDecode(options.tableName || options.tn)
    };
  }
  const queryIndex = str.indexOf('?');
  if (queryIndex >= 0) str = str.slice(queryIndex + 1);
  const map = {};
  str.split('&').forEach((pair) => {
    const separator = pair.indexOf('=');
    const key = separator >= 0 ? pair.slice(0, separator) : pair;
    const value = separator >= 0 ? pair.slice(separator + 1) : '';
    if (key) map[key] = safeDecode(value);
  });
  return {
    storeId: map.s || map.storeId || decodeCompactHex(map.h),
    tableId: map.t || map.tableId || '',
    tableName: map.tn || map.tableName || ''
  };
}

module.exports = { parseTableCode };
