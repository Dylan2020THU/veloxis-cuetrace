const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const postJs = fs.readFileSync(path.join(root, 'miniprogram/pages/match/post.js'), 'utf8');
const mockJs = fs.readFileSync(path.join(root, 'miniprogram/utils/mock.js'), 'utf8');

const expected = [
  '中式八球（Chinese 8-Ball）',
  '中式九球（Chinese 9-Ball）',
  '斯诺克（Snooker）',
  '美式八球（8-Ball）',
  '美式九球（9-Ball）',
  '美式十球（10-Ball）',
  '不限（Open）'
];

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

const match = postJs.match(/const GAME_TYPES = \[(.*?)\];/s);
assert(match, 'GAME_TYPES should be declared in match post page.');

const actual = Array.from(match[1].matchAll(/'([^']+)'/g)).map((item) => item[1]);
assert(
  JSON.stringify(actual) === JSON.stringify(expected),
  `GAME_TYPES should match the required list.\nExpected: ${expected.join(' / ')}\nActual: ${actual.join(' / ')}`
);

const matchesSeed = mockJs.match(/function generateMatches\(\) \{[\s\S]*?function generateBookings\(\)/);
assert(matchesSeed, 'generateMatches seed block should exist.');

['美式十六球', '九球', '不限'].forEach((legacy) => {
  assert(!matchesSeed[0].includes(`gameType: '${legacy}'`), `Match seed data should not use legacy game type: ${legacy}`);
});

console.log('match game types ok');
