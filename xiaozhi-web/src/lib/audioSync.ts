import { audioPlayer } from './audio';

/**
 * 音频协调：以「真实带声视频是否在播」为唯一开关的 TTS 路由。
 *
 * 设计目标：以「数字人为准」（接受延迟），保证用户**一定能听到 AI 的语音**。
 * - 默认（2D / 实时语音模式）：TTS 帧实时播放（AudioPlayer）。
 * - 本地推理可用（mode=live，等待数字人视频生成）：TTS 帧缓冲不播，等视频就绪后由视频音轨
 *   输出（口型同步）；视频播完 / 播放失败 / 降级 2d / 用户打断时，把缓冲帧补播，用户仍听到完整回复。
 * - 视频被浏览器自动播放策略强制静音时：恢复 TTS 实时播放（此时视频无声，由 TTS 提供语音）。
 *
 * 注意：数字人 mode(live/2d) 本身**不再**决定是否静音 TTS（live 待机态无音轨，若按 mode 静音会
 * 导致「画面在、没声音」）；「是否缓冲 TTS」由 videoActive 统一控制——
 *   置 true：缓冲（等待视频 / 视频带声在播）；置 false：实时播放 + 补播缓冲。
 *
 * 可配置项（preferVideoAudio，默认 true）：
 * - true（以数字人为准）：本地 FlashHead 视频带声时，仅播放视频音轨，缓冲的 TTS 不重播（防重复）。
 * - false（以原始 TTS 为准）：始终实时播放小智原始 TTS，数字人视频强制静音，避免与视频音轨双声。
 * 由后端启动配置（FLASHHEAD_AUDIO_SYNC，默认 true）下发默认值；用户可在设置页本地覆盖（localStorage）。
 */
const STORAGE_KEY = 'xiaoya.audioSync.preferVideoAudio';

export class AudioSync {
  private videoActive = false; // 真实带声视频是否正在播放
  private pending: Uint8Array[] = [];
  private onInterrupt: (() => void) | null = null; // 打断回调（如暂停 live 视频音轨）
  /** 是否以数字人视频音轨为准（默认 true）。false 时改用原始 TTS 语音为准、视频强制静音。 */
  private preferVideoAudio: boolean;

  constructor() {
    // 本地用户覆盖优先；无覆盖则用默认 true（以数字人为准）
    const stored =
      typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    this.preferVideoAudio = stored === null ? true : stored === 'true';
  }

  /** 当前是否以数字人视频音轨为准（供 Avatar 决定是否静音视频） */
  getPreferVideoAudio(): boolean {
    return this.preferVideoAudio;
  }

  /**
   * 配置音频优先级。
   * @param preferVideoAudio true=以数字人视频为准；false=以原始 TTS 为准。
   * @param persist 是否持久化到 localStorage（用户手动切换时传 true；后端下发默认值时传 false）。
   */
  configure(opts: { preferVideoAudio: boolean; persist?: boolean }): void {
    this.preferVideoAudio = !!opts.preferVideoAudio;
    if (opts.persist && typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, String(this.preferVideoAudio));
    }
  }

  /**
   * 注册打断回调（如暂停 live 视频音轨）；传 null 取消。
   * 由数字人组件注册，用户主动打断时统一触发。
   */
  setOnInterrupt(cb: (() => void) | null): void {
    this.onInterrupt = cb;
  }

  /**
   * 用户主动打断（继续输入 / 按麦克风）：立即停止当前播放，清空缓冲，不补播。
   * - 停掉正在播的 TTS 语音
   * - 恢复 TTS 实时路由（videoActive=false，后续帧直接播，不与暂停的视频叠加）
   * - 触发打断回调（暂停 live 视频音轨）
   */
  interrupt(): void {
    this.pending = []; // 缓冲作废，不补播
    this.videoActive = false; // 恢复 TTS 实时播放
    audioPlayer.stop(); // 停掉当前 TTS 语音
    this.onInterrupt?.(); // 暂停 live 视频音轨
  }

  /**
   * 设置「真实带声视频」播放状态。
   * - active=true：缓冲后续 TTS 帧（视频音轨已覆盖当前语句，作废旧缓冲避免重播）。
   * - active=false：恢复 TTS 实时播放，并把缓冲的帧补播（顺序入队，AudioPlayer 自带顺序排布）。
   * 若以原始 TTS 为准（preferVideoAudio=false），视频音轨不参与调度，始终实时播放 TTS。
   */
  setVideoActive(active: boolean): void {
    // 以原始 TTS 为准：视频音轨不参与，永远实时播放 TTS，不缓冲
    if (!this.preferVideoAudio) {
      this.videoActive = false;
      return;
    }
    if (active) {
      if (!this.videoActive) this.pending = []; // 视频音轨覆盖当前语句，缓冲作废
      this.videoActive = true;
    } else {
      this.videoActive = false;
      this.flush();
    }
  }

  /** 收到 TTS 音频帧：视频带声在播则缓冲，否则实时播放 */
  push(frame: Uint8Array): void {
    // 以原始 TTS 为准（preferVideoAudio=false）时，无视视频状态，始终实时播放 TTS
    if (this.preferVideoAudio && this.videoActive) {
      this.pending.push(frame);
    } else {
      void audioPlayer.enqueue(frame);
    }
  }

  /**
   * 视频（带声）正常播放结束：视频音轨已完整覆盖本段 TTS 音频，
   * 缓冲的 TTS 与之完全重复，直接丢弃，**绝不补播**，避免"语音重复播放"。
   * 仅当视频被静音/播放失败（音轨未送达）而降级时，才用 setVideoActive(false) 补播 TTS。
   */
  endVideo(): void {
    this.pending = [];
    this.videoActive = false;
  }

  /** 视频就绪（自带音轨）：缓冲作废（不重播） */
  clear(): void {
    this.pending = [];
  }

  /** 降级补播：顺序入队播放并清空 */
  private flush(): void {
    const frames = this.pending;
    this.pending = [];
    for (const f of frames) void audioPlayer.enqueue(f);
  }
}

export const audioSync = new AudioSync();
