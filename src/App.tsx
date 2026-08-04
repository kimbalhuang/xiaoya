import { useEffect } from 'react';
import { useChatStore } from './store/chatStore';
import { wsClient } from './lib/wsClient';
import { audioSync } from './lib/audioSync';
import { opusCodec } from './lib/opus';
import ActivationGuide from './components/ActivationGuide';
import ChatView from './components/ChatView';

/**
 * 根组件：根据激活状态在「激活引导」与「聊天界面」之间切换。
 * 启动时建立 /ws 连接并请求激活状态。
 */
export default function App() {
  const phase = useChatStore((s) => s.phase);
  const applyServerMessage = useChatStore((s) => s.applyServerMessage);
  const setConnection = useChatStore((s) => s.setConnection);

  useEffect(() => {
    // 将后端消息/二进制帧接线到 store 与音频播放器
    wsClient.onMessage = (msg) => applyServerMessage(msg);
    wsClient.onBinary = (opus) => {
      // 音频帧交给 audioSync 路由：live 模式缓冲、2d 模式实时播放
      audioSync.push(opus);
    };
    wsClient.onOpen = () => {
      setConnection(true);
      // 连接建立后请求激活状态（已激活则直接 ready，否则进入激活引导）
      wsClient.send({ type: 'get_activation' });
    };
    wsClient.onClose = () => setConnection(false);

    wsClient.connect();
    // 预热 Opus 解码器 WASM（无需用户手势，提前吃掉首帧的 import+ready 成本）
    void opusCodec.warmup();

    return () => {
      wsClient.close();
    };
  }, [applyServerMessage, setConnection]);

  return (
    <div className="min-h-dvh bg-gray-50">
      {phase === 'activating' && <ActivationGuide />}
      {phase === 'chatting' && <ChatView />}
    </div>
  );
}
