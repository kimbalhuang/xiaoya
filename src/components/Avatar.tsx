import { useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import Hls from 'hls.js';
import { useChatStore } from '../store/chatStore';
import { emotionToExpression } from '../types';
import { audioPlayer } from '../lib/audio';
import { audioSync } from '../lib/audioSync';

/**
 * 数字人头像组件。
 * - 连接 /avatar 后发送本地人像 xiaoya.png（portrait 消息），作为 FlashHead 人像输入（预留给后续真实推理）
 * - 模式 live：连接 /avatar，接收后端推送的实时视频帧（jpg/webm 块）渲染
 * - 模式 2d：实时语音模式（本地推理不可用时），以 xiaoya.png 真人人像为底图呼吸动画，按 emotion 显示表情光环/抖动特效，说话时呼吸
 */
export default function Avatar({ variant = 'box' }: { variant?: 'box' | 'background' }) {
  const emotion = useChatStore((s) => s.emotion);
  // 数字人尺寸：box = 原小头像；background = 全屏背景层（数字人作为背景显示）
  const isBg = variant === 'background';
  const boxCls = isBg
    ? 'absolute inset-0 h-full w-full overflow-hidden bg-black'
    : 'relative h-40 w-40 overflow-hidden rounded-2xl bg-black shadow-lg sm:h-48 sm:w-48 md:h-56 md:w-56';
  const mediaCls = isBg
    ? 'h-full w-full object-cover'
    : 'h-40 w-40 object-cover sm:h-48 sm:w-48 md:h-56 md:w-56';
  const speaking = useChatStore((s) => s.speaking);
  const [mode, setMode] = useState<'live' | '2d'>('2d');
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  // HLS 流地址（后端 {type:'video',url} 控制消息下发）。SoulX FlashHead 返回 m3u8，
  // 前端用 <video> + hls.js 流式播放（口型/表情随音频逐段渲染）
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  // 每次收到 video 消息自增，作为 <video key> 强制重建播放器（即使 URL 与上一段相同）
  const [videoSeq, setVideoSeq] = useState(0);
  // 视频声音开关状态：初始 false（尝试有声自动播放，口型与声音同步）；
  // 若被浏览器自动播放策略拦截则降级静音播放（不显示开声按钮，保持画面纯净）
  const [videoMuted, setVideoMuted] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // 当前 hls.js 实例（换 URL / 卸载时须 destroy，避免泄漏与旧媒体源残留）
  const hlsRef = useRef<{ destroy: () => void } | null>(null);

  // 视频起播辅助：优先带声自动播放（口型与音轨同步）；
  // 若被浏览器自动播放策略拦截，则降级为静音自动播放（保证视频正常播放，画面纯净）
  const tryPlay = (videoEl: HTMLVideoElement) => {
    videoEl.muted = false;
    setVideoMuted(false);
    videoEl
      .play()
      .then(() => {
        // 视频确实带声起播 → 缓冲 TTS（避免与视频音轨双重声音）
        audioSync.setVideoActive(!videoEl.muted);
      })
      .catch(() => {
        // 被自动播放策略拦截 → 降级静音播放；静音视频无声音，仍由 TTS 提供语音
        videoEl.muted = true;
        setVideoMuted(true);
        videoEl
          .play()
          .then(() => {
            audioSync.setVideoActive(!videoEl.muted); // muted→false→TTS 播放
          })
          .catch(() => {});
      });
  };

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/avatar`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    // 注册打断回调：用户主动打断（继续输入 / 按麦克风）时暂停真实带声视频音轨
    audioSync.setOnInterrupt(() => {
      if (videoRef.current) videoRef.current.pause();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // 连接建立后：加载 /xiaoya.png 转成 dataURL，作为 portrait 消息发给后端
    // （FlashHead 人像输入，预留给后续真实推理；失败仅告警，不影响主流程）
    ws.onopen = () => {
      fetch('/xiaoya.png')
        .then((res) => {
          if (!res.ok) throw new Error(`加载 /xiaoya.png 失败: ${res.status}`);
          return res.blob();
        })
        .then(
          (blob) =>
            new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(new Error('FileReader 读取失败'));
              reader.readAsDataURL(blob);
            }),
        )
        .then((dataURL) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'portrait', image: dataURL }));
          }
        })
        .catch((err: unknown) => {
          console.warn('[avatar] 发送 portrait 人像失败：', err);
        });
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'mode') {
            setMode(msg.mode);
            // live = 本地推理可用，进入"等视频"模式：TTS 帧缓冲不播（以数字人为准，接受延迟）。
            // 视频就绪后由 tryPlay 维持缓冲；降级 2d 时恢复实时播放并补播缓冲，保证用户听到完整回复。
            if (msg.mode === 'live') audioSync.setVideoActive(true);
            else if (msg.mode === '2d') audioSync.setVideoActive(false);
          } else if (msg.type === 'error') {
            setMode('2d');
            audioSync.setVideoActive(false);
          }
          else if (msg.type === 'video' && msg.url) {
            // 后端下发 HLS 流地址：切换 live 并交给 <video> + hls.js 播放。
            // 即使 URL 与上一段相同也自增 seq，强制重建播放器（key 变化）确保重新起播。
            // 先停掉可能仍在播的旧 TTS 语音（audioPlayer 单例），避免与新视频音轨叠加；
            // 是否继续静音 TTS 由 tryPlay 依据「视频实际是否带声起播」决定（见下）。
            audioPlayer.stop();
            setMode('live');
            setVideoUrl(msg.url);
            setVideoSeq((s) => s + 1);
          }
        } catch (_) {
          /* ignore */
        }
        return;
      }
      // 二进制视频帧（jpg / webm chunk）
      const blob = new Blob([ev.data as ArrayBuffer], { type: 'image/jpeg' });
      const u = URL.createObjectURL(blob);
      const prev = frameUrlRef.current;
      frameUrlRef.current = u;
      setFrameUrl((old) => {
        if (old && old !== prev) URL.revokeObjectURL(old);
        return u;
      });
      setMode('live');
    };
    ws.onclose = () => {
      /* 可加重连逻辑 */
    };

    return () => {
      ws.close();
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
      audioSync.setOnInterrupt(null); // 取消打断回调注册
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // HLS 播放：hls.js 已本地打包（npm 依赖，不依赖 CDN，国内网络稳定可用），
  // 支持 Chrome/Edge 等原生不播 m3u8 的浏览器；Safari 回退原生 HLS。
  useEffect(() => {
    if (!videoUrl) return;
    const videoEl = videoRef.current;
    if (!videoEl) return;

    let disposed = false; // 组件卸载/换 URL 后防止异步 onload 继续操作

    // 销毁旧的 hls.js 实例（换 URL / 卸载时调用）
    const teardown = () => {
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch (_) {
          /* noop */
        }
        hlsRef.current = null;
      }
    };
    teardown();

    // 开始播放：优先 hls.js（MSE），否则回退浏览器原生 HLS（Safari），再不行降级 2D
    const start = () => {
      if (disposed) return;
      if (Hls.isSupported()) {
        const hls = new Hls();
        hlsRef.current = hls;
        hls.loadSource(videoUrl);
        hls.attachMedia(videoEl);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // 媒体清单解析就绪后立即起播（媒体源已就绪，无需用户手势；失败静默，
          // 等待用户手势或 onCanPlay 兜底，play() 幂等，重复调用无副作用）。
          // 优先带声起播，被自动播放策略拦截时 tryPlay 内部降级静音播放
          tryPlay(videoEl);
        });
        hls.on(Hls.Events.ERROR, (_evt: unknown, data: any) => {
          // 致命错误（如 m3u8 不可访问）→ 销毁实例并降级 2D，避免一直黑屏
          if (data && data.fatal) {
            console.warn('[avatar] HLS 播放错误，降级 2D:', data.details);
            teardown();
            setMode('2d');
            setVideoUrl(null);
          }
        });
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari 等原生支持 HLS：直接赋 src 交给浏览器播放
        videoEl.src = videoUrl;
        // 赋 src 后立即尝试起播（失败静默，交给 onCanPlay 兜底）；优先带声，被拦截则静音降级
        tryPlay(videoEl);
      } else {
        console.warn('[avatar] 浏览器不支持 HLS，降级 2D');
        setMode('2d');
        setVideoUrl(null);
      }
    };

    // hls.js 为本地依赖（静态 import），直接启动
    start();

    return () => {
      disposed = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, videoSeq]);

  // 新 TTS 语音打断旧视频：新回复开始（speaking 变 true）时暂停旧数字人视频画面，
  // 等待新 video 消息重建播放器，避免旧画面口型/表情对不上新语音。
  // 无需 resume —— 新 video 消息会重建播放器并重新起播。
  useEffect(() => {
    if (speaking && videoRef.current && mode === 'live') {
      videoRef.current.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaking]);

  // 优先 HLS 流式播放（后端下发 m3u8 URL，live 模式）。默认尝试带声自动播放（口型与音轨同步）；
  // 若被浏览器自动播放策略拦截则由 tryPlay 降级为 muted 静音播放；不显示 controls（隐藏播放键/进度条），
  // 也不再显示声音开关按钮（画面纯净）。onError 兜底降级 2D；onEnded 播完回 2D 呼吸场景。
  if (mode === 'live' && videoUrl) {
    return (
      <Box className={boxCls}>
        <video
          key={videoSeq}
          ref={videoRef}
          autoPlay
          muted={videoMuted}
          playsInline
          className="h-full w-full object-cover"
          onCanPlay={() => {
            // onCanPlay 兜底起播：防 MANIFEST_PARSED 回调时机过早导致未起播。
            // 仅当已暂停时才调 play()（play() 幂等，失败静默不重试，无死循环）
            if (videoRef.current && videoRef.current.paused) {
              tryPlay(videoRef.current);
            }
          }}
          onEnded={() => {
            // 视频播完：恢复 TTS 实时播放（补播缓冲），并回到 2D 呼吸场景
            audioSync.setVideoActive(false);
            setMode('2d');
            setVideoUrl(null);
          }}
          onError={() => {
            console.warn('[avatar] 视频播放失败，降级 2D');
            audioSync.setVideoActive(false);
            setMode('2d');
            setVideoUrl(null);
          }}
        />
      </Box>
    );
  }

  // 等待占位：live 模式已激活但 HLS 视频源尚未下发（后端推理需数分钟）。
  // 渲染纯净 xiaoya.png 全图 + 呼吸动画（与 2D 呼吸场景观感一致），无文字/遮罩叠加，
  // 避免 mode=live 但无视频源时空白/黑屏，让用户误以为功能无响应。
  if (mode === 'live' && !videoUrl && !frameUrl) {
    return (
      <Box className={boxCls}>
        <img
          src="/xiaoya.png"
          alt="数字人"
          className={mediaCls}
          style={{ animation: 'breatheIdle 4s ease-in-out infinite' }}
        />
      </Box>
    );
  }

  if (mode === 'live' && frameUrl) {
    return (
      <Box className={boxCls}>
        <img src={frameUrl} alt="数字人" className={mediaCls} />
      </Box>
    );
  }

  // 实时语音模式头像（本地推理不可用时，xiaoya.png 呼吸动画）
  return <Avatar2D expression={emotionToExpression(emotion)} speaking={speaking} boxCls={boxCls} mediaCls={mediaCls} />;
}

/**
 * expression → 视觉反馈映射（边框/光环色调 + 可选附加动画）。
 * 7 种表情全覆盖；未知值回退 calm（无特效）。
 */
const EXPRESSION_FX: Record<string, { ringColor: string; glow: string; anim?: string }> = {
  smile: { ringColor: '#fcd34d', glow: '0 0 30px rgba(252, 211, 77, 0.6)' }, // 暖橙：开心
  frown: { ringColor: '#94a3b8', glow: '0 0 30px rgba(148, 163, 184, 0.55)' }, // 蓝灰：难过
  wide: { ringColor: '#fde047', glow: '0 0 30px rgba(253, 224, 71, 0.6)' }, // 亮黄：惊讶
  tight: { ringColor: '#ef4444', glow: '0 0 30px rgba(239, 68, 68, 0.6)' }, // 红：生气
  tremble: { ringColor: '#c084fc', glow: '0 0 30px rgba(192, 132, 252, 0.6)', anim: 'tremble 0.3s infinite' }, // 紫+抖动：恐惧
  grimace: { ringColor: '#b91c1c', glow: '0 0 30px rgba(185, 28, 28, 0.65)' }, // 深红：厌恶
  calm: { ringColor: 'transparent', glow: 'none' }, // 默认：无特效
};

function Avatar2D({
  expression,
  speaking,
  boxCls,
  mediaCls,
}: {
  expression: string;
  speaking: boolean;
  boxCls: string;
  mediaCls: string;
}) {
  const fx = EXPRESSION_FX[expression] ?? EXPRESSION_FX.calm;
  // 待机柔光氛围：calm（无表情特效）且非说话时，用淡紫呼吸光晕替代"无阴影"，
  // 让数字人在待机时也有"活着"的氛围；说话时仍走表情光环（ring/glow），视觉让位于表情反馈
  const boxShadow =
    fx.ringColor === 'transparent' && !speaking
      ? '0 0 30px rgba(147, 112, 219, 0.28)'
      : [fx.ringColor === 'transparent' ? '' : `0 0 0 4px ${fx.ringColor}`, fx.glow === 'none' ? '' : fx.glow]
          .filter(Boolean)
          .join(', ') || undefined;

  return (
    <Box
      className={`${boxCls} transition-all duration-300`}
      style={{
        boxShadow,
        animation: fx.anim, // 仅 tremble 表情时整体轻微左右抖动
      }}
    >
      {/* 实时语音模式底图：xiaoya.png 真人人像；说话时用 scale 呼吸代替 opacity 脉动，避免闪烁刺眼 */}
      <img
        src="/xiaoya.png"
        alt="数字人"
        className={mediaCls}
        style={{ animation: speaking ? 'breathe 2s ease-in-out infinite' : 'breatheIdle 4s ease-in-out infinite' }}
      />
      {/* 组件级 @keyframes（避免污染全局 CSS） */}
      <style>{`
        @keyframes breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.02); }
        }
        @keyframes breatheIdle {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.035); }
        }
        @keyframes tremble {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-1.5px); }
          75% { transform: translateX(1.5px); }
        }
      `}</style>
    </Box>
  );
}
