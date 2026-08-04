import { useEffect, useRef, useState } from 'react';
import { Box, IconButton, TextField, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import MicIcon from '@mui/icons-material/Mic';
import StopIcon from '@mui/icons-material/Stop';
import SettingsIcon from '@mui/icons-material/Settings';
import { useChatStore } from '../store/chatStore';
import { wsClient } from '../lib/wsClient';
import { AudioRecorder, audioPlayer } from '../lib/audio';
import { audioSync } from '../lib/audioSync';
import Avatar from './Avatar';
import Settings from './Settings';
import { splitLongText } from '../lib/splitText';

/** 触控目标最小尺寸（无障碍：iOS 44pt / Android 48dp） */
const TOUCH_SX = { minWidth: 44, minHeight: 44 } as const;

/**
 * 聊天界面（digital_human 分层布局 + 海报式画布自适应）：
 *  背景图完整显示（contain 比例，不裁剪）→ 页面高度匹配图片比例 → 聊天窗口在画布内自动生成大小。
 *  Z-0 渐变背景 → Z-1 背景图/数字人（画布内铺满，比例一致不裁剪）→ Z-2 暗色蒙版 → Z-10 内容列
 *  （玻璃顶栏 + 透明气泡列表 + 透明字幕 + 玻璃输入栏，均随画布 flex 自适应）。
 * 气泡：完全透明背景 + 暖色描边 + 白字阴影 + 越旧越淡出。
 */
export default function ChatView() {
  const messages = useChatStore((s) => s.messages);
  const speaking = useChatStore((s) => s.speaking);
  const connected = useChatStore((s) => s.connected); // 浏览器 ↔ Node 后端
  const phase = useChatStore((s) => s.phase); // activating | chatting（收到小智 ready 才 chatting）
  const statusText = useChatStore((s) => s.statusText); // 桥接状态：connecting / disconnected / 空

  // 海报画布：以背景图（xiaoya.png）为基准，完整显示（contain）计算画布尺寸，
  // 页面高度匹配图片比例；聊天窗口在画布内自动生成大小。
  const [canvas, setCanvas] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const iw = img.naturalWidth || 1;
      const ih = img.naturalHeight || 1;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // contain：整图完整可见的最大缩放（不裁剪、不变形）
      const scale = Math.min(vw / iw, vh / ih);
      setCanvas({ w: Math.round(iw * scale), h: Math.round(ih * scale) });
    };
    img.src = '/xiaoya.png';
    const onResize = () => {
      if (!img.complete) return;
      const iw = img.naturalWidth || 1;
      const ih = img.naturalHeight || 1;
      const scale = Math.min(window.innerWidth / iw, window.innerHeight / ih);
      setCanvas({ w: Math.round(iw * scale), h: Math.round(ih * scale) });
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // 连接指示灯：所有状态（已连接 / 连接中 / 重连中 / 未连接）一律只显示在图标上，不弹窗
  const reconnecting = connected && phase === 'chatting' && statusText === 'disconnected';
  const xzReady = phase === 'chatting' && !reconnecting;
  const connecting = connected && !xzReady;
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  // 进入聊天后发送 hello 建立与小智的桥接
  useEffect(() => {
    wsClient.send({ type: 'hello' });
    return () => {
      wsClient.send({ type: 'abort' });
    };
  }, []);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendText = () => {
    const t = text.trim();
    if (!t) return;
    // 打断：用户继续输入时立即停止当前 AI 语音/视频播放，并通知后端停止生成，
    // 避免与即将发送的新消息叠加成"双重声音"
    audioSync.interrupt();
    // 预热音频播放链路（用户手势内）：让 AudioContext 此刻 running、解码器就绪，
    // 避免 TTS 帧到达时才创建上下文/resume/加载 WASM，导致「文字先出、语音晚到」
    audioPlayer.warmup();
    // 通知后端中止当前回复（小智协议），随后发送新输入
    wsClient.send({ type: 'abort' });
    // 小智协议：文本输入也走 state:'detect'（靠独立 text 字段区分，而非 state:'text'）
    wsClient.send({ type: 'listen', state: 'detect', text: t });
    setText('');
  };

  const toggleRecord = async () => {
    if (recording) {
      recorderRef.current?.stop();
      recorderRef.current = null;
      setRecording(false);
      wsClient.send({ type: 'listen_stop' });
      return;
    }
    // 打断：开始说话前先停掉可能仍在播放的 AI 语音/视频
    audioSync.interrupt();
    // 预热音频播放链路（用户手势内，必须在 rec.start 之前）：
    // 让 AudioContext 此刻 running，后续 TTS 帧到达即可立即播放，消除首句语音延迟
    audioPlayer.warmup();
    const rec = new AudioRecorder();
    recorderRef.current = rec;
    await rec.start((opus) => wsClient.sendOpus(opus));
    setRecording(true);
  };

  // 气泡淡出：按气泡在页面中的【垂直位置】实时计算——
  // 底部（靠近输入栏）完全不透明，越往上越淡，到达页面中间线时完全透明。
  // 滚动 / 窗口尺寸 / 消息变化时都会重算，保证任何时刻透明度都贴合位置。
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const bubbleEls = useRef<(HTMLDivElement | null)[]>([]);
  const midYRef = useRef(typeof window !== 'undefined' ? window.innerHeight / 2 : 400);

  const updateBubbleOpacity = () => {
    const midY = midYRef.current;
    // 渐变跨度 = 中间线到视口底部（中间线→0，视口底部→1，自然覆盖下半屏）
    const span = Math.max(1, midY);
    bubbleEls.current.forEach((el) => {
      if (!el) return;
      const bottom = el.getBoundingClientRect().bottom;
      const t = Math.min(1, Math.max(0, (bottom - midY) / span));
      // 直接写 DOM style，避免滚动时触发 React 重渲染
      el.style.opacity = String(t);
    });
  };

  useEffect(() => {
    midYRef.current = window.innerHeight / 2;
    updateBubbleOpacity();
    const onScroll = () => updateBubbleOpacity();
    const onResize = () => {
      midYRef.current = window.innerHeight / 2;
      updateBubbleOpacity();
    };
    const scrollEl = listScrollRef.current;
    scrollEl?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    // 消息/文本变化（含流式增长）后重算一次
    const raf = requestAnimationFrame(() => updateBubbleOpacity());
    return () => {
      scrollEl?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  return (
    // 外层：全屏黑底（图片未加载/等比缩放时的兜底），画布居中
    <Box className="flex h-dvh w-full items-center justify-center overflow-hidden bg-black">
      {/* 画布：宽高严格等于背景图 contain 后的尺寸（页面高度匹配图片比例），
          聊天 UI 全部在此画布内 flex 自适应生成大小 */}
      <Box
        className="relative flex h-full w-full max-w-full max-h-full flex-col overflow-hidden"
        style={{
          width: canvas?.w,
          height: canvas?.h,
          aspectRatio: canvas ? 'auto' : undefined,
        }}
      >
        {/* Z-0 渐变背景（画布内兜底底色） */}
        <div className="absolute inset-0 z-0 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950" />

        {/* Z-1 背景图/数字人：画布内铺满（画布比例=图片比例，object-cover 不裁剪、不变形） */}
        <Avatar variant="background" />

        {/* Z-2 暗色蒙版：轻量渐变，保证透明气泡/字幕在任意画面上可读 */}
        <div className="pointer-events-none absolute inset-0 z-[5] bg-gradient-to-t from-black/65 via-black/30 to-black/50" />

        {/* Z-10 内容列 */}
        <Box className="relative z-10 flex h-full w-full flex-col">
        {/* 顶部栏（玻璃风） */}
        <Box className="flex items-center justify-between border-b border-white/10 bg-white/10 px-4 py-2 backdrop-blur-md">
          <Typography variant="h6" className="!font-semibold !text-white">
            小智
          </Typography>
          <Box className="flex items-center gap-1">
            <span
              className={`h-2 w-2 rounded-full ${
                xzReady ? 'bg-green-400' : connecting || reconnecting ? 'bg-amber-400' : 'bg-white/40'
              }`}
              aria-hidden="true"
            />
            <Typography variant="caption" className="!text-white/70">
              {xzReady ? '已连接' : reconnecting ? '重连中…' : connecting ? '连接中…' : '未连接'}
            </Typography>
            <IconButton
              size="small"
              className="!text-white"
              sx={TOUCH_SX}
              onClick={() => setSettingsOpen(true)}
              aria-label="打开设置"
              title="设置"
            >
              <SettingsIcon fontSize="small" />
            </IconButton>
          </Box>
        </Box>

        {/* 上半部分留白：让数字人主体在画布上半部清晰可见（随画布 flex 伸缩） */}
        <Box className="min-h-0 flex-1" />

        {/* 消息列表：占画布剩余空间（flex 自适应），气泡从底部向上排布；
            由下往上逐渐透明（按页面垂直位置实时计算，到页面中间完全透明）。
            内层 min-h-full + justify-end：消息少时贴底、消息多时充满并向上滚动。 */}
        <Box ref={listScrollRef} className="min-h-0 flex-[1.1] overflow-y-auto px-4 pb-4 pt-2">
          <Box className="flex min-h-full flex-col justify-end space-y-3">
            {messages.map((m, index) => {
              const isUser = m.role === 'user';
              const segments = isUser ? [m.text] : splitLongText(m.text);
              return (
                <Box
                  key={m.id}
                  ref={(el) => {
                    bubbleEls.current[index] = el as HTMLDivElement | null;
                  }}
                  className={`flex ${isUser ? 'justify-end' : 'items-start gap-2'}`}
                >
                  {/* 数字人侧：暖色小头像（呼应 digital_human 的 Lily 头像） */}
                  {!isUser && (
                    <span
                      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-300 to-amber-500 text-[13px] font-bold !text-white shadow-[0_0_10px_rgba(252,211,77,0.45)]"
                      aria-hidden="true"
                    >
                      智
                    </span>
                  )}
                  <Box className={`flex max-w-[82%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                    {segments.map((seg, idx) => (
                      <div
                        key={isUser ? m.id : `${m.id}-seg-${idx}`}
                        className={[
                          'mb-1 px-4 py-2 transition-all duration-300',
                          // 透明气泡：浅暖色描边 + 极淡暖色填充 + 暖色外发光，保证边缘在任意背景上清晰可见
                          isUser
                            ? 'rounded-[20px] rounded-br-[6px] border-2 border-amber-200/80 bg-amber-300/[0.08]'
                            : 'rounded-[20px] rounded-tl-[6px] border-2 border-orange-200/70 bg-orange-300/[0.07]',
                        ].join(' ')}
                        style={{
                          boxShadow: isUser
                            ? '0 0 0 1px rgba(252,211,77,0.35), 0 2px 18px rgba(251,191,36,0.30)'
                            : '0 0 0 1px rgba(253,186,116,0.30), 0 2px 18px rgba(251,146,60,0.26)',
                        }}
                      >
                        <Typography
                          variant="body1"
                          className="!text-white"
                          style={{
                            whiteSpace: 'pre-wrap',
                            fontWeight: 500,
                            lineHeight: 1.4,
                            textShadow: '0 2px 8px rgba(0,0,0,0.55)',
                          }}
                        >
                          {seg}
                        </Typography>
                      </div>
                    ))}
                  </Box>
                </Box>
              );
            })}
            <div ref={listEndRef} />
          </Box>
        </Box>

        {/* 输入区（玻璃风） */}
        <Box className="flex items-center gap-2 border-t border-white/10 bg-white/10 p-3 backdrop-blur-md">
          <IconButton
            className="!text-white"
            color={recording ? 'error' : 'default'}
            sx={TOUCH_SX}
            onClick={toggleRecord}
            aria-label={recording ? '停止录音' : '开始语音输入'}
            title={recording ? '停止录音' : '语音输入'}
          >
            {recording ? <StopIcon /> : <MicIcon />}
          </IconButton>
          <TextField
            fullWidth
            size="small"
            placeholder={speaking ? '小智正在说话…' : '输入消息，或按住麦克风说话'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendText();
            }}
            inputProps={{ 'aria-label': '输入发送给小智的消息' }}
            sx={{
              '& .MuiInputBase-input': { color: '#fff' },
              '& .MuiInputBase-input::placeholder': { color: 'rgba(255,255,255,0.6)', opacity: 1 },
              '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.25)' },
              '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.4)' },
              '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.55)' },
            }}
          />
          <IconButton
            className="!text-white"
            color="primary"
            sx={TOUCH_SX}
            onClick={sendText}
            disabled={!text.trim()}
            aria-label="发送消息"
            title="发送"
          >
            <SendIcon />
          </IconButton>
        </Box>

        <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </Box>
      </Box>
    </Box>
  );
}
