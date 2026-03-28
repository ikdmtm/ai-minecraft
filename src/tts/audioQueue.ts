/**
 * 音声再生の抽象化。本番では PulseAudio に WAV を流す実装を渡す。
 */
export interface AudioPlayer {
  play(buffer: Buffer): Promise<void>;
  stop(): void;
}

/**
 * 音声を順次再生するキュー。
 * 前の音声の再生が終わるまで次の音声を待つ（被せない）。
 */
export class AudioQueue {
  private queue: Buffer[] = [];
  private playing = false;
  private startCb: (() => void) | null = null;
  private endCb: (() => void) | null = null;

  constructor(private player: AudioPlayer) {}

  enqueue(buffer: Buffer): void {
    this.queue.push(buffer);
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

  onPlaybackStart(cb: () => void): void {
    this.startCb = cb;
  }

  onPlaybackEnd(cb: () => void): void {
    this.endCb = cb;
  }

  private async processNext(): Promise<void> {
    const buffer = this.queue.shift();
    if (!buffer) {
      this.playing = false;
      return;
    }

    this.playing = true;
    this.startCb?.();

    try {
      await this.player.play(buffer);
    } catch {
      // 再生エラーは無視して次に進む
    }

    this.endCb?.();
    this.playing = false;

    if (this.queue.length > 0) {
      this.processNext();
    }
  }
}
