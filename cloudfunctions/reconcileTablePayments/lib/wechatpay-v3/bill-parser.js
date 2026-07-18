'use strict';

const crypto = require('crypto');
const { TextDecoder } = require('util');

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function yuanToFen(value) {
  if (typeof value !== 'string' || !/^[+-]?[0-9]+(?:\.[0-9]{1,2})?$/.test(value)) {
    throw new TypeError('value must be signed decimal yuan text');
  }

  let sign = 1n;
  let unsigned = value;
  if (unsigned[0] === '-' || unsigned[0] === '+') {
    sign = unsigned[0] === '-' ? -1n : 1n;
    unsigned = unsigned.slice(1);
  }
  const [yuan, fraction = ''] = unsigned.split('.');
  const absoluteFen = BigInt(yuan) * 100n
    + BigInt(fraction.padEnd(2, '0') || '0');
  if (absoluteFen > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('decimal yuan exceeds the safe integer fen range');
  }
  if (absoluteFen === 0n) return 0;
  return Number(absoluteFen * sign);
}

function asRawBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError('bill content must be raw bytes');
}

function invalidBillHash(ErrorType, message) {
  const error = new ErrorType(message);
  error.code = 'BILL_HASH_INVALID';
  return error;
}

function verifyBillHash(rawBytes, hashType, hashValue) {
  const bytes = asRawBytes(rawBytes);
  if (hashType !== 'SHA1') {
    throw invalidBillHash(TypeError, 'bill hash_type must be exactly SHA1');
  }
  if (typeof hashValue !== 'string' || !/^[0-9A-Fa-f]{40}$/.test(hashValue)) {
    throw invalidBillHash(
      TypeError,
      'bill hash_value must be a 40-character hexadecimal SHA1 digest'
    );
  }

  const expected = Buffer.from(hashValue, 'hex');
  const actual = crypto.createHash('sha1').update(bytes).digest();
  if (!crypto.timingSafeEqual(actual, expected)) {
    throw invalidBillHash(Error, 'bill hash mismatch');
  }
  return true;
}

function decodeBillText(rawBytes) {
  const bytes = asRawBytes(rawBytes);
  let text;
  try {
    text = utf8Decoder.decode(bytes);
  } catch (_error) {
    throw new TypeError('bill content must be valid UTF-8');
  }
  if (text.length === 0) throw new TypeError('bill content is empty');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) {
    throw new TypeError('bill content contains unsafe control characters');
  }
  return text;
}

function parseCsvRecords(text) {
  const records = [];
  let record = [];
  let quotedFields = [];
  let field = '';
  let fieldWasQuoted = false;
  let inQuotes = false;
  let quoteClosed = false;
  let endedWithLineBreak = false;

  function endField() {
    record.push(field);
    quotedFields.push(fieldWasQuoted);
    field = '';
    fieldWasQuoted = false;
    quoteClosed = false;
  }

  function endRecord() {
    endField();
    Object.defineProperty(record, 'quotedFields', {
      value: quotedFields,
      enumerable: false
    });
    records.push(record);
    record = [];
    quotedFields = [];
    endedWithLineBreak = true;
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      endedWithLineBreak = false;
      continue;
    }

    if (quoteClosed && character !== ',' && character !== '\r' && character !== '\n') {
      throw new TypeError('bill CSV has malformed quote placement');
    }
    if (character === '"') {
      if (field.length !== 0) {
        throw new TypeError('bill CSV has malformed quote placement');
      }
      inQuotes = true;
      fieldWasQuoted = true;
      endedWithLineBreak = false;
    } else if (character === ',') {
      endField();
      endedWithLineBreak = false;
    } else if (character === '\r') {
      if (text[index + 1] !== '\n') {
        throw new TypeError('bill CSV must use LF or CRLF line endings');
      }
      endRecord();
      index += 1;
    } else if (character === '\n') {
      endRecord();
    } else {
      field += character;
      endedWithLineBreak = false;
    }
  }

  if (inQuotes) throw new TypeError('bill CSV has an unterminated quote');
  if (!endedWithLineBreak || record.length !== 0 || field.length !== 0) {
    endRecord();
  }
  return records;
}

function assertSafeCell(value, label) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(value)) {
    throw new TypeError(`${label} contains unsafe control characters`);
  }
}

function validateHeaders(headers, label) {
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new TypeError(`${label} headers are missing`);
  }
  const seen = new Set();
  for (const header of headers) {
    assertSafeCell(header, label);
    if (
      header.length === 0
      || header.startsWith('`')
      || ['__proto__', 'prototype', 'constructor'].includes(header)
    ) {
      throw new TypeError(`${label} header is invalid`);
    }
    if (seen.has(header)) {
      throw new Error(`duplicate header in ${label}`);
    }
    seen.add(header);
  }
  return seen;
}

function stripOfficialRow(record, headers, label) {
  if (record.length !== headers.length) {
    throw new Error(`${label} has an inconsistent column count`);
  }
  const result = {};
  for (let index = 0; index < headers.length; index += 1) {
    const rawValue = record[index];
    assertSafeCell(rawValue, label);
    if (!rawValue.startsWith('`')) {
      throw new TypeError(`${label} field must have the official backtick prefix`);
    }
    const value = rawValue.slice(1);
    assertSafeCell(value, label);
    Object.defineProperty(result, headers[index], {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return result;
}

function validateRequiredHeaders(requiredHeaders, actualHeaders) {
  if (!Array.isArray(requiredHeaders) || requiredHeaders.length === 0) {
    throw new TypeError('requiredHeaders must be a non-empty array');
  }
  const requested = new Set();
  for (const header of requiredHeaders) {
    if (typeof header !== 'string' || header.length === 0 || requested.has(header)) {
      throw new TypeError('requiredHeaders contains an invalid or duplicate header');
    }
    requested.add(header);
    if (!actualHeaders.has(header)) {
      throw new Error(`required header is missing: ${header}`);
    }
  }
}

function configuredAmountHeaders(options, name, actualHeaders, label) {
  const values = options && options[name] !== undefined ? options[name] : [];
  if (!Array.isArray(values)) {
    throw new TypeError(`${name} must be an array`);
  }
  const result = new Set();
  for (const header of values) {
    if (typeof header !== 'string' || header.length === 0 || result.has(header)) {
      throw new TypeError(`${name} contains an invalid or duplicate header`);
    }
    if (!actualHeaders.has(header)) {
      throw new Error(`${label} amount header is missing: ${header}`);
    }
    result.add(header);
  }
  return result;
}

function convertAmountColumns(record, amountHeaders) {
  for (const header of amountHeaders) record[header] = yuanToFen(record[header]);
  return record;
}

function isBlankRecord(record) {
  return record.length === 1
    && record[0] === ''
    && Array.isArray(record.quotedFields)
    && record.quotedFields[0] === false;
}

function parseBillCsv(rawBytes, options) {
  const records = parseCsvRecords(decodeBillText(rawBytes));
  const blankIndexes = [];
  records.forEach((record, index) => {
    if (isBlankRecord(record)) blankIndexes.push(index);
  });
  if (blankIndexes.length !== 1) {
    throw new Error('bill CSV must contain exactly one summary separator');
  }

  const summaryIndex = blankIndexes[0];
  const mainRecords = records.slice(0, summaryIndex);
  const summaryRecords = records.slice(summaryIndex + 1);
  if (mainRecords.length < 1 || summaryRecords.length !== 2) {
    throw new Error('bill CSV must contain exactly one official summary row');
  }

  const headers = mainRecords[0];
  const actualHeaders = validateHeaders(headers, 'bill');
  validateRequiredHeaders(options && options.requiredHeaders, actualHeaders);
  const amountHeaders = configuredAmountHeaders(
    options,
    'amountHeaders',
    actualHeaders,
    'bill'
  );
  const rows = mainRecords.slice(1).map((record) => (
    convertAmountColumns(
      stripOfficialRow(record, headers, 'bill row'),
      amountHeaders
    )
  ));

  const summaryHeaders = summaryRecords[0];
  const actualSummaryHeaders = validateHeaders(summaryHeaders, 'bill summary');
  const summaryAmountHeaders = configuredAmountHeaders(
    options,
    'summaryAmountHeaders',
    actualSummaryHeaders,
    'bill summary'
  );
  const summary = convertAmountColumns(
    stripOfficialRow(
      summaryRecords[1],
      summaryHeaders,
      'bill summary row'
    ),
    summaryAmountHeaders
  );

  return { headers: [...headers], rows, summary };
}

function parseVerifiedBill(rawBytes, hashMetadata, options) {
  if (!hashMetadata || typeof hashMetadata !== 'object') {
    throw new TypeError('bill hash metadata is required');
  }
  verifyBillHash(rawBytes, hashMetadata.hash_type, hashMetadata.hash_value);
  return parseBillCsv(rawBytes, options);
}

module.exports = {
  yuanToFen,
  verifyBillHash,
  parseBillCsv,
  parseVerifiedBill
};
