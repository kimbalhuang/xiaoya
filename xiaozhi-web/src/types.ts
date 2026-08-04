// 共享类型定义：设备身份、WS 消息协议、Emotion 枚举等。
// 前端（TypeScript）与文档/后端协议保持一致。

/** 设备身份四元组（生成一次后持久化到 server/data/device.json） */
export interface DeviceIdentity {
  device_id: string; // MAC 风格 xx:xx:xx:xx:xx:xx
  client_id: string; // UUID v4
  mac: string; // 等同于 device_id（小写 MAC）
  serial_number: string; // SN-{MD5(mac_clean)[:8].upper()}-{mac_clean}
  hmac_key: string; // sha256(device_id + "||" + client_id) 的 hex
  websocket?: { url: string; token: string }; // 激活后由 OTA 返回的聊天端点
}

/** 情绪枚举（小智 llm 消息携带） */
export type Emotion = 'happy' | 'sad' | 'angry' | 'surprised' | 'neutral' | 'fear' | 'disgust';

/** emotion → 表情映射（缺省 neutral） */
export const EMOTION_TO_EXPRESSION: Record<Emotion, string> = {
  happy: 'smile',
  sad: 'frown',
  angry: 'tight',
  surprised: 'wide',
  neutral: 'calm',
  fear: 'tremble',
  disgust: 'grimace',
};

/** 将原始 emotion 标签转换为表情名，缺省返回 calm */
export function emotionToExpression(e: string | undefined): string {
  if (e && e in EMOTION_TO_EXPRESSION) return EMOTION_TO_EXPRESSION[e as Emotion];
  return EMOTION_TO_EXPRESSION.neutral;
}

/** 头像渲染模式 */
export type AvatarMode = 'live' | '2d';

/** 统一错误码 */
export type ErrorCode =
  | 'DEVICE_NOT_READY'
  | 'OTA_ACTIVATION_TIMEOUT'
  | 'WS_BRIDGE_DOWN'
  | 'FLASHHEAD_UNAVAILABLE'
  | 'OPUS_DECODE_ERROR'
  | 'BAD_REQUEST';

/** 音频参数（默认 16k / 单声道 / opus / 60ms 帧） */
export interface AudioParams {
  sample_rate: number;
  channels: number;
  format: string;
  frame_duration: number;
}

export const DEFAULT_AUDIO_PARAMS: AudioParams = {
  sample_rate: 16000,
  channels: 1,
  format: 'opus',
  frame_duration: 60,
};

// ============ (A) 浏览器 ↔ 后端 Node（/ws）============

/** 浏览器 → 后端 控制消息 */
export type ClientToServerMessage =
  | { type: 'hello'; sessionId?: string; audioParams?: AudioParams }
  | { type: 'listen'; state: 'detect' | 'stop'; text?: string }
  | { type: 'listen_stop' }
  | { type: 'abort' }
  | { type: 'get_activation' };

/** 后端 → 浏览器 控制消息 */
export type ServerToClientMessage =
  | { type: 'ready'; websocket?: { url: string; token: string } }
  | { type: 'stt'; text: string }
  | { type: 'llm'; text: string; emotion?: Emotion }
  | { type: 'tts'; state: 'start' | 'sentence_start' | 'sentence_end' | 'stop'; text?: string }
  | { type: 'emotion'; label: Emotion }
  | { type: 'status'; state: string }
  | { type: 'activation'; code: string; challenge: string }
  | { type: 'error'; code: ErrorCode; message: string }
  | { type: 'config'; audioSyncPreferVideo?: boolean };

export type ServerMessage = ServerToClientMessage;

// ============ (B) 浏览器 ↔ 后端（/avatar）============

/** /avatar 控制消息（mode / portrait） */
export type AvatarControlMessage =
  | { type: 'mode'; mode: AvatarMode }
  | { type: 'portrait'; image: string };

// ============ 聊天消息 ============

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  emotion?: Emotion;
  timestamp: number;
}
