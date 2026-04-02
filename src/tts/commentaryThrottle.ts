export type CommentaryAction = 'skip' | 'enqueue' | 'replace';

export interface CommentaryThrottleOptions {
  minIntervalMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 12_000;

export class CommentaryThrottle {
  private readonly minIntervalMs: number;
  private lastAcceptedAt = Number.NEGATIVE_INFINITY;

  constructor(options: CommentaryThrottleOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  decide(pendingCount: number, now = Date.now()): CommentaryAction {
    if (now - this.lastAcceptedAt < this.minIntervalMs) {
      return 'skip';
    }

    this.lastAcceptedAt = now;
    return pendingCount > 0 ? 'replace' : 'enqueue';
  }

  reset(): void {
    this.lastAcceptedAt = Number.NEGATIVE_INFINITY;
  }
}
