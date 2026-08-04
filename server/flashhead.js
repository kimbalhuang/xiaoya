'use strict';

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

/**
 * FlashHead 适配器（策略模式）。只保留本地推理模式（架构简化，已移除云端 WaveSpeed 模式）：
 * - TwoDAdapter：实时语音占位（内部实现），不生成视频，通知前端使用 2D 头像实时播放 TTS
 * - LocalAdapter：连接本地 FastAPI 推理服务（ws://FLASHHEAD_URL/ws）
 * - GradioAdapter：连接本地已运行的 SoulX FlashHead Gradio 服务
 *   （http://FLASHHEAD_URL，流式推理端点 /run_inference_streaming），失败降级 2D
 *
 * 后端 → FlashHead 协议（C）：
 *   后端发送 {type:"init",portrait} → 流式 {type:"audio",pcm:base64}
 *   FlashHead 回 {type:"frame",image:base64} 或 {type:"video",webm_chunk:base64}
 */
class FlashHeadAdapter {
  constructor({ mode, url, apiKey, onFrame, onMode, sendControl }) {
    this.mode = mode;
    this.url = url;
    this.apiKey = apiKey;
    this.onFrame = onFrame; // (Buffer) => void  发送视频帧给浏览器
    this.onMode = onMode; // (mode) => void
    this.sendControl = sendControl || null; // (obj) => void 发送 JSON 控制消息给浏览器（如 {type:'video',url}）
    this.portrait = null;
    this.ws = null;
  }
  init(portrait) {
    this.portrait = portrait;
  }
  feedAudio(/* pcmBuffer */) {
    /* 由子类实现 */
  }
  setPortrait(image) {
    this.portrait = image;
  }
  close() {
    /* 由子类实现 */
  }
}

class TwoDAdapter extends FlashHeadAdapter {
  init(portrait) {
    super.init(portrait);
    this.onMode?.('2d'); // 通知前端使用 2D 降级头像
  }
  feedAudio() {
    /* 2D 模式不生成视频，前端按 emotion 自行做动画 */
  }
  close() {
    /* noop */
  }
}

class LocalAdapter extends FlashHeadAdapter {
  init(portrait) {
    super.init(portrait);
    this.onMode?.('live');
    try {
      this.ws = new WebSocket(this.url.replace(/\/$/, '') + '/ws');
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'init', portrait: this.portrait }));
      });
      this.ws.on('message', (data) => this.onFlashHeadMessage(data));
      this.ws.on('error', (err) => {
        console.error('[flashhead:local] 连接失败，降级 2D:', err.message);
        this.onMode?.('2d');
      });
      this.ws.on('close', () => {
        /* 可选：实现重连 */
      });
    } catch (e) {
      console.error('[flashhead:local] 初始化失败，降级 2D:', e.message);
      this.onMode?.('2d');
    }
  }

  onFlashHeadMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    if (msg.type === 'frame' && msg.image) {
      this.onFrame?.(Buffer.from(msg.image, 'base64'));
    } else if (msg.type === 'video' && msg.webm_chunk) {
      this.onFrame?.(Buffer.from(msg.webm_chunk, 'base64'));
    } else if (msg.type === 'mode' && msg.mode === '2d') {
      this.onMode?.('2d');
    }
  }

  feedAudio(pcmBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'audio', pcm: pcmBuffer.toString('base64') }));
  }

  setPortrait(image) {
    this.portrait = image;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'portrait', image }));
    }
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {
        /* noop */
      }
      this.ws = null;
    }
  }
}

/**
 * PCM Int16 数据编码为 WAV 格式（单声道 16000Hz 16bit little-endian）。
 * @param {Buffer} pcmBuffer Int16 PCM 原始字节
 * @returns {Buffer} 含 44 字节 RIFF 头的完整 WAV 数据
 */
function pcmBufferToWav(pcmBuffer) {
  const numSamples = Math.floor(pcmBuffer.length / 2);
  const dataLen = numSamples * 2;
  const header = Buffer.alloc(44);
  // RIFF chunk descriptor
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8, 'ascii');
  // fmt sub-chunk（PCM = 1, mono, 16000Hz, 16-bit）
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);       // sub-chunk 大小
  header.writeUInt16LE(1, 20);        // 音频格式：PCM
  header.writeUInt16LE(1, 22);        // 声道数：单声道
  header.writeUInt32LE(16000, 24);    // 采样率
  header.writeUInt32LE(32000, 28);    // 字节率：16000 × 1 × 2
  header.writeUInt16LE(2, 32);        // 块对齐：1 × 2
  header.writeUInt16LE(16, 34);       // 位深：16bit
  // data sub-chunk
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcmBuffer]);
}

/**
 * 从 Gradio generating/complete 事件的 output.data[0] 中解析视频服务端路径。
 * 兼容字符串路径与 {"video": "...", "path": "..."} 等 dict 形态。
 * @param {*} v output.data[0]
 * @returns {string|null} 文件路径
 */
function extractGradioFilePath(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    // 兼容 Gradio 5.x：video 字段可能直接是字符串路径，也可能是嵌套 FileData dict
    // （含 path/url/meta）。流式文件（is_stream:true）务必优先取 url（/gradio_api/stream/...），
    // 它才是浏览器可直接访问的端点；普通文件 url 为 null 时回退 path。
    const raw = v.video || v.path || v.file || v.name || v.filename || v.url || null;
    if (raw && typeof raw === 'object') {
      return raw.url || raw.path || null;
    }
    return raw;
  }
  return null;
}

/**
 * 从 Gradio SSE 事件载荷中提取输出数组。
 * 实测 Gradio 5.x 流式推理 data 为顶层数组 [{...}]（如 [{"video": {...}}]），
 * 兼容 Gradio 4.x 的 {output:[...]} 与其它 {output:{data:[...]}} 形态。
 * @param {*} msg 已解析的 data JSON
 * @returns {Array} 输出数组
 */
function extractOutputData(msg) {
  if (Array.isArray(msg)) return msg;
  if (!msg || typeof msg !== 'object') return [];
  const out = msg.output;
  return Array.isArray(out) ? out : (out && out.data) || [];
}

/**
 * 构造 Gradio 5.x 服务端要求的完整 FileData dict。
 * Gradio 5.x 的文件类型参数必须传 dict（不能传字符串路径），且 meta 字段必须为
 * {"_type": "gradio.FileData"}，否则 pydantic 校验抛 ValidationError。
 * @param {string} serverPath 上传后服务端返回的路径，如 /tmp/gradio/xxx/file.wav
 * @param {string} [origName] 原始文件名
 * @param {string} [mimeType] MIME 类型
 * @returns {{path:string, url:null, size:null, orig_name:string, mime_type:string, is_stream:boolean, meta:{_type:string}}}
 */
function toFileData(serverPath, origName, mimeType) {
  return {
    path: serverPath,        // 上传后服务端返回的路径，如 /tmp/gradio/xxx/file.wav
    url: null,
    size: null,
    orig_name: origName || 'file',
    mime_type: mimeType || 'application/octet-stream',
    is_stream: false,
    meta: { _type: 'gradio.FileData' },   // 关键：Gradio 5.x pydantic 校验必须
  };
}

/**
 * GradioAdapter：通过用户本地已运行的 SoulX FlashHead Gradio 服务进行异步数字人推理。
 * 服务约定（Gradio 4.x / 5.x），baseUrl 形如 http://127.0.0.1:6006：
 *   上传：POST {base}/gradio_api/upload（multipart/form-data，字段 files）
 *   调用：POST {base}/gradio_api/call/run_inference_streaming（返回 event_id）
 *   轮询：GET  {base}/gradio_api/call/run_inference_streaming/{event_id}（SSE 流）
 *   下载：{base}/gradio_api/file=<path> 或 {base}/<path>（先探测哪个可下载）
 * 工作流程：攒一段完整 TTS 音频 → PCM 编码 WAV → 连同 cond_image(xiaoya.png) 上传
 * → POST 提交推理 → 轮询 SSE 直到 complete → 下载视频 → onFrame 广播。
 * 任何环节失败均降级 2D，不影响聊天主链路。
 */
class GradioAdapter extends FlashHeadAdapter {
  constructor(opts) {
    super(opts);
    /** @type {Buffer[]} 攒积的 PCM 音频片段 */
    this.audioBuffer = [];
    /** Gradio 服务根地址，如 http://127.0.0.1:6006（去尾部斜杠） */
    this.baseUrl = (opts.url || 'http://127.0.0.1:6006').replace(/\/+$/, '');
    /** 已上传到服务端的 cond_image 路径（首次上传后缓存复用，避免重复上传） */
    this.portraitPath = null;
  }

  init(portrait) {
    super.init(portrait);
    // 本地 Gradio 服务在线即进入 live 模式（无需 Key，属于"尝试"语义）。
    // 注意：mode=live 后视频源要等推理完成才下发（约数分钟），
    // 期间前端 Avatar 渲染"数字人生成中…"等待占位，不会空白/黑屏。
    this.onMode?.('live');
  }

  feedAudio(pcmBuffer) {
    this.audioBuffer.push(pcmBuffer);
  }

  /**
   * 提交攒积的 PCM 音频到本地 Gradio 服务进行流式推理。
   * 由 Bridge 在 TTS stop 时触发（完整一段音频已喂完）。
   * 任何环节失败均降级 2D。
   */
  async submit() {
    try {
      // 1. 无音频数据则直接返回（保持当前模式，不清空缓冲之外的副作用）
      if (this.audioBuffer.length === 0) return;

      // 2. PCM → WAV（复用文件内 pcmBufferToWav）
      const pcmAll = Buffer.concat(this.audioBuffer);
      const wavBuf = pcmBufferToWav(pcmAll);

      // 3. 上传 cond_image（public/xiaoya.png）→ 服务端路径
      const condImagePath = await this._getCondImagePath();
      // 4. 上传 WAV → 服务端路径
      const audioPath = await this._uploadFile(wavBuf, 'audio.wav');
      if (!audioPath) throw new Error('WAV 上传失败');

      // 5. POST 调用流式推理端点，换取 event_id
      const callResp = await fetch(`${this.baseUrl}/gradio_api/call/run_inference_streaming`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [
            'models/SoulX-FlashHead-1_3B',
            'models/wav2vec2-base-960h',
            'lite',
            // Gradio 5.x 文件参数必须传完整 FileData dict（含 meta），不能传字符串路径
            toFileData(condImagePath, 'xiaoya.png', 'image/png'),
            toFileData(audioPath, 'audio.wav', 'audio/wav'),
            9999,
            false,
          ],
        }),
      });
      if (!callResp.ok) throw new Error(`调用失败 HTTP ${callResp.status}`);
      const callJson = await callResp.json();
      const eventId = callJson && callJson.event_id;
      if (!eventId) throw new Error('未获取到 event_id');

      // 6. 轮询 SSE 直到 complete / 超时（最长 120s）
      const videoPath = await this._pollEvent(eventId);
      if (!videoPath) throw new Error('未获取到视频路径');

      // 7. 不再下载整个视频：SoulX FlashHead 流式推理返回的是 HLS 播放清单（playlist.m3u8）。
      //    直接把浏览器可访问的 m3u8 URL 通过控制消息 {type:'video',url} 发给前端，
      //    由前端 <video> + hls.js 流式播放（口型/表情随音频逐段实时渲染）。
      const videoUrl = this._resolveVideoUrl(videoPath);
      if (!videoUrl) throw new Error('无法解析视频 URL');
      this.onMode?.('live'); // 先切 live，前端显示播放器容器
      // 通知前端播放 HLS：新增 JSON 控制消息 {type:'video', url}
      this.sendControl?.({ type: 'video', url: videoUrl });
    } catch (e) {
      console.warn('[flashhead:gradio] submit 失败，降级 2D:', e.message);
      this.onMode?.('2d');
    } finally {
      // 清空音频缓冲区，为下一段 TTS 准备
      this.audioBuffer = [];
    }
  }

  /**
   * 上传 cond_image：读取 public/xiaoya.png 上传到 Gradio 服务，
   * 返回服务端路径；结果缓存到 portraitPath，后续 submit 复用。
   */
  async _getCondImagePath() {
    if (this.portraitPath) return this.portraitPath;
    // xiaoya.png 位于 server 目录上一级的 public/ 下
    const condImageBuf = fs.readFileSync(path.join(__dirname, '..', 'public', 'xiaoya.png'));
    const p = await this._uploadFile(condImageBuf, 'cond_image.png');
    if (!p) throw new Error('cond_image 上传失败');
    this.portraitPath = p;
    return p;
  }

  /**
   * 上传单文件到 Gradio 服务，返回服务端路径。
   * Gradio 4.x 上传返回数组，元素可能是 string 路径或 {"path": ...} dict，两者兼容。
   */
  async _uploadFile(buffer, filename) {
    const fd = new FormData();
    // 勿手动设置 Content-Type：undici 会自动生成 multipart boundary
    fd.append('files', new Blob([buffer]), filename);
    const resp = await fetch(`${this.baseUrl}/gradio_api/upload`, { method: 'POST', body: fd });
    if (!resp.ok) throw new Error(`上传失败 HTTP ${resp.status}`);
    const arr = await resp.json();
    const item = Array.isArray(arr) ? arr[0] : arr;
    if (!item) return null;
    return typeof item === 'string' ? item : (item && (item.path || item.name || null));
  }

  /**
   * 轮询流式推理结果（SSE）。实测 Gradio 5.x 以 `event: <type>` + `data: <json>` 两行推送，
   * 事件类型为 heartbeat / generating / complete / error；同时兼容 Gradio 4.x 的单行
   * `data: {json 含 event 字段}` 格式。
   * @param {string} eventId 调用端点返回的 event_id
   * @returns {Promise<string|null>} 视频服务端路径
   */
  async _pollEvent(eventId) {
    const url = `${this.baseUrl}/gradio_api/call/run_inference_streaming/${encodeURIComponent(eventId)}`;
    // 兜底超时：无任何数据到达时中断挂起连接，避免永久悬挂
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`轮询失败 HTTP ${resp.status}`);
      if (!resp.body) throw new Error('轮询响应无 body');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let videoPath = null;
      const deadline = Date.now() + 120000;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        buf = buf.replace(/\r\n/g, '\n');

        // 按空行切分 SSE 事件块
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // 逐行提取事件类型与数据载荷：Gradio 5.x 用 `event: <type>` + `data: <json>` 两行；
          // 兼容 Gradio 4.x 单行 `data: {json 含 event 字段}` 格式。
          let evtType = '';
          let evtData = '';
          for (const line of block.split('\n')) {
            const l = line.trim();
            if (l.startsWith('event:')) {
              evtType = l.slice(6).trim();
            } else if (l.startsWith('data:')) {
              evtData = l.slice(5).trim();
            }
          }
          let msg = null;
          if (evtData) {
            try {
              msg = JSON.parse(evtData);
            } catch (_) {
              msg = null; // data 可能是 null 或非 JSON，忽略载荷只保留 event 类型
            }
          }
          const type = evtType || (msg && (msg.event || msg.type)) || '';
          if (type === 'generating') {
            // Gradio 5.x 流式 data 为顶层数组，见 extractOutputData
            const v = extractGradioFilePath(extractOutputData(msg)[0]);
            if (v) videoPath = v;
          } else if (type === 'complete') {
            // 部分实现仅在 complete 事件携带最终结果，兼容补取
            const v = extractGradioFilePath(extractOutputData(msg)[0]);
            if (v && !videoPath) videoPath = v;
            return videoPath || null;
          } else if (type === 'error') {
            let detail = (msg && (msg.error || msg.msg)) || '未知错误';
            if ((!detail || detail === '未知错误') && msg) {
              const od = extractOutputData(msg);
              if (od && od[0] !== undefined && od[0] !== null) detail = od[0];
            }
            if (detail === '未知错误' || detail === null || detail === undefined) detail = '服务端返回错误';
            throw new Error(`推理错误: ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`);
          }
          // heartbeat 等其它事件直接忽略
        }
        if (Date.now() >= deadline) throw new Error('推理超时（120s）');
      }
      // 流自然结束：若已捕获视频路径则视为成功
      if (videoPath) return videoPath;
      throw new Error('推理流提前结束，未获得视频');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 把 Gradio 返回的视频路径解析为浏览器可访问的绝对 URL。
   * SoulX FlashHead 流式推理返回的是 HLS 播放清单（playlist.m3u8）的服务端路径或完整 URL，
   * 前端需要拿到可 fetch 的绝对地址交给 <video>/hls.js 播放。
   * - 已是完整 URL（http/https）：直接使用
   * - 已带 /gradio_api 前缀（如 Gradio 5.x 的 /gradio_api/stream/... 流式路径）：直接拼 baseUrl
   * - 其余服务端文件路径（如 /tmp/gradio/xxx/xxx.m3u8）：按 Gradio 文件下载接口约定拼 {base}/gradio_api/file=<path>
   * @param {string} videoPath 服务端返回的视频路径或完整 URL
   * @returns {string|null} 绝对 URL
   */
  _resolveVideoUrl(videoPath) {
    if (!videoPath) return null;
    if (/^https?:\/\//.test(videoPath)) return videoPath; // 完整 URL 直接用
    if (videoPath.startsWith('/gradio_api/')) return this.baseUrl + videoPath; // stream 等已带 /gradio_api 前缀
    // 普通服务端路径（如 /tmp/gradio/...）：按 Gradio 文件下载接口约定拼接
    return `${this.baseUrl}/gradio_api/file=${encodeURIComponent(videoPath)}`;
  }

  /**
   * 下载服务端视频文件为 Buffer。
   * 注意：HLS 场景已改为 URL 直传（见 _resolveVideoUrl / submit 第 7 步），
   * 本方法仅保留给可能的旧版帧视频使用，GradioAdapter.submit 不再调用。
   * Gradio 4.x 优先尝试 {base}/gradio_api/file=<path>，失败再试 {base}/<path>；
   * 路径本身为完整 URL 时直接使用。
   */
  async _downloadVideo(filePath) {
    const candidates = [];
    if (/^https?:\/\//.test(filePath)) {
      candidates.push(filePath);
    } else {
      candidates.push(`${this.baseUrl}/gradio_api/file=${filePath}`);
      candidates.push(`${this.baseUrl}/${filePath.replace(/^\/+/, '')}`);
    }
    let lastErr = null;
    for (const url of candidates) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          lastErr = new Error(`视频下载 HTTP ${resp.status}`);
          continue;
        }
        return Buffer.from(await resp.arrayBuffer());
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('视频下载失败');
  }

  setPortrait(image) {
    this.portrait = image;
  }

  close() {
    this.audioBuffer = [];
  }
}

/**
 * 探测本地 FlashHead 推理服务是否可用。
 * 命中 {base}/gradio_api/info（Gradio 标准信息端点）即认为本地推理在线。
 * @param {string} url 本地推理服务根地址，如 http://127.0.0.1:6006
 * @param {number} [timeoutMs] 超时毫秒数，默认 10000
 * @returns {Promise<boolean>} 在线返回 true，连不上/超时返回 false
 */
async function probeLocalFlashHead(url, timeoutMs) {
  const base = (url || '').replace(/\/+$/, '');
  try {
    const r = await fetch(base + '/gradio_api/info', { signal: AbortSignal.timeout(timeoutMs || 10000) });
    return r.ok;
  } catch (_) {
    return false;
  }
}

function createFlashHeadAdapter(opts) {
  const mode = (opts.mode || 'gradio').toLowerCase();
  if (mode === 'local') return new LocalAdapter(opts);
  // 2d / none：仅内部实时语音占位路径（探测失败时由 index.js 直接 new TwoDAdapter，非可选模式）
  if (mode === '2d' || mode === 'none') return new TwoDAdapter(opts);
  // gradio 与其它值一律视为本地 Gradio 推理（唯一推荐模式）
  return new GradioAdapter(opts);
}

module.exports = {
  createFlashHeadAdapter,
  probeLocalFlashHead,
  FlashHeadAdapter,
  LocalAdapter,
  GradioAdapter,
  TwoDAdapter,
};
