import type { ClientToServerMessage, ServerMessage } from '../types';

/**
 * 浏览器 ↔ 后端 Node（/ws）WebSocket 客户端。
 * - 自动重连
 * - 发送 JSON 控制消息
 * - 发送 / 接收 Opus 二进制帧：一条 WS 二进制消息即一个完整裸 Opus 帧
 *   （RFC 6716，无长度前缀），文本（JSON 控制）与音频（裸 Opus）按消息类型区分
 */
type MessageHandler = (msg: ServerMessage) => void;
type BinaryHandler = (opusPayload: Uint8Array) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectEnabled = true;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private readonly baseDelay = 1500;
  private readonly maxDelay = 15000;
  private readonly url: string;

  onMessage: MessageHandler | null = null;
  onBinary: BinaryHandler | null = null;
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.url = `${proto}://${location.host}/ws`;
  }

  connect(): void {
    this.reconnectEnabled = true;
    // 幂等：已有 OPEN/CONNECTING 的连接则不再新建，
    // 避免 React StrictMode 双挂载 / 重复调用产生并发多连接（每个连接都会在
    // vite 代理上建一条 socket，断开时即触发 ECONNRESET/ECONNABORTED 噪声）。
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      // 守卫：StrictMode 下旧连接的 onopen 可能在被新连接替换后才触发，忽略过期回调
      if (this.ws !== ws) return;
      this.reconnectAttempts = 0; // 连接成功，重置退避计数
      this.onOpen?.();
    };
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev);
    ws.onclose = () => {
      this.onClose?.();
      if (this.reconnectEnabled) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // 交给 onclose 处理重连
      ws.close();
    };
  }

  private handleMessage(ev: MessageEvent): void {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        this.onMessage?.(msg);
      } catch (e) {
        console.warn('[wsClient] 无法解析 JSON 消息', e);
      }
      return;
    }
    // 二进制消息：整个消息就是一个完整裸 Opus 帧（RFC 6716），无 4 字节长度前缀，
    // 直接透传回调。文本（JSON 控制）与音频（裸 Opus）按 WS 消息类型区分。
    const buf = new Uint8Array(ev.data as ArrayBuffer);
    if (buf.length === 0) {
      console.warn('[wsClient] 收到空二进制帧，忽略');
      return;
    }
    this.onBinary?.(buf);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    // 指数退避 + 随机抖动：后端 RST/重启时避免每 1.5s 死循环重连，
    // 否则每次重连都会冲刷 vite 代理 socket，制造持续 ECONNRESET/ECONNABORTED 噪声。
    this.reconnectAttempts += 1;
    const exp = Math.min(this.maxDelay, this.baseDelay * 2 ** (this.reconnectAttempts - 1));
    const jitter = Math.random() * 500; // 0~500ms 抖动，打散重连尖峰
    const delay = exp + jitter;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  send(msg: ClientToServerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn('[wsClient] 连接未就绪，无法发送', msg);
    }
  }

  /** 发送裸 Opus 帧（RFC 6716，无长度前缀），与小智真实协议一致 */
  sendOpus(opusPayload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(opusPayload);
  }

  close(): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

/** 全局单例：整个应用共用一条 /ws 连接 */
export const wsClient = new WsClient();
