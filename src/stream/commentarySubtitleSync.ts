export interface CommentarySubtitleSyncOptions {
  displayDelayMs?: number;
}

const DEFAULT_DISPLAY_DELAY_MS = 220;

export class CommentarySubtitleSync {
  private displayTimer: ReturnType<typeof setTimeout> | null = null;
  private visibleText = '';

  constructor(
    private readonly updateCommentary: (text: string) => void,
    private readonly options: CommentarySubtitleSyncOptions = {},
  ) {}

  onPlaybackStart(text?: string): void {
    this.cancelPendingDisplay();
    if (!text) return;

    const delayMs = this.options.displayDelayMs ?? DEFAULT_DISPLAY_DELAY_MS;
    this.displayTimer = setTimeout(() => {
      this.visibleText = text;
      this.updateCommentary(text);
      this.displayTimer = null;
    }, delayMs);
  }

  onPlaybackEnd(): void {
    this.cancelPendingDisplay();
    if (!this.visibleText) {
      this.updateCommentary('');
      return;
    }

    this.visibleText = '';
    this.updateCommentary('');
  }

  reset(): void {
    this.cancelPendingDisplay();
    this.visibleText = '';
    this.updateCommentary('');
  }

  private cancelPendingDisplay(): void {
    if (this.displayTimer) {
      clearTimeout(this.displayTimer);
      this.displayTimer = null;
    }
  }
}
