'use strict';

/**
 * flashhead.test.js —— 依赖 ws（server/flashhead.js 顶层 require('ws')）。
 * 若未安装 ws，则整体以 skipped 形式跳过，不阻断无依赖测试。
 *
 * 覆盖（架构简化：只保留本地推理，已移除云端 WaveSpeed 模式）：
 *   - createFlashHeadAdapter({mode:'2d'}) → TwoDAdapter（实时语音占位），init() 触发 onMode('2d')
 *   - createFlashHeadAdapter({mode:'local'}) → LocalAdapter
 *   - createFlashHeadAdapter({mode:'gradio'}) / 缺省 → GradioAdapter（唯一推荐模式）
 *   - probeLocalFlashHead：连不存在的端口返回 false；本地 /gradio_api/info 服务返回 true
 *   - LocalAdapter 连接失败应降级 onMode('2d')
 */

const test = require('node:test');
const assert = require('node:assert');

let mod = null;
try {
  mod = require('../server/flashhead');
} catch (e) {
  test('flashhead：依赖 ws 未安装，跳过运行时测试', { skip: `未安装依赖 ws: ${e.message}` }, () => {});
}

if (mod) {
  const { createFlashHeadAdapter, probeLocalFlashHead, TwoDAdapter, LocalAdapter, GradioAdapter } = mod;

  test('mode=2d：返回 TwoDAdapter（实时语音占位）且 init 触发 onMode("2d")', () => {
    let mode = null;
    const a = createFlashHeadAdapter({ mode: '2d', onMode: (m) => { mode = m; } });
    assert.ok(a instanceof TwoDAdapter, '应为 TwoDAdapter');
    a.init(null);
    assert.strictEqual(mode, '2d', 'init 应触发 onMode("2d")');
  });

  test('mode=local：返回 LocalAdapter', () => {
    const a = createFlashHeadAdapter({ mode: 'local', url: 'ws://127.0.0.1:9', onMode: () => {} });
    assert.ok(a instanceof LocalAdapter, '应为 LocalAdapter');
  });

  test('mode=gradio：返回 GradioAdapter', () => {
    const a = createFlashHeadAdapter({ mode: 'gradio', url: 'http://127.0.0.1:6006', onMode: () => {} });
    assert.ok(a instanceof GradioAdapter, '应为 GradioAdapter');
  });

  test('缺省 mode：返回 GradioAdapter（唯一推荐模式）', () => {
    const a = createFlashHeadAdapter({});
    assert.ok(a instanceof GradioAdapter, '缺省应为 GradioAdapter');
  });

  test('probeLocalFlashHead：连接不存在的端口返回 false', async () => {
    const ok = await probeLocalFlashHead('http://127.0.0.1:9', 300);
    assert.strictEqual(ok, false, '连不上的端口应探测失败');
  });

  test('probeLocalFlashHead：本地 /gradio_api/info 服务返回 true', async () => {
    const http = require('node:http');
    const srv = http.createServer((req, res) => {
      if (req.url === '/gradio_api/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${srv.address().port}`;
    try {
      const ok = await probeLocalFlashHead(url, 2000);
      assert.strictEqual(ok, true, '本地 Gradio 信息端点应探测成功');
    } finally {
      srv.close();
    }
  });

  test('LocalAdapter 连接不存在端口应降级 onMode("2d")', async () => {
    const modes = [];
    const a = createFlashHeadAdapter({
      mode: 'local',
      url: 'ws://127.0.0.1:9',
      onMode: (m) => { modes.push(m); },
    });
    a.init(null);
    // 等待连接失败（端口 9 通常拒绝连接）
    await new Promise((r) => setTimeout(r, 3000));
    assert.ok(modes.includes('2d'), `local 连接失败应回退 2d，实际事件: ${JSON.stringify(modes)}`);
  });
}
