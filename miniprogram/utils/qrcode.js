// 轻量 QR 码生成器（字节模式 / UTF-8 / 纠错等级 M / 自动版本）。
// 基于 Kazuhiko Arase 的 qrcode-generator 算法移植，纯 JS、无依赖，供小程序 canvas 绘制使用。
// 用法：var qr = qrcode(typeNumber=0自动, 'M'); qr.addData(str); qr.make();
//       qr.getModuleCount(); qr.isDark(row, col);

function QRMath() {}
(function () {
  var EXP = new Array(256);
  var LOG = new Array(256);
  for (var i = 0; i < 8; i++) EXP[i] = 1 << i;
  for (i = 8; i < 256; i++) EXP[i] = EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8];
  for (i = 0; i < 255; i++) LOG[EXP[i]] = i;
  QRMath.glog = function (n) { if (n < 1) throw new Error('glog(' + n + ')'); return LOG[n]; };
  QRMath.gexp = function (n) { while (n < 0) n += 255; while (n >= 256) n -= 255; return EXP[n]; };
})();

function QRPolynomial(num, shift) {
  var offset = 0;
  while (offset < num.length && num[offset] === 0) offset++;
  this.num = new Array(num.length - offset + shift);
  for (var i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
}
QRPolynomial.prototype = {
  get: function (i) { return this.num[i]; },
  getLength: function () { return this.num.length; },
  multiply: function (e) {
    var num = new Array(this.getLength() + e.getLength() - 1);
    for (var i = 0; i < num.length; i++) num[i] = 0;
    for (i = 0; i < this.getLength(); i++)
      for (var j = 0; j < e.getLength(); j++)
        num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)));
    return new QRPolynomial(num, 0);
  },
  mod: function (e) {
    if (this.getLength() - e.getLength() < 0) return this;
    var ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0));
    var num = this.num.slice();
    for (var i = 0; i < e.getLength(); i++) num[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio);
    return new QRPolynomial(num, 0).mod(e);
  }
};

var QRRSBlock = {
  // [totalCount, dataCount] per RS block for EC level M, versions 1..10 (足够编码短 URL)
  table: {
    1: [[1, 26, 16]],
    2: [[1, 44, 28]],
    3: [[1, 70, 44]],
    4: [[2, 50, 32]],
    5: [[2, 67, 43]],
    6: [[4, 43, 27]],
    7: [[4, 49, 31]],
    8: [[2, 60, 38], [2, 61, 39]],
    9: [[3, 58, 36], [2, 59, 37]],
    10: [[4, 69, 43], [1, 70, 44]]
  },
  getRSBlocks: function (typeNumber) {
    var list = QRRSBlock.table[typeNumber];
    var blocks = [];
    for (var i = 0; i < list.length; i++) {
      var count = list[i][0], total = list[i][1], data = list[i][2];
      for (var j = 0; j < count; j++) blocks.push({ totalCount: total, dataCount: data });
    }
    return blocks;
  }
};

function QRBitBuffer() { this.buffer = []; this.length = 0; }
QRBitBuffer.prototype = {
  get: function (i) { return ((this.buffer[Math.floor(i / 8)] >>> (7 - i % 8)) & 1) === 1; },
  put: function (num, length) { for (var i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) === 1); },
  putBit: function (bit) {
    var idx = Math.floor(this.length / 8);
    if (this.buffer.length <= idx) this.buffer.push(0);
    if (bit) this.buffer[idx] |= (0x80 >>> (this.length % 8));
    this.length++;
  }
};

// UTF-8 编码为字节数组
function toUtf8Bytes(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c < 0xd800 || c >= 0xe000) { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    else {
      i++;
      var cp = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return bytes;
}

function qrcode(typeNumber, errorCorrectLevel) {
  var _typeNumber = typeNumber || 0;
  var _modules = null;
  var _moduleCount = 0;
  var _dataList = [];
  var PAD0 = 0xEC, PAD1 = 0x11;

  function getBCHTypeInfo(data) {
    var d = data << 10;
    while (bchDigit(d) - bchDigit(0x537) >= 0) d ^= (0x537 << (bchDigit(d) - bchDigit(0x537)));
    return ((data << 10) | d) ^ 0x5412;
  }
  function getBCHTypeNumber(data) {
    var d = data << 12;
    while (bchDigit(d) - bchDigit(0x1f25) >= 0) d ^= (0x1f25 << (bchDigit(d) - bchDigit(0x1f25)));
    return (data << 12) | d;
  }
  function bchDigit(data) { var digit = 0; while (data !== 0) { digit++; data >>>= 1; } return digit; }

  function setupPositionProbePattern(row, col) {
    for (var r = -1; r <= 7; r++) {
      if (row + r <= -1 || _moduleCount <= row + r) continue;
      for (var c = -1; c <= 7; c++) {
        if (col + c <= -1 || _moduleCount <= col + c) continue;
        _modules[row + r][col + c] =
          (0 <= r && r <= 6 && (c === 0 || c === 6)) ||
          (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
          (2 <= r && r <= 4 && 2 <= c && c <= 4);
      }
    }
  }
  function setupTimingPattern() {
    for (var r = 8; r < _moduleCount - 8; r++) { if (_modules[r][6] != null) continue; _modules[r][6] = (r % 2 === 0); }
    for (var c = 8; c < _moduleCount - 8; c++) { if (_modules[6][c] != null) continue; _modules[6][c] = (c % 2 === 0); }
  }
  var PATTERN_POSITION = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };
  function setupPositionAdjustPattern() {
    var pos = PATTERN_POSITION[_typeNumber];
    for (var i = 0; i < pos.length; i++) for (var j = 0; j < pos.length; j++) {
      var row = pos[i], col = pos[j];
      if (_modules[row][col] != null) continue;
      for (var r = -2; r <= 2; r++) for (var c = -2; c <= 2; c++)
        _modules[row + r][col + c] = (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0));
    }
  }
  function setupTypeNumber(test) {
    var bits = getBCHTypeNumber(_typeNumber);
    for (var i = 0; i < 18; i++) {
      var mod = (!test && ((bits >> i) & 1) === 1);
      _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
    }
    for (i = 0; i < 18; i++) {
      mod = (!test && ((bits >> i) & 1) === 1);
      _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
    }
  }
  function setupTypeInfo(test, maskPattern) {
    var data = (1 << 3) | maskPattern; // EC level M = 0b00 -> but Arase uses (ECLevel<<3); M=0 here mapping
    var bits = getBCHTypeInfo(data);
    for (var i = 0; i < 15; i++) {
      var mod = (!test && ((bits >> i) & 1) === 1);
      if (i < 6) _modules[i][8] = mod;
      else if (i < 8) _modules[i + 1][8] = mod;
      else _modules[_moduleCount - 15 + i][8] = mod;
    }
    for (i = 0; i < 15; i++) {
      mod = (!test && ((bits >> i) & 1) === 1);
      if (i < 8) _modules[8][_moduleCount - i - 1] = mod;
      else if (i < 9) _modules[8][15 - i - 1 + 1] = mod;
      else _modules[8][15 - i - 1] = mod;
    }
    _modules[_moduleCount - 8][8] = !test;
  }
  function mapData(data, maskPattern) {
    var inc = -1, row = _moduleCount - 1, bitIndex = 7, byteIndex = 0;
    for (var col = _moduleCount - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      while (true) {
        for (var c = 0; c < 2; c++) {
          if (_modules[row][col - c] == null) {
            var dark = false;
            if (byteIndex < data.length) dark = (((data[byteIndex] >>> bitIndex) & 1) === 1);
            var mask = getMask(maskPattern, row, col - c);
            if (mask) dark = !dark;
            _modules[row][col - c] = dark;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || _moduleCount <= row) { row -= inc; inc = -inc; break; }
      }
    }
  }
  function getMask(p, i, j) {
    switch (p) {
      case 0: return (i + j) % 2 === 0;
      case 1: return i % 2 === 0;
      case 2: return j % 3 === 0;
      case 3: return (i + j) % 3 === 0;
      case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
      case 5: return (i * j) % 2 + (i * j) % 3 === 0;
      case 6: return ((i * j) % 2 + (i * j) % 3) % 2 === 0;
      case 7: return ((i * j) % 3 + (i + j) % 2) % 2 === 0;
    }
    return false;
  }
  function getErrorCorrectPolynomial(ecLength) {
    var a = new QRPolynomial([1], 0);
    for (var i = 0; i < ecLength; i++) a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0));
    return a;
  }
  function createData(buffer) {
    var rsBlocks = QRRSBlock.getRSBlocks(_typeNumber);
    // data bytes
    var totalDataCount = 0;
    for (var i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
    if (buffer.length > totalDataCount * 8) throw new Error('code length overflow');
    if (buffer.length + 4 <= totalDataCount * 8) buffer.put(0, 4);
    while (buffer.length % 8 !== 0) buffer.putBit(false);
    while (true) {
      if (buffer.length >= totalDataCount * 8) break;
      buffer.put(PAD0, 8);
      if (buffer.length >= totalDataCount * 8) break;
      buffer.put(PAD1, 8);
    }
    return createBytes(buffer, rsBlocks);
  }
  function createBytes(buffer, rsBlocks) {
    var offset = 0, maxDc = 0, maxEc = 0;
    var dcdata = [], ecdata = [];
    for (var r = 0; r < rsBlocks.length; r++) {
      var dcCount = rsBlocks[r].dataCount;
      var ecCount = rsBlocks[r].totalCount - dcCount;
      maxDc = Math.max(maxDc, dcCount);
      maxEc = Math.max(maxEc, ecCount);
      dcdata[r] = new Array(dcCount);
      for (var i = 0; i < dcCount; i++) dcdata[r][i] = 0xff & buffer.buffer[i + offset];
      offset += dcCount;
      var rsPoly = getErrorCorrectPolynomial(ecCount);
      var rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1);
      var modPoly = rawPoly.mod(rsPoly);
      ecdata[r] = new Array(rsPoly.getLength() - 1);
      for (i = 0; i < ecdata[r].length; i++) {
        var modIndex = i + modPoly.getLength() - ecdata[r].length;
        ecdata[r][i] = (modIndex >= 0) ? modPoly.get(modIndex) : 0;
      }
    }
    var totalCodeCount = 0;
    for (i = 0; i < rsBlocks.length; i++) totalCodeCount += rsBlocks[i].totalCount;
    var data = new Array(totalCodeCount);
    var index = 0;
    for (i = 0; i < maxDc; i++) for (r = 0; r < rsBlocks.length; r++) if (i < dcdata[r].length) data[index++] = dcdata[r][i];
    for (i = 0; i < maxEc; i++) for (r = 0; r < rsBlocks.length; r++) if (i < ecdata[r].length) data[index++] = ecdata[r][i];
    return data;
  }

  function makeImpl(test, maskPattern, dataBytes) {
    _moduleCount = _typeNumber * 4 + 17;
    _modules = [];
    for (var row = 0; row < _moduleCount; row++) { _modules[row] = new Array(_moduleCount); for (var col = 0; col < _moduleCount; col++) _modules[row][col] = null; }
    setupPositionProbePattern(0, 0);
    setupPositionProbePattern(_moduleCount - 7, 0);
    setupPositionProbePattern(0, _moduleCount - 7);
    setupPositionAdjustPattern();
    setupTimingPattern();
    setupTypeInfo(test, maskPattern);
    if (_typeNumber >= 7) setupTypeNumber(test);
    mapData(dataBytes, maskPattern);
  }

  function getLengthInBits(count) { return 8 + (_typeNumber > 9 ? 8 : 0) + count * 0; } // placeholder; computed inline below

  var _self = {
    addData: function (data) { _dataList.push(toUtf8Bytes(data)); },
    isDark: function (row, col) { return _modules[row][col]; },
    getModuleCount: function () { return _moduleCount; },
    make: function () {
      // 自动选版本：从 1 到 10 找能容纳的数据
      var bytes = _dataList[0];
      var lengthBits;
      for (var t = (_typeNumber || 1); t <= 10; t++) {
        _typeNumber = t;
        var rsBlocks = QRRSBlock.getRSBlocks(t);
        var totalDataCount = 0;
        for (var k = 0; k < rsBlocks.length; k++) totalDataCount += rsBlocks[k].dataCount;
        var charCountBits = (t <= 9) ? 8 : 16; // byte mode count indicator
        var need = 4 + charCountBits + bytes.length * 8;
        if (need <= totalDataCount * 8) break;
      }
      // 构造 bit buffer
      var buffer = new QRBitBuffer();
      buffer.put(4, 4); // byte mode
      var ccBits = (_typeNumber <= 9) ? 8 : 16;
      buffer.put(bytes.length, ccBits);
      for (var i = 0; i < bytes.length; i++) buffer.put(bytes[i], 8);
      var dataBytes = createData(buffer);
      // 选最佳 mask（最低罚分）
      var minLost = Infinity, bestPattern = 0;
      for (var p = 0; p < 8; p++) {
        makeImpl(true, p, dataBytes);
        var lost = getLostPoint();
        if (lost < minLost) { minLost = lost; bestPattern = p; }
      }
      makeImpl(false, bestPattern, dataBytes);
    }
  };

  function getLostPoint() {
    var count = _moduleCount, lost = 0, row, col;
    for (row = 0; row < count; row++) for (col = 0; col < count; col++) {
      var sameCount = 0, dark = _modules[row][col];
      for (var r = -1; r <= 1; r++) { if (row + r < 0 || count <= row + r) continue; for (var c = -1; c <= 1; c++) { if (col + c < 0 || count <= col + c) continue; if (r === 0 && c === 0) continue; if (dark === _modules[row + r][col + c]) sameCount++; } }
      if (sameCount > 5) lost += (3 + sameCount - 5);
    }
    for (row = 0; row < count - 1; row++) for (col = 0; col < count - 1; col++) { var cnt = 0; if (_modules[row][col]) cnt++; if (_modules[row + 1][col]) cnt++; if (_modules[row][col + 1]) cnt++; if (_modules[row + 1][col + 1]) cnt++; if (cnt === 0 || cnt === 4) lost += 3; }
    for (row = 0; row < count; row++) for (col = 0; col < count - 6; col++) { if (_modules[row][col] && !_modules[row][col + 1] && _modules[row][col + 2] && _modules[row][col + 3] && _modules[row][col + 4] && !_modules[row][col + 5] && _modules[row][col + 6]) lost += 40; }
    for (col = 0; col < count; col++) for (row = 0; row < count - 6; row++) { if (_modules[row][col] && !_modules[row + 1][col] && _modules[row + 2][col] && _modules[row + 3][col] && _modules[row + 4][col] && !_modules[row + 5][col] && _modules[row + 6][col]) lost += 40; }
    var darkCount = 0;
    for (col = 0; col < count; col++) for (row = 0; row < count; row++) if (_modules[row][col]) darkCount++;
    var ratio = Math.abs(100 * darkCount / count / count - 50) / 5;
    lost += ratio * 10;
    return lost;
  }

  return _self;
}

module.exports = qrcode;
