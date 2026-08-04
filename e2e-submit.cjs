// 端到端验证 GradioAdapter 完整 submit 链路（模拟后端真实行为）
const { createFlashHeadAdapter } = require('./server/flashhead');

const a = createFlashHeadAdapter({
  mode: 'gradio',
  url: 'http://127.0.0.1:6006',
  onFrame: (b) => console.log('[onFrame] 收到视频数据', b.length, 'bytes'),
  onMode: (m) => console.log('[onMode]', m),
  sendControl: (o) => console.log('[sendControl]', JSON.stringify(o).slice(0, 160)),
});

a.init(null);
// 喂 1 秒静音 PCM（16k 单声道 Int16 = 32000 字节）
const pcm = Buffer.alloc(16000 * 2);
a.feedAudio(pcm);
console.log('已喂入 1 秒 PCM，开始 submit… 时间:', new Date().toLocaleTimeString());
const t0 = Date.now();
a.submit()
  .then(() => console.log('submit done，总耗时:', ((Date.now() - t0) / 1000).toFixed(1), 's'))
  .catch((e) => console.log('submit err:', e.message, '| 耗时:', ((Date.now() - t0) / 1000).toFixed(1), 's'));
