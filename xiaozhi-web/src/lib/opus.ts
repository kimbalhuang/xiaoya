/**
 * Opus 编解码封装（基于 WASM）。
 *
 * 说明：虾哥云小智返回的是「裸 Opus 数据包」（RFC 6716），无长度前缀；
 * 一条 WS 二进制消息即一个完整裸 Opus 帧。因此这里采用非 scoped 包
 * opus-decoder / opus-recorder（裸 Opus 编解码，基于 WASM，社区成熟方案，
 * 已从 npm 确认存在）。
 *
 * 解码：opus-decoder 具名导出 OpusDecoder，构造后 WASM 异步加载，
 * 必须 await decoder.ready 后再调用 decode。
 * 编码：opus-recorder 提供 Recorder / Encoder（worker 线程异步回调模型），
 * Encoder 通过 onmessage 回调返回编码结果，本模块已封装为 Promise。
 *
 * 若音频为 Ogg 容器格式，可改用 ogg-opus-decoder / ogg-opus-encoder
 * （接口类似），接口保持一致。
 */
export class OpusCodec {
  private readonly sampleRate: number;
  private readonly channels: number;
  private decoderPromise: Promise<any> | null = null;
  private encoderPromise: Promise<any> | null = null;

  constructor(sampleRate = 16000, channels = 1) {
    this.sampleRate = sampleRate;
    this.channels = channels;
  }

  private async getDecoder(): Promise<any> {
    if (!this.decoderPromise) {
      this.decoderPromise = import('opus-decoder').then(async (m: any) => {
        // opus-decoder 具名导出 OpusDecoder；兼容 default
        const Decoder = m.OpusDecoder || m.default;
        const decoder = new Decoder({
          sampleRate: this.sampleRate,
          channels: this.channels,
          forceStereo: false,
        });
        // WASM 异步加载，必须 ready 后才能调用 decode
        await decoder.ready;
        return decoder;
      });
    }
    return this.decoderPromise;
  }

  /**
   * 获取（并缓存）已就绪的 Opus 编码器。
   *
   * opus-recorder 是异步回调模型：Encoder 在 worker 线程中编码，
   * 结果通过 onmessage 回调返回（encode() 不直接返回结果）。
   * 这里只负责构造实例并返回，真正的 Promise 封装在 encode() 中完成。
   */
  private getEncoder(): Promise<any> {
    if (!this.encoderPromise) {
      this.encoderPromise = import('opus-recorder').then(async (m: any) => {
        // opus-recorder 具名导出 Encoder（另有 Recorder，我们只需要编码）
        const Encoder = m.Encoder || m.default;
        const enc = new Encoder({
          sampleRate: this.sampleRate,
          channels: this.channels,
          frameDuration: 60,          // ms，与小智 audio_params.frame_duration=60 对齐
          encoderSampleRate: this.sampleRate, // 输入 PCM 采样率
          streamPages: false,         // 逐帧输出裸 Opus 帧（不封装 Ogg 页面）
        });
        // opus-recorder 内部依赖 worker 线程，构造后给一个极短延迟，
        // 让内部 worker 完成启动，避免紧随其后的 encode() 丢失消息。
        await new Promise((resolve) => setTimeout(resolve, 50));
        return enc;
      });
    }
    return this.encoderPromise;
  }

  /** 解码裸 Opus 包 → 单声道 Float32 PCM */
  async decode(frame: Uint8Array): Promise<Float32Array> {
    const decoder = await this.getDecoder();
    const res = decoder.decodeFrame(frame);
    const channelData: Float32Array[] = res.channelData || (res.float32 ? [res.float32] : []);
    return channelData[0] || new Float32Array(0);
  }

  /**
   * 预热解码器：在用户手势内/应用启动早期调用，提前完成
   * `import('opus-decoder')` + `await decoder.ready`（WASM 异步加载）。
   * 避免第一条 TTS 音频帧到达时才走这条长链路，导致首句语音明显晚于文字出现。
   */
  async warmup(): Promise<void> {
    try {
      await this.getDecoder();
    } catch (_) {
      /* 解码器不可用由 decode() 降级处理，warmup 不抛错 */
    }
  }

  /**
   * 编码单声道 Float32 PCM → 裸 Opus 帧。
   *
   * opus-recorder 为异步回调模型（worker 线程），encode() 不直接返回结果，
   * 结果通过 onmessage 回调拿到。这里把「设置一次性回调 + 调用 encode」封装成
   * Promise，保持本类 encode() 返回 Promise<Uint8Array> 的同步形态。
   */
  async encode(pcm: Float32Array): Promise<Uint8Array> {
    const enc = await this.getEncoder();
    return new Promise<Uint8Array>((resolve, reject) => {
      const onMsg = (e: any) => {
        enc.onmessage = null; // 一次性回调，避免泄漏 / 串帧
        resolve(e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data));
      };
      enc.onmessage = onMsg;
      try {
        // 传入 PCM 的底层 ArrayBuffer（Float32 单声道）
        enc.encode(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
      } catch (err) {
        enc.onmessage = null;
        reject(err);
      }
    });
  }
}

/** 默认编解码器：16k / 单声道（与小智 audio_params 对齐） */
export const opusCodec = new OpusCodec(16000, 1);
