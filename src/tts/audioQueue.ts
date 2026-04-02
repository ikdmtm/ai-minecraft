/**
 * 音声再生の抽象化。本番では PulseAudio に WAV を流す実装を渡す。
 */
export interface AudioPlayer {
  play(buffer: Buffer): Promise<void>;
  stop(): void;
}

export interface AudioQueueItem {
  buffer: Buffer;
  text?: string;
  durationMs?: number;
}

export interface AudioQueueOptions {
  latencyCompensationMs?: number;
  playbackStartDelayMs?: number;
}

/**
 * 音声を順次再生するキュー。
 * 前の音声の再生が終わるまで次の音声を待つ（被せない）。
 */
export class AudioQueue {
  private queue: AudioQueueItem[] = [];
  private playing = false;
  private startCb: ((item: AudioQueueItem) => void) | null = null;
  private endCb: ((item: AudioQueueItem) => void) | null = null;
  private readonly latencyCompensationMs: number;
  private readonly playbackStartDelayMs: number;

  constructor(private player: AudioPlayer, options: AudioQueueOptions = {}) {
    this.latencyCompensationMs = options.latencyCompensationMs ?? 250;
    this.playbackStartDelayMs = options.playbackStartDelayMs ?? this.latencyCompensationMs;
  }

  enqueue(buffer: Buffer, text?: string): void {
    this.queue.push({ buffer, text, durationMs: getWavDurationMs(buffer) ?? undefined });
    if (!this.playing) {
      this.processNext();
    }
  }

  replacePending(buffer: Buffer, text?: string): void {
    this.queue = [{ buffer, text, durationMs: getWavDurationMs(buffer) ?? undefined }];
    if (!this.playing) {
      this.processNext();
    }
  }

  isPlaying(): boolean {
    return this.playing;
  }

  pendingCount(): number {
    return this.queue.length + (this.playing ? 1 : 0);
  }

  clear(): void {
    this.queue = [];
  }

  onPlaybackStart(cb: (item: AudioQueueItem) => void): void {
    this.startCb = cb;
  }

  onPlaybackEnd(cb: (item: AudioQueueItem) => void): void {
    this.endCb = cb;
  }

  private async processNext(): Promise<void> {
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      return;
    }

    this.playing = true;
    let startNotified = false;
    const notifyStart = () => {
      if (startNotified) return;
      startNotified = true;
      this.startCb?.(item);
    };
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    if (this.playbackStartDelayMs <= 0) {
      notifyStart();
    } else {
      startTimer = setTimeout(() => {
        notifyStart();
        startTimer = null;
      }, this.playbackStartDelayMs);
    }
    const startedAt = Date.now();
    let playbackFailed = false;

    try {
      await this.player.play(item.buffer);
    } catch {
      // 再生エラーは無視して次に進む
      playbackFailed = true;
    } finally {
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
      }
    }

    if (!startNotified && !playbackFailed) {
      notifyStart();
    }

    const minimumPlaybackMs = item.durationMs !== undefined
      ? item.durationMs + this.latencyCompensationMs
      : 0;
    const elapsedMs = Date.now() - startedAt;
    if (minimumPlaybackMs > elapsedMs) {
      await sleep(minimumPlaybackMs - elapsedMs);
    }

    this.playing = false;
    this.endCb?.(item);

    if (this.queue.length > 0) {
      this.processNext();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getWavDurationMs(buffer: Buffer): number | null {
  if (buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let byteRate: number | null = null;
  let dataSize: number | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16 && chunkDataOffset + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(chunkDataOffset + 8);
    }

    if (chunkId === 'data') {
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!byteRate || !dataSize || byteRate <= 0) {
    return null;
  }

  return Math.round((dataSize / byteRate) * 1000);
}
