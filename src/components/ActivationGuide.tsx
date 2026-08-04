import { useEffect, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { wsClient } from '../lib/wsClient';

/**
 * 激活引导页：
 * - 展示 OTA 返回的 4 位绑定验证码
 * - 展示激活轮询进度（status）
 * - 激活成功（ready）后由 App 切换到聊天界面
 * - 连接诊断：10 秒仍未连上服务端时给出明确提示与重试入口，
 *   避免用户无法区分「后端未启动」与「正常轮询中」
 */
export default function ActivationGuide() {
  const activation = useChatStore((s) => s.activation);
  const statusText = useChatStore((s) => s.statusText);
  const connected = useChatStore((s) => s.connected);
  const lastError = useChatStore((s) => s.lastError);
  // 连接超时标记：前 10 秒显示「正在连接服务端…」，超时后切换为诊断提示
  const [connectTimedOut, setConnectTimedOut] = useState(false);

  // 连接超时定时器：connected 变为 true 时清除；断开时重新计时
  useEffect(() => {
    if (connected) {
      setConnectTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setConnectTimedOut(true), 10000);
    return () => window.clearTimeout(timer);
  }, [connected]);

  // 重试连接：wsClient.connect() 为公开方法，重建 /ws 连接；
  // 连接成功后 App 注册的 onOpen 会自动再次发送 get_activation
  const handleRetryConnect = () => {
    setConnectTimedOut(false);
    wsClient.connect();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-900 to-slate-700 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white/95 p-8 shadow-xl">
        <h1 className="mb-2 text-center text-2xl font-bold text-slate-800">小智设备激活</h1>
        <p className="mb-6 text-center text-sm text-slate-500">
          请在小智 App 中绑定此设备以完成激活
        </p>

        {!connected && !connectTimedOut && (
          <div className="mb-4 rounded bg-amber-50 p-3 text-center text-sm text-amber-700">
            正在连接服务端…
          </div>
        )}

        {!connected && connectTimedOut && (
          <div className="mb-4 rounded bg-red-50 p-3 text-center text-sm text-red-600">
            <p>无法连接服务端，请确认后端已启动（npm run server，端口 3001）</p>
            <button
              type="button"
              onClick={handleRetryConnect}
              className="mt-2 rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            >
              重试连接
            </button>
          </div>
        )}

        {activation && (
          <div className="mb-6 text-center">
            <div className="mb-1 text-xs uppercase tracking-widest text-slate-400">绑定验证码</div>
            <div className="select-all text-5xl font-extrabold tracking-[0.3em] text-indigo-600">
              {activation.code}
            </div>
          </div>
        )}

        <div className="mb-4 text-center text-sm text-slate-600">{statusText || '等待激活…'}</div>

        {lastError && (
          <div className="rounded bg-red-50 p-3 text-center text-sm text-red-600">
            {lastError.message}（{lastError.code}）
          </div>
        )}

        <ol className="mt-6 space-y-2 text-xs text-slate-500">
          <li>1. 打开「小智」App，进入「添加设备」</li>
          <li>2. 输入上方 4 位验证码完成绑定</li>
          <li>3. 绑定成功后本页面将自动进入聊天</li>
        </ol>
      </div>
    </div>
  );
}
