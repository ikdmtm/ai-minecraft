import type { EventEmitter } from 'events';

export interface FFmpegConfig {
  display: string;
  resolution: string;
  fps: number;
  videoBitrate: string;
  audioBitrate: string;
  rtmpUrl: string;
  pulseAudioSource: string;
  avatarBasePath: string;
  avatarPipePath: string;
  avatarWidth: number;
  avatarHeight: number;
  avatarFps: number;
}

export interface FFmpegProcess {
  pid: number | undefined;
  kill(signal?: string): boolean;
  on(event: string, listener: (...args: any[]) => void): void;
  stderr: { on(event: string, listener: (...args: any[]) => void): void };
}

export interface ProcessSpawner {
  spawn(command: string, args: string[]): FFmpegProcess;
}

interface FFmpegManagerOptions {
  onExit?: (code: number | null) => void;
}

/**
 * FFmpeg のコマンドライン引数を構築する。
 * x11grab → Minecraft 画面キャプチャ
 * pulse → PulseAudio combined_sink
 * libx264 ultrafast → CPU エンコード（負荷最小）
 * overlay → アバター合成用の filter_complex
 */
export function buildFFmpegArgs(config: FFmpegConfig): string[] {
  return [
    // Input 0: Video (X11 screen capture)
    '-f', 'x11grab',
    '-framerate', String(config.fps),
    '-video_size', config.resolution,
    '-i', config.display,

    // Input 1: Audio (PulseAudio combined sink)
    '-f', 'pulse',
    '-i', config.pulseAudioSource,

    // Input 2: Avatar (raw RGBA from named pipe, written by avatar-writer.sh)
    '-f', 'rawvideo',
    '-pixel_format', 'rgba',
    '-video_size', `${config.avatarWidth}x${config.avatarHeight}`,
    '-framerate', String(config.avatarFps),
    '-i', config.avatarPipePath,

    // Filter: overlay avatar at bottom-right with transparency
    '-filter_complex',
    '[0:v][2:v]overlay=W-w-20:H-h-20:format=auto[out]',

    '-map', '[out]',
    '-map', '1:a',

    // Video encoding (CPU: libx264, ultrafast for minimal CPU usage)
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', config.videoBitrate,
    '-maxrate', config.videoBitrate,
    '-bufsize', `${parseInt(config.videoBitrate) * 2}k`,
    '-g', String(config.fps * 2),

    // Output frame rate cap
    '-r', String(config.fps),

    // Audio encoding
    '-c:a', 'aac',
    '-b:a', config.audioBitrate,
    '-ar', '44100',

    // Output
    '-f', 'flv',
    config.rtmpUrl,
  ];
}

/**
 * FFmpeg プロセスのライフサイクル管理。
 * オーバーレイテキストとアバター画像の動的更新をサポート。
 *
 * 本番では child_process.spawn を ProcessSpawner として注入する。
 * テストではモックを注入して引数検証のみ行う。
 */
export class FFmpegManager {
  private process: FFmpegProcess | null = null;
  private running = false;
  private currentOverlay = '';
  private currentAvatar = '';

  constructor(
    private readonly config: FFmpegConfig,
    private readonly spawner: ProcessSpawner,
    private readonly options: FFmpegManagerOptions = {},
  ) {}

  start(): void {
    if (this.running) return;

    const args = buildFFmpegArgs(this.config);
    this.process = this.spawner.spawn('ffmpeg', args);
    this.running = true;

    this.process.on('exit', (code: number | null) => {
      this.running = false;
      this.process = null;
      this.options.onExit?.(code);
    });

    this.process.stderr.on('data', (_chunk: Buffer) => {
      // FFmpeg outputs progress to stderr - can be logged/parsed
    });
  }

  stop(): void {
    if (!this.running || !this.process) return;
    this.process.kill('SIGTERM');
    this.running = false;
    this.process = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  getPid(): number | null {
    return this.process?.pid ?? null;
  }

  /**
   * 字幕テキストをファイルに書き出して FFmpeg の drawtext が読み取る用。
   * 実際のファイル書き込みは orchestrator が行う。
   */
  updateOverlayText(text: string): void {
    this.currentOverlay = text;
  }

  updateAvatarImage(imagePath: string): void {
    this.currentAvatar = imagePath;
  }

  getCurrentOverlay(): string {
    return this.currentOverlay;
  }

  getCurrentAvatar(): string {
    return this.currentAvatar;
  }
}
