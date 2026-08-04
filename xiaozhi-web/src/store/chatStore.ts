import { create } from 'zustand';
import {
  AvatarMode,
  ChatMessage,
  Emotion,
  ErrorCode,
  ServerMessage,
} from '../types';
import { audioSync } from '../lib/audioSync';

export type Phase = 'activating' | 'chatting';

interface ActivationInfo {
  code: string;
  challenge: string;
}

interface ChatState {
  phase: Phase;
  connected: boolean;
  messages: ChatMessage[];
  emotion: Emotion;
  avatarMode: AvatarMode;
  speaking: boolean;
  statusText: string;
  activation: ActivationInfo | null;
  lastError: { code: ErrorCode; message: string } | null;
  currentAssistantId: string | null;
  /** 音频优先级：true=以数字人视频音轨为准（默认）；false=以原始 TTS 为准（视频静音）。 */
  audioSyncPreferVideo: boolean;

  applyServerMessage: (msg: ServerMessage) => void;
  setConnection: (c: boolean) => void;
  setPhase: (p: Phase) => void;
  setAvatarMode: (m: AvatarMode) => void;
  setAudioSyncPreferVideo: (v: boolean) => void;
  clearError: () => void;
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const useChatStore = create<ChatState>((set, get) => ({
  phase: 'activating',
  connected: false,
  messages: [],
  emotion: 'neutral',
  avatarMode: '2d',
  speaking: false,
  statusText: '',
  activation: null,
  lastError: null,
  currentAssistantId: null,
  audioSyncPreferVideo: true,

  setConnection: (c) => set({ connected: c } as Partial<ChatState>),
  setPhase: (p) => set({ phase: p } as Partial<ChatState>),
  setAvatarMode: (m) => set({ avatarMode: m } as Partial<ChatState>),
  setAudioSyncPreferVideo: (v) => set({ audioSyncPreferVideo: v } as Partial<ChatState>),
  clearError: () => set({ lastError: null } as Partial<ChatState>),

  applyServerMessage: (msg) => {
    switch (msg.type) {
      case 'ready':
        // 激活完成 / 桥接就绪 → 进入聊天
        set({ phase: 'chatting', activation: null, statusText: '' } as Partial<ChatState>);
        break;
      case 'activation':
        set({
          activation: { code: msg.code, challenge: msg.challenge },
          statusText: '请在「小智」App 中绑定此设备',
        } as Partial<ChatState>);
        break;
      case 'status':
        set({ statusText: msg.state } as Partial<ChatState>);
        break;
      case 'stt':
        set((s) => ({
          messages: [...s.messages, { id: uid(), role: 'user', text: msg.text, timestamp: Date.now() }],
        } as Partial<ChatState>));
        break;
      case 'llm': {
        const text = msg.text ?? '';
        const emo: Emotion = msg.emotion ?? get().emotion;
        set((s) => {
          if (s.currentAssistantId) {
            return {
              emotion: emo,
              messages: s.messages.map((m) =>
                m.id === s.currentAssistantId ? { ...m, text: m.text + text, emotion: emo } : m,
              ),
            } as Partial<ChatState>;
          }
          const id = uid();
          return {
            emotion: emo,
            currentAssistantId: id,
            messages: [...s.messages, { id, role: 'assistant', text, emotion: emo, timestamp: Date.now() }],
          } as Partial<ChatState>;
        });
        break;
      }
      case 'emotion':
        set({ emotion: msg.label } as Partial<ChatState>);
        break;
      case 'tts':
        if (msg.state === 'start') {
          // 标记开始播报（与 sentence_start 二选一，均视为开始发音）
          set({ speaking: true } as Partial<ChatState>);
        } else if (msg.state === 'sentence_start') {
          // 指南 6.2 ③：sentence_start 携带当前正在播报的句子文本。
          // 置 speaking=true；若该句文本存在，则合并进 currentAssistantId 对应的
          // assistant 消息（与 llm 累加逻辑一致），无 currentAssistantId 时新建一条。
          const text = msg.text ?? '';
          set((s) => {
            if (text) {
              if (s.currentAssistantId) {
                return {
                  speaking: true,
                  messages: s.messages.map((m) =>
                    m.id === s.currentAssistantId ? { ...m, text: m.text + text } : m,
                  ),
                } as Partial<ChatState>;
              }
              const id = uid();
              return {
                speaking: true,
                currentAssistantId: id,
                messages: [...s.messages, { id, role: 'assistant', text, timestamp: Date.now() }],
              } as Partial<ChatState>;
            }
            return { speaking: true } as Partial<ChatState>;
          });
        } else if (msg.state === 'sentence_end') {
          // 当前句子播报结束：把 currentAssistantId 对应的消息"封口"（提交当前回复段）。
          // 只清空 currentAssistantId，不重置 speaking——后续句子（sentence_start/llm）仍属本次播报；
          // 下一条 llm 消息到达时因 currentAssistantId === null 会新建独立 assistant 气泡。
          set({ currentAssistantId: null } as Partial<ChatState>);
        } else if (msg.state === 'stop') {
          // 播报结束：清空发言状态与当前 assistant 消息游标
          set({ speaking: false, currentAssistantId: null } as Partial<ChatState>);
        }
        break;
      case 'error':
        set({
          lastError: { code: msg.code, message: msg.message },
          statusText: msg.message,
        } as Partial<ChatState>);
        break;
      case 'config': {
        // 后端下发运行时配置（如音频优先级默认项）。非持久化（仅作默认值，用户本地可覆盖）。
        if (typeof msg.audioSyncPreferVideo === 'boolean') {
          audioSync.configure({ preferVideoAudio: msg.audioSyncPreferVideo, persist: false });
          set({ audioSyncPreferVideo: msg.audioSyncPreferVideo } as Partial<ChatState>);
        }
        break;
      }
      default:
        console.warn('[chatStore] 未知服务端消息', (msg as any).type);
    }
  },
}));
