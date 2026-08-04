'use strict';

/**
 * device.test.js —— 无依赖测试（仅 node:test / node:assert / node:crypto / node:fs）。
 * 验证 server/device.js：
 *   1) generateDevice() 四元组的格式与公式（用独立 crypto 重算交叉验证）
 *   2) loadDevice() 持久化后重载得到相同四元组（重定向到临时目录，不污染真实 server/data）
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { generateDevice, loadDevice } = require('../server/device');

// device.js 内部的硬编码路径（__dirname 为 server/，本测试 __dirname 为 test/）
const realDataDir = path.join(__dirname, '..', 'server', 'data');
const realDeviceFile = path.join(realDataDir, 'device.json');

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const UUIDV4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SN_RE = /^SN-[0-9A-F]{8}-[0-9a-f]{12}$/;

test('generateDevice：四元组格式正确', () => {
  const d = generateDevice();
  assert.ok(MAC_RE.test(d.device_id), `device_id 应为 MAC 风格: ${d.device_id}`);
  assert.ok(UUIDV4_RE.test(d.client_id), `client_id 应为 UUID v4: ${d.client_id}`);
  assert.strictEqual(d.mac, d.device_id, 'mac 应等于 device_id');
  assert.ok(SN_RE.test(d.serial_number), `serial_number 结构不符: ${d.serial_number}`);
  assert.strictEqual(d.activated, false, '新设备默认未激活');
  assert.ok(/^[0-9a-f]{64}$/.test(d.hmac_key), 'hmac_key 应为 64 位 hex');
});

test('generateDevice：serial_number 公式与独立计算一致', () => {
  const d = generateDevice();
  const macClean = d.device_id.replace(/:/g, '').toLowerCase();
  const md5 = crypto.createHash('md5').update(macClean).digest('hex');
  const expected = `SN-${md5.slice(0, 8).toUpperCase()}-${macClean}`;
  assert.strictEqual(d.serial_number, expected, 'serial_number 公式不符');
});

test('generateDevice：hmac_key 公式与独立计算一致', () => {
  const d = generateDevice();
  const expected = crypto
    .createHash('sha256')
    .update(`${d.device_id}||${d.client_id}`)
    .digest('hex');
  assert.strictEqual(d.hmac_key, expected, 'hmac_key 公式不符');
});

test('generateDevice：多次生成互不相同', () => {
  const a = generateDevice();
  const b = generateDevice();
  assert.notDeepStrictEqual(a, b, '两次随机生成不应完全相同');
});

test('loadDevice：持久化后重载得到相同四元组（临时目录，不污染 server/data）', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xz-dev-'));
  const tmpFile = path.join(tmpDir, 'device.json');

  // 将所有打到真实 server/data 的 fs 调用重定向到临时目录
  const toTemp = (p) => {
    const s = String(p);
    if (s === realDeviceFile) return tmpFile;
    if (s === realDataDir) return tmpDir;
    return p;
  };
  const origExists = fs.existsSync.bind(fs);
  const origRead = fs.readFileSync.bind(fs);
  const origWrite = fs.writeFileSync.bind(fs);
  const origMkdir = fs.mkdirSync.bind(fs);
  // 记录测试前真实文件的存在状态（仓库可能已存在真实 device.json，测试只需保证其不被改动）
  const realExistedBefore = origExists(realDeviceFile);
  t.mock.method(fs, 'existsSync', (p) => origExists(toTemp(p)));
  t.mock.method(fs, 'readFileSync', (p, ...rest) => origRead(toTemp(p), ...rest));
  t.mock.method(fs, 'writeFileSync', (p, ...rest) => origWrite(toTemp(p), ...rest));
  t.mock.method(fs, 'mkdirSync', (p, ...rest) => origMkdir(toTemp(p), ...rest));

  const first = loadDevice();
  assert.ok(first && first.device_id && first.hmac_key, '首次 loadDevice 应返回有效设备');

  const second = loadDevice();
  // 四元组 + 激活态在重载后必须保持一致（新增的 websocket 兜底字段允许存在）
  for (const key of ['device_id', 'client_id', 'mac', 'serial_number', 'hmac_key', 'activated']) {
    assert.strictEqual(second[key], first[key], `重载后 ${key} 应一致`);
  }
  // 兜底字段校验：loadDevice 应对旧版文件补齐 websocket=null、activated 布尔化
  assert.strictEqual(second.websocket, null, '重载后 websocket 兜底应为 null');
  assert.strictEqual(second.activated, false, '重载后 activated 应保持 false');

  // 验证文件确实写入了临时目录（而非真实 server/data）
  assert.ok(origExists(tmpFile), '设备文件应写入临时目录');
  assert.strictEqual(
    origExists(realDeviceFile),
    realExistedBefore,
    '不应改变真实 server/data/device.json 的存在状态',
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
