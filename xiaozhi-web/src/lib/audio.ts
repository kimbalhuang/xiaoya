/**
 * 音频播放与采集。
 * - AudioPlayer：裸 Opus 帧 → 解码 PCM → WebAudio 顺序播放（保证口型/语音同步）
 * - AudioRecorder：麦克风采集 16k/16bit/单声道 PCM → 缓存为 60ms 帧 → Opus 编码 → 回调
 */
import { OpusCodec, opusCodec } from './opus';

const TARGET_SAMPLE_RATE = 16000;
const CHANNELS = 1;
const OPUS_FRAME_SAMPLES = 960; // 60ms @ 16k，合法的 Opus 帧长

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private readonly codec: OpusCodec;
  private scheduledUntil = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private resumePromise: Promise<void> | null = null;

  constructor(codec: OpusCodec = opusCodec) {
    this.codec = codec;
  }

  private ensureContext(): void {
    if (!this.ctx) {
      const Ctx: typeof AudioContext =
        window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctx();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1.0;
      this.gain.connect(this.ctx.destination);
    }
  }

  async resume(): Promise<void> {
    this.ensureContext();
    if (this.ctx && this.ctx.state === 'suspended') {
      // 缓存 Promise：并发 enqueue 不会各自触发一次 resume（重复 suspend 抖动）
      if (!this.resumePromise) {
        this.resumePromise = this.ctx.resume().catch(() => undefined);
      }
      await this.resumePromise;
    }
  }

  /**
   * 预热播放链路：必须在「用户手势」调用栈内调用（发消息 / 按麦克风），
   * 让 AudioContext 此刻就处于 running 状态、Opus 解码器 WASM 已就绪。
   * 之后 TTS 二进制帧到达时无需再走「创建上下文 → resume → 加载 WASM」长链路，
   * 从而消除「文字先出、语音很久才到」的首句延迟。
   */
  warmup(): void {
    void this.resume();
    void this.codec.warmup();
  }

  /** 入队一段裸 Opus 音频帧进行播放 */
  async enqueue(opusFrame: Uint8Array): Promise<void> {
    // 快速路径：上下文已处于 running 时不再 await resume()（每次入队省一个微任务等待），
    // 降低连续 TTS 帧的调度延迟；仅当上下文尚未就绪/被挂起时才走完整 resume 链路。
    if (!this.ctx || this.ctx.state !== 'running') {
      await this.resume();
    }
    let pcm: Float32Array;
    try {
      pcm = await this.codec.decode(opusFrame);
    } catch (e) {
      console.error('[AudioPlayer] Opus 解码失败', e);
      return;
    }
    if (!pcm || pcm.length === 0) return;
    this.schedule(pcm);
  }

  private schedule(pcm: Float32Array): void {
    if (!this.ctx || !this.gain) return;
    const ctx = this.ctx;
    const buffer = ctx.createBuffer(CHANNELS, pcm.length, TARGET_SAMPLE_RATE);
    buffer.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    // 顺序排布，避免帧间空隙导致卡顿
    const startAt = Math.max(ctx.currentTime, this.scheduledUntil);
    src.start(startAt);
    this.scheduledUntil = startAt + pcm.length / TARGET_SAMPLE_RATE;
    this.activeSources.push(src);
    src.onended = () => {
      this.activeSources = this.activeSources.filter((s) => s !== src);
    };
  }

  /** 停止播放并清空待播放队列 */
  stop(): void {
    this.activeSources.forEach((s) => {
      try {
        s.stop();
      } catch (_) {
        /* noop */
      }
    });
    this.activeSources = [];
    if (this.ctx) this.scheduledUntil = this.ctx.currentTime;
  }
}

export class AudioRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private readonly codec: OpusCodec;
  private pcmBuffer = new Float32Array(0);
  private onFrame: ((opus: Uint8Array) => void) | null = null;
  private recording = false;

  constructor(codec: OpusCodec = opusCodec) {
    this.codec = codec;
  }

  /** 开始录音；每产生一个 60ms Opus 帧回调 onFrame */
  async start(onFrame: (opus: Uint8Array) => void): Promise<void> {
    this.onFrame = onFrame;
    this.recording = true;
    this.pcmBuffer = new Float32Array(0);

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: TARGET_SAMPLE_RATE,
        channelCount: CHANNELS,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const Ctx: typeof AudioContext =
      window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new Ctx({ sampleRate: TARGET_SAMPLE_RATE });
    this.source = this.ctx.createMediaStreamSource(this.stream);

    // 使用 ScriptProcessor 采集 PCM。需连接到 destination 才会触发 onaudioprocess，
    // 但此处不把麦克风声音写入输出（静音），避免回声。
    this.processor = this.ctx.createScriptProcessor(4096, CHANNELS, CHANNELS);
    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (!this.recording) return;
      const input = e.inputBuffer.getChannelData(0);
      this.appendAndEmit(input);
    };
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
  }

  private appendAndEmit(chunk: Float32Array): void {
    const merged = new Float32Array(this.pcmBuffer.length + chunk.length);
    merged.set(this.pcmBuffer, 0);
    merged.set(chunk, this.pcmBuffer.length);
    this.pcmBuffer = merged;

    while (this.pcmBuffer.length >= OPUS_FRAME_SAMPLES) {
      const frame = this.pcmBuffer.subarray(0, OPUS_FRAME_SAMPLES);
      const pcm = new Float32Array(frame); // 拷贝，避免被后续 subarray 覆盖
      this.codec
        .encode(pcm)
        .then((opus) => this.onFrame?.(opus))
        .catch((e) => console.error('[AudioRecorder] 编码失败', e));
      this.pcmBuffer = this.pcmBuffer.subarray(OPUS_FRAME_SAMPLES);
    }
  }

  stop(): void {
    this.recording = false;
    if (this.processor && this.source) {
      try {
        this.source.disconnect();
        this.processor.disconnect();
      } catch (_) {
        /* noop */
      }
      this.processor = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.source = null;
    this.pcmBuffer = new Float32Array(0);
  }
}

/** 全局播放器单例 */
export const audioPlayer = new AudioPlayer();
