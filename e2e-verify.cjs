// 端到端实测：直接驱动 GradioAdapter.submit()，验证 sendControl 是否下发 m3u8
const { createFlashHeadAdapter } = require('./server/flashhead');

(async () => {
  const events = [];
  const adapter = createFlashHeadAdapter({
    mode: 'gradio',
    url: 'http://127.0.0.1:6006',
    onFrame: (b) => { events.push({ t: 'onFrame', len: b.length }); },
    onMode: (m) => { events.push({ t: 'onMode', mode: m }); },
    sendControl: (obj) => { events.push({ t: 'sendControl', obj }); },
  });
  console.log('适配器类型:', adapter.constructor.name);
  adapter.init(null);
  adapter.feedAudio(Buffer.alloc(32000));
  console.log('开始 submit...', new Date().toLocaleTimeString());
  try {
    await adapter.submit();
    console.log('submit 完成', new Date().toLocaleTimeString());
  } catch (e) {
    console.log('submit 抛错:', e.message);
  }
  console.log('=== 事件序列 ===');
  events.forEach((e) => console.log(JSON.stringify(e).slice(0, 200)));
  const videoEvt = events.find((e) => e.t === 'sendControl' && e.obj && e.obj.type === 'video');
  if (videoEvt) {
    const url = videoEvt.obj.url;
    console.log('\n=== 验证 m3u8:', url, '===');
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const txt = await r.text();
    console.log('HTTP', r.status, '| 含 #EXTM3U:', txt.includes('#EXTM3U'), '| 前 120:', txt.slice(0, 120).replace(/\n/g, ' '));
    const segMatch = txt.match(/[^\s]+\.ts[^\s]*/);
    if (segMatch) {
      const segUrl = segMatch[0].startsWith('http') ? segMatch[0] : new URL(segMatch[0], url).toString();
      const sr = await fetch(segUrl, { signal: AbortSignal.timeout(10000) });
      const sb = Buffer.from(await sr.arrayBuffer());
      console.log('分片 HTTP', sr.status, '| bytes:', sb.length);
    } else {
      console.log('m3u8 未含 .ts（可能是 master playlist）');
    }
  } else {
    console.log('!!! 未收到 sendControl video 事件');
  }
  process.exit(0);
})();
