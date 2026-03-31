import type { EventEmitter } from 'events';
import type { HudFilePaths } from './hudWriter.js';

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
  hud?: HudOverlayConfig;
}

export interface HudOverlayConfig {
  enabled: boolean;
  fontPath: string;
  filePaths: HudFilePaths;
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
 * FFmpeg drawtext フィルタ1行分を生成する。
 * reload=1 で FFmpeg がファイルを毎フレーム再読み込みする。
 */
function drawtext(opts: {
  textfile: string;
  fontPath: string;
  fontSize: number;
  fontColor: string;
  borderW: number;
  x: string;
  y: string;
}): string {
  const escaped = opts.textfile.replace(/:/g, '\\:').replace(/'/g, "\\'");
  return [
    `drawtext=textfile='${escaped}'`,
    `reload=1`,
    `fontfile='${opts.fontPath}'`,
    `fontsize=${opts.fontSize}`,
    `fontcolor=${opts.fontColor}`,
    `borderw=${opts.borderW}`,
    `bordercolor=black@0.8`,
    `x=${opts.x}`,
    `y=${opts.y}`,
  ].join(':');
}

/**
 * HUD drawtext フィルタ群を生成する。
 * 各テキストファイルは HudWriter が定期的に更新する。
 */
export function buildHudFilters(hud: HudOverlayConfig): string {
  const font = hud.fontPath;
  const filters = [
    drawtext({
      textfile: hud.filePaths.stats,
      fontPath: font, fontSize: 20, fontColor: 'white', borderW: 2,
      x: '10', y: 'H-40',
    }),
    drawtext({
      textfile: hud.filePaths.info,
      fontPath: font, fontSize: 18, fontColor: 'white', borderW: 2,
      x: 'W-360', y: '15',
    }),
    drawtext({
      textfile: hud.filePaths.goal,
      fontPath: font, fontSize: 18, fontColor: 'yellow', borderW: 2,
      x: '10', y: '15',
    }),
    drawtext({
      textfile: hud.filePaths.commentary,
      fontPath: font, fontSize: 22, fontColor: 'white', borderW: 3,
      x: '(W-text_w)/2', y: 'H-80',
    }),
  ];
  return filters.join(',');
}

/**
 * FFmpeg のコマンドライン引数を構築する。
 * x11grab → Minecraft 画面キャプチャ
 * pulse → PulseAudio combined_sink
 * libx264 ultrafast → CPU エンコード（負荷最小）
 * overlay → アバター合成用、drawtext → HUD 情報表示
 */
export function buildFFmpegArgs(config: FFmpegConfig): string[] {
  let filterComplex = '[0:v][2:v]overlay=W-w-20:H-h-20:format=auto';

  if (config.hud?.enabled) {
    filterComplex += ',' + buildHudFilters(config.hud);
  }

  filterComplex += '[out]';

  return [
    // Input 0: Video (X11 screen capture)
    '-f', 'x11grab',
    '-framerate', String(config.fps),
    '-video_size', config.resolution,
    '-i', config.display,

    // Input 1: Audio (PulseAudio combined sink)
    '-f', 'pulse',
    '-i', config.pulseAudioSource,

    // Input 2: Avatar (raw RGBA from named pipe)
    '-f', 'rawvideo',
    '-pixel_format', 'rgba',
    '-video_size', `${config.avatarWidth}x${config.avatarHeight}`,
    '-framerate', String(config.avatarFps),
    '-i', config.avatarPipePath,

    '-filter_complex',
    filterComplex,

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
