'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
// 裸 Opus 解码（基于 WASM，社区成熟方案，已从 npm 确认存在）
// opus-decoder 为普通包名（非 scoped），具名导出 OpusDecoder，构造后需 await ready
// 注意：该包面向浏览器 WASM，部分版本在 Node 环境 require 会抛错/触发 WASM 初始化异常。
// 因此采用「容错惰性加载」：顶层加载失败仅降级 FlashHead 音频供给，
// 绝不让后端进程因该依赖崩溃（否则激活码链路整体不可用）。
let OpusDecoderModule = null;
try {
  OpusDecoderModule = require('opus-decoder');
} catch (e) {
  console.warn('[bridge] opus-decoder 加载失败（FlashHead 音频供给降级）:', e.message);
}

const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_CHANNELS = 1;
const { WS_URL } = require('./ota');

/**
 * XiaozhiBridge：连接小智 WebSocket（带四协议头），桥接浏览器消息，
 * 并把 TTS Opus 音频解码为 PCM 供给 FlashHead 适配器。
 *
 * 小智 WS 连接头（浏览器无法设置，必须后端代理）：
 *   Authorization: Bearer <token>
 *   Protocol-Version: 1
 *   Client-Id: <client_id>
 *   Device-Id: <device_id>
 *   Serial-Number: <serial_number>
 */
class XiaozhiBridge {
  constructor({ device, flashhead, sendToBrowser, sessionId }) {
    this.device = device;
    this.flashhead = flashhead;
    this.sendToBrowser = sendToBrowser; // (obj) => void  JSON 控制消息
    this.sessionId = sessionId || crypto.randomUUID();
    this.xzWs = null;
    this.connected = false;
    this.connecting = false;        // 是否在「建连/重连中」（await 解码器 + WS 握手期间）
    this.reconnectTimer = null;
    this.sendBinaryToBrowser = null;
    this.pendingMessages = [];      // 桥接就绪前缓冲的浏览器控制消息，open 后补发

    // 解码器延迟到 connect() 时异步初始化（WASM 需 await ready）。
    // 构造阶段不触发加载，避免同步构造报错；初始化失败则保持 null（仅降级 FlashHead）。
    this.decoder = null;
  }

  /**
   * 异步初始化 Opus 解码器。
   * opus-decoder 构造后 WASM 异步加载，必须 await decoder.ready
   * 才能调用 decode。初始化失败（WASM 加载失败等）则 decoder 置 null，
   * FlashHead 音频供给降级，不影响聊天主链路。
   */
  async initDecoder() {
    try {
      if (!OpusDecoderModule) {
        // 顶层加载已失败：解码器不可用，直接降级（FlashHead 音频供给关闭，聊天主链路不受影响）
        this.decoder = null;
        return;
      }
      // opus-decoder 具名导出 OpusDecoder；兼容 default / 直接导出类
      const DecoderCtor =
        (OpusDecoderModule && OpusDecoderModule.OpusDecoder) ||
        OpusDecoderModule.default ||
        OpusDecoderModule;
      this.decoder = new DecoderCtor({
        sampleRate: AUDIO_SAMPLE_RATE,
        channels: AUDIO_CHANNELS,
        forceStereo: false,
      });
      await this.decoder.ready;
    } catch (e) {
      console.warn('[bridge] OpusDecoder 初始化失败（FlashHead 音频供给将不可用）:', e.message);
      this.decoder = null;
    }
  }

  /** 设置向浏览器发送二进制帧（裸 Opus 帧，无长度前缀）的回调 */
  setBinarySink(fn) {
    this.sendBinaryToBrowser = fn;
  }

  async connect() {
    // 幂等保护：已有连接在途（OPEN/CONNECTING）直接复用，避免并发创建多个到小智的连接
    if (this.xzWs && (this.xzWs.readyState === WebSocket.OPEN || this.xzWs.readyState === WebSocket.CONNECTING)) {
      return;
    }
    // 防重入：connect() 内含 await（解码器 / WS 握手），期间标记 connecting，
    // 避免多次调用重复建连；同时让 handleClientMessage 能区分"正在连"与"彻底断"。
    if (this.connecting) return;
    this.connecting = true;

    // WASM 解码器只需初始化一次；初始化失败则 decoder 为 null（自动降级 FlashHead）
    if (!this.decoder && OpusDecoderModule) {
      try {
        await this.initDecoder();
      } catch (e) {
        this.connecting = false;
        console.error('[bridge] 解码器初始化失败，取消建连:', e.message);
        return;
      }
    }

    const wsInfo = this.device.websocket;
    if (!wsInfo || !wsInfo.token) {
      this.connecting = false;
      this.sendToBrowser({
        type: 'error',
        code: 'DEVICE_NOT_READY',
        message: '设备尚未激活，缺少 WebSocket 令牌',
      });
      return;
    }
    const url = wsInfo.url || WS_URL;
    const headers = {
      Authorization: `Bearer ${wsInfo.token}`,
      'Protocol-Version': '1',
      'Client-Id': this.device.client_id,
      'Device-Id': this.device.device_id,
      'Serial-Number': this.device.serial_number,
    };
    // 防御性禁用 perMessageDeflate：避免与虾哥云服务端协商压缩扩展，
    // 小智下行 TTS 音频帧为二进制，若压缩协商异常可能同样导致丢帧/解析异常。
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    this.xzWs = ws; // 仅用于其它调用点（send/close）取当前连接

    // 事件回调全部闭包引用局部 ws，不再依赖 this.xzWs：
    // 多次 connect() 时旧连接的 open 事件后触发也不会误发到新连接（防 readyState 0 崩溃）
    ws.on('open', () => this.onOpen(ws));
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', (code) => this.onClose(code, ws));
    ws.on('error', (err) => console.error('[bridge] 小智 WS 错误:', err.message));
  }

  onOpen(ws) {
    this.connecting = false;
    this.connected = true;
    this.sendToBrowser({ type: 'status', state: 'connecting' });
    this.sendHello(ws);
    // 连上后补发建连窗口内缓冲的浏览器消息（此时 xzWs 已 OPEN，会走正常分支）
    this.flushPending();
  }

  /** 把缓冲的控制消息重放回 handleClientMessage（连接已 OPEN，会走正常发送分支） */
  flushPending() {
    if (this.pendingMessages.length === 0) return;
    const pending = this.pendingMessages;
    this.pendingMessages = [];
    console.log(`[bridge] 补发 ${pending.length} 条缓冲消息`);
    for (const msg of pending) this.handleClientMessage(msg);
  }

  sendHello(ws) {
    // 兼容 handleClientMessage 的 hello 路径（无参调用时回退到当前连接 this.xzWs）；
    // onOpen 始终传入闭包 ws，竞态修复不受影响（回退分支仅在显式无参调用时命中）。
    const target = ws || this.xzWs;
    const msg = {
      session_id: this.sessionId,
      type: 'hello',
      version: 1,
      transport: 'websocket',
      audio_params: {
        format: 'opus',
        sample_rate: AUDIO_SAMPLE_RATE,
        channels: AUDIO_CHANNELS,
        frame_duration: 60,
      },
    };
    // 守卫：仅当连接处于 OPEN 才发送，CONNECTING/CLOSING/CLOSED 一律跳过（不再抛 readyState 异常）
    if (target && target.readyState === WebSocket.OPEN) target.send(JSON.stringify(msg));
  }

  onMessage(data, isBinary) {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // 小智下行二进制消息即完整裸 Opus 帧（RFC 6716，无长度前缀），直接透传浏览器
      if (this.sendBinaryToBrowser) this.sendBinaryToBrowser(buf);
      // 解码为 PCM 供给 FlashHead
      this.feedFlashHead(buf);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.warn('[bridge] 无法解析小智 JSON:', e.message);
      return;
    }
    this.routeFromXiaozhi(msg);
  }

  routeFromXiaozhi(msg) {
    switch (msg.type) {
      case 'hello':
        this.sendToBrowser({ type: 'ready', websocket: this.device.websocket });
        break;
      case 'stt':
        this.sendToBrowser({ type: 'stt', text: msg.text || '' });
        break;
      case 'llm':
        this.sendToBrowser({ type: 'llm', text: msg.text || '', emotion: msg.emotion });
        if (msg.emotion) this.sendToBrowser({ type: 'emotion', label: msg.emotion });
        break;
      case 'tts':
        this.sendToBrowser({ type: 'tts', state: msg.state, text: msg.text });
        // TTS 播报结束（完整一段音频已喂完）→ 触发 FlashHead 云推理
        if (msg.state === 'stop' && this.flashhead && typeof this.flashhead.submit === 'function') {
          this.flashhead.submit().catch(() => {});
        }
        break;
      default:
        console.log('[bridge] 忽略小智消息类型:', msg.type);
    }
  }

  /** 浏览器 → 小智 控制消息 */
  handleClientMessage(msg) {
    // 桥接尚未就绪：区分「正在连接中」与「设备未激活」，避免误报"连接尚未建立"
    if (!this.xzWs || this.xzWs.readyState !== WebSocket.OPEN) {
      if (msg.type === 'hello') {
        this.sessionId = msg.sessionId || this.sessionId;
        this.connect().catch(console.error);
        return;
      }
      const wsInfo = this.device && this.device.websocket;
      if (!wsInfo || !wsInfo.token) {
        // 设备令牌缺失：确实无法连接小智，如实报错（而非笼统的"连接尚未建立"）
        this.sendToBrowser({
          type: 'error',
          code: 'DEVICE_NOT_READY',
          message: '设备尚未激活，请先在「小智」App 中完成绑定',
        });
        return;
      }
      // 设备已就绪但桥接仍在建立/重连中：缓冲消息，连上后自动补发，不报错；
      // 若当前不在连接流程中则顺带触发一次 connect。
      this.pendingMessages.push(msg);
      if (!this.connecting) {
        this.connect().catch(console.error);
      }
      return;
    }
    switch (msg.type) {
      case 'hello':
        this.sessionId = msg.sessionId || this.sessionId;
        this.sendHello();
        break;
      case 'listen':
        if (this.xzWs)
          this.xzWs.send(
            JSON.stringify({
              session_id: this.sessionId,
              type: 'listen',
              state: msg.state,
              text: msg.text,
            }),
          );
        break;
      case 'listen_stop':
        if (this.xzWs)
          this.xzWs.send(JSON.stringify({ session_id: this.sessionId, type: 'listen', state: 'stop' }));
        break;
      case 'abort':
        if (this.xzWs)
          this.xzWs.send(JSON.stringify({ session_id: this.sessionId, type: 'abort' }));
        break;
      default:
        console.warn('[bridge] 未知浏览器消息:', msg.type);
    }
  }

  /** 浏览器 → 小智 二进制帧（裸 Opus 帧，无长度前缀）→ 透明转发 */
  handleClientBinary(buf) {
    if (this.xzWs && this.xzWs.readyState === WebSocket.OPEN) {
      this.xzWs.send(buf);
      this.feedFlashHead(buf);
    }
  }

  /** 解码 Opus 帧为 Int16 PCM 并喂给 FlashHead 适配器 */
  feedFlashHead(buf) {
    if (!this.flashhead || !this.decoder) return;
    try {
      // buf 即为完整裸 Opus 帧（RFC 6716，无 4 字节长度前缀），直接解码
      const opus = buf;
      if (opus.length === 0) return;
      const res = this.decoder.decodeFrame(opus);
      const channelData = res.channelData || (res.float32 ? [res.float32] : []);
      const pcm = channelData[0];
      if (!pcm || pcm.length === 0) return;
      // Float32 [-1,1] → Int16 小端
      const int16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.flashhead.feedAudio(
        Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength),
      );
    } catch (e) {
      console.warn('[bridge] FlashHead 音频解码失败:', e.message);
    }
  }

  onClose(code, ws) {
    // 仅当是「当前连接」关闭才处理状态通知与自动重连；
    // 旧连接（已被新连接替换）的 close 忽略，防止重连风暴。
    if (ws && ws !== this.xzWs) {
      console.log('[bridge] 忽略旧连接 close（已被新连接替换）');
      return;
    }
    this.connecting = false;
    this.connected = false;
    this.sendToBrowser({ type: 'status', state: 'disconnected' });
    if (code === 1005) {
      // hello 后 1005 通常因缺少协议头；后端已带齐四头，理论上不会出现
      this.sendToBrowser({
        type: 'error',
        code: 'WS_BRIDGE_DOWN',
        message: '小智连接被关闭(1005)，请检查激活状态',
      });
    }
    // 自动重连并重新发送 hello
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log('[bridge] 尝试重连小智 WS…');
      this.connect().catch(console.error);
    }, 2000);
  }

  close() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.xzWs) {
      try {
        this.xzWs.close();
      } catch (_) {
        /* noop */
      }
      this.xzWs = null;
    }
  }
}

module.exports = { XiaozhiBridge };
