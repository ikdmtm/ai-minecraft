import { execSync, execFileSync } from 'child_process';
import { createWriteStream, existsSync, readFileSync } from 'fs';
import type { WriteStream } from 'fs';

export interface AvatarFrameWriterConfig {
  pipePath: string;
  expressionFile: string;
  width: number;
  height: number;
  fps: number;
}

export interface PipeStream {
  write(buf: Buffer): boolean;
  destroy(): void;
  destroyed: boolean;
  on(event: string, cb: () => void): void;
}

export interface AvatarFrameWriterDeps {
  createNamedPipe: (path: string) => void;
  removeNamedPipe: (path: string) => void;
  openPipeStream: (path: string) => PipeStream;
  readExpressionFile: (path: string) => string;
  convertImage: (imgPath: string, width: number, height: number) => Buffer;
  fileExists: (path: string) => boolean;
}

const defaultDeps: AvatarFrameWriterDeps = {
  createNamedPipe: (path) => execSync(`mkfifo ${path}`, { timeout: 2000 }),
  removeNamedPipe: (path) => execSync(`rm -f ${path}`, { timeout: 2000 }),
  openPipeStream: (path) => {
    const stream = createWriteStream(path, { highWaterMark: 1024 * 1024 });
    return stream as unknown as PipeStream;
  },
  readExpressionFile: (path) => existsSync(path) ? readFileSync(path, 'utf-8').trim() : '',
  convertImage: (imgPath, width, height) => {
    return execFileSync('convert', [
      imgPath, '-resize', `${width}x${height}!`, '-depth', '8', 'RGBA:-',
    ], { maxBuffer: width * height * 4 + 1024, timeout: 3000 });
  },
  fileExists: (path) => existsSync(path),
};

/**
 * アバター表情画像を RGBA rawvideo としてFFmpegの named pipe に書き込む。
 *
 * 信頼性改善:
 * - バックプレッシャー対応: write() が false を返したらフレームをスキップ
 * - フレームキャッシュ: convert 失敗時は前回フレームを再利用
 * - 画像変更時のみ convert を実行（同一画像の再変換を回避）
 */
export class AvatarFrameWriter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pipeStream: PipeStream | null = null;
  private lastImagePath = '';
  private cachedFrame: Buffer;
  private readonly frameCache = new Map<string, Buffer>();
  private draining = false;
  private readonly frameBytes: number;

  constructor(
    private readonly config: AvatarFrameWriterConfig,
    private readonly deps: AvatarFrameWriterDeps = defaultDeps,
  ) {
    this.frameBytes = config.width * config.height * 4;
    this.cachedFrame = Buffer.alloc(this.frameBytes);
  }

  createPipe(): void {
    this.deps.removeNamedPipe(this.config.pipePath);
    this.deps.createNamedPipe(this.config.pipePath);
  }

  connectPipe(): void {
    this.pipeStream = this.deps.openPipeStream(this.config.pipePath);
    this.pipeStream.on('drain', () => {
      this.draining = false;
    });
    this.pipeStream.on('error', () => {
      if (this.pipeStream && !this.pipeStream.destroyed) {
        this.pipeStream.destroy();
      }
      this.pipeStream = null;
      this.draining = false;
    });
    const intervalMs = Math.max(50, Math.floor(1000 / this.config.fps));
    this.timer = setInterval(() => this.writeFrame(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.pipeStream && !this.pipeStream.destroyed) {
      this.pipeStream.destroy();
    }
    this.pipeStream = null;
    try { this.deps.removeNamedPipe(this.config.pipePath); } catch { /* ignore */ }
  }

  writeFrameOnce(): void {
    this.writeFrame();
  }

  private writeFrame(): void {
    if (!this.pipeStream || this.pipeStream.destroyed) return;
    if (this.draining) return;

    try {
      const imgPath = this.deps.readExpressionFile(this.config.expressionFile);

      if (imgPath && this.deps.fileExists(imgPath) && imgPath !== this.lastImagePath) {
        try {
          const raw = this.frameCache.get(imgPath)
            ?? this.deps.convertImage(imgPath, this.config.width, this.config.height);
          if (raw.length === this.frameBytes) {
            this.cachedFrame = raw;
            this.lastImagePath = imgPath;
            this.frameCache.set(imgPath, raw);
          }
        } catch {
          // convert failed - use cached frame
        }
      }

      const ok = this.pipeStream.write(this.cachedFrame);
      if (!ok) {
        this.draining = true;
      }
    } catch {
      // pipe errors are non-fatal; next tick will retry
    }
  }
}
