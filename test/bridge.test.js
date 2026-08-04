'use strict';

/**
 * bridge.test.js —— 依赖 ws + opus-decoder（server/bridge.js 顶层 require）。
 * 若未安装，则整体以 skipped 形式跳过。
 *
 * 覆盖：
 *   - routeFromXiaozhi：hello→ready / stt→stt / llm→llm+emotion / tts→tts
 *   - handleClientMessage：listen / listen_stop / abort 发出正确 JSON；未连接时报错
 *   - handleClientBinary：二进制帧透明转发给 xzWs
 */

const test = require('node:test');
const assert = require('node:assert');

let XiaozhiBridge = null;
let WebSocket = null;
try {
  ({ XiaozhiBridge } = require('../server/bridge'));
  ({ WebSocket } = require('ws'));
} catch (e) {
  test('bridge：依赖 ws/opus-decoder 未安装，跳过运行时测试', { skip: `未安装依赖: ${e.message}` }, () => {});
}

if (XiaozhiBridge && WebSocket) {
  function makeBridge() {
    const sent = [];
    const bridge = new XiaozhiBridge({
      device: { device_id: 'aa:bb:cc:dd:ee:ff', client_id: 'cid', serial_number: 'SN-TEST', websocket: { url: 'wss://x', token: 't' } },
      flashhead: { feedAudio: () => {} },
      sendToBrowser: (obj) => sent.push(obj),
      sessionId: 'sess-1',
    });
    return { bridge, sent };
  }

  function mockXzWs() {
    const calls = [];
    return {
      calls,
      readyState: WebSocket.OPEN,
      send: (data) => calls.push(typeof data === 'string' ? JSON.parse(data) : data),
      close: () => {},
    };
  }

  // ---- routeFromXiaozhi ----
  test('routeFromXiaozhi：hello → ready', () => {
    const { bridge, sent } = makeBridge();
    bridge.routeFromXiaozhi({ type: 'hello' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'ready');
    assert.deepStrictEqual(sent[0].websocket, { url: 'wss://x', token: 't' });
  });

  test('routeFromXiaozhi：stt → stt', () => {
    const { bridge, sent } = makeBridge();
    bridge.routeFromXiaozhi({ type: 'stt', text: '你好' });
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0], { type: 'stt', text: '你好' });
  });

  test('routeFromXiaozhi：llm → llm + emotion', () => {
    const { bridge, sent } = makeBridge();
    bridge.routeFromXiaozhi({ type: 'llm', text: '在的', emotion: 'happy' });
    assert.strictEqual(sent.length, 2, 'llm 应同时下发 llm 与 emotion');
    assert.deepStrictEqual(sent[0], { type: 'llm', text: '在的', emotion: 'happy' });
    assert.deepStrictEqual(sent[1], { type: 'emotion', label: 'happy' });
  });

  test('routeFromXiaozhi：tts → tts', () => {
    const { bridge, sent } = makeBridge();
    bridge.routeFromXiaozhi({ type: 'tts', state: 'start', text: '你好' });
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0], { type: 'tts', state: 'start', text: '你好' });
  });

  // ---- handleClientMessage ----
  test('handleClientMessage：listen 发出正确 JSON', () => {
    const { bridge, sent } = makeBridge();
    bridge.xzWs = mockXzWs();
    bridge.handleClientMessage({ type: 'listen', state: 'detect' });
    assert.strictEqual(bridge.xzWs.calls.length, 1);
    // 注：text 为 undefined 时 JSON.stringify 会省略该键（mock 经 JSON.parse 还原），故不期望 text 键
    assert.deepStrictEqual(bridge.xzWs.calls[0], { session_id: 'sess-1', type: 'listen', state: 'detect' });
  });

  test('handleClientMessage：listen_stop 发出 {type:"listen", state:"stop"}', () => {
    const { bridge, sent } = makeBridge();
    bridge.xzWs = mockXzWs();
    bridge.handleClientMessage({ type: 'listen_stop' });
    assert.strictEqual(bridge.xzWs.calls.length, 1);
    assert.deepStrictEqual(bridge.xzWs.calls[0], { session_id: 'sess-1', type: 'listen', state: 'stop' });
  });

  test('handleClientMessage：abort 发出 {type:"abort"}', () => {
    const { bridge, sent } = makeBridge();
    bridge.xzWs = mockXzWs();
    bridge.handleClientMessage({ type: 'abort' });
    assert.strictEqual(bridge.xzWs.calls.length, 1);
    assert.deepStrictEqual(bridge.xzWs.calls[0], { session_id: 'sess-1', type: 'abort' });
  });

  test('handleClientMessage：未连接且设备未激活 → error DEVICE_NOT_READY', () => {
    const { bridge, sent } = makeBridge();
    // 未激活（无 websocket token）时，未连接状态下非 hello 消息应如实报错
    bridge.device = { ...bridge.device, websocket: null };
    bridge.xzWs = null;
    bridge.handleClientMessage({ type: 'listen', state: 'detect' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'error');
    assert.strictEqual(sent[0].code, 'DEVICE_NOT_READY');
  });

  // ---- handleClientBinary ----
  test('handleClientBinary：裸 Opus 帧透明转发给 xzWs', () => {
    const { bridge, sent } = makeBridge();
    const mock = mockXzWs();
    bridge.xzWs = mock;
    // 浏览器上行即为完整裸 Opus 帧（RFC 6716，无 4B 长度前缀），应原样透传
    const rawOpus = Buffer.from([0xdb, 0x83, 0x61, 0x3c, 0x8a, 0x9e, 0x29, 0x94]);
    bridge.handleClientBinary(rawOpus);
    assert.strictEqual(mock.calls.length, 1, '应转发一帧给 xzWs');
    assert.ok(Buffer.isBuffer(mock.calls[0]), '转发的应为 Buffer');
    assert.deepStrictEqual(mock.calls[0], rawOpus, '转发的应为原始裸 Opus 帧，无长度前缀');
  });
}
