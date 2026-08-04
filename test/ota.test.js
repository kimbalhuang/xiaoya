'use strict';

/**
 * ota.test.js —— 无依赖测试（仅 node:test / node:assert / node:crypto）。
 * 验证 server/ota.js 的 hmacOf(challenge, hmacKey) 签名正确性：
 *   与独立 crypto.createHmac('sha256', hmacKey).update(challenge).digest('hex') 交叉验证。
 * 注：ota.js 仅在 register/activate 内部使用 fetch，模块顶层只依赖 crypto，可在无网络下 require。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { hmacOf } = require('../server/ota');

function expected(challenge, key) {
  return crypto.createHmac('sha256', key).update(challenge).digest('hex');
}

test('hmacOf：与独立 crypto.createHmac 计算结果一致', () => {
  const cases = [
    ['', ''],
    ['challenge-123', 'hmac-key-xyz'],
    ['aGVsbG8gd29ybGQ=', 'supersecret'],
    ['\x00\x01\x02\xff', 'key-with-bytes'],
    ['你好，小智', '中文密钥'],
  ];
  for (const [challenge, key] of cases) {
    assert.strictEqual(
      hmacOf(challenge, key),
      expected(challenge, key),
      `hmacOf 不匹配: challenge=${JSON.stringify(challenge)}`,
    );
  }
});

test('hmacOf：输出为 64 位小写 hex', () => {
  const out = hmacOf('abc', 'key');
  assert.match(out, /^[0-9a-f]{64}$/, 'HMAC-SHA256 结果应为 64 位 hex');
});

test('hmacOf：对相同输入稳定可复现', () => {
  const a = hmacOf('same-input', 'same-key');
  const b = hmacOf('same-input', 'same-key');
  assert.strictEqual(a, b, '相同输入应产生相同输出');
});

test('hmacOf：不同密钥产生不同签名', () => {
  const c = 'challenge';
  const x = hmacOf(c, 'key-A');
  const y = hmacOf(c, 'key-B');
  assert.notStrictEqual(x, y, '不同 hmac_key 应产生不同签名');
});
