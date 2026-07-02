const assert = require('assert');
const fs = require('fs');
const path = require('path');

const wxss = fs.readFileSync(
  path.resolve(__dirname, '../miniprogram/pages/match/index.wxss'),
  'utf8'
);

function readRule(selector, required = true) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = wxss.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  if (!required && !match) return '';
  assert(match, `Missing CSS rule: ${selector}`);
  return match[1];
}

const matchCardRule = readRule('.card.match', false);
const joinButtonRule = readRule('.join-btn');

assert(
  !/position\s*:\s*absolute\s*;/.test(joinButtonRule),
  'The match card CTA must stay in normal flow so it cannot cover card content.'
);

assert(
  /margin-top\s*:\s*(2[0-9]|[3-9][0-9])rpx\s*;/.test(joinButtonRule),
  'The match card CTA needs at least 20rpx spacing from the content above.'
);

assert(
  !/padding-bottom\s*:\s*88rpx\s*;/.test(matchCardRule),
  'The match card should not rely on fixed bottom padding to reserve space for an absolute CTA.'
);
