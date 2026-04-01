export interface ActionFailureGuardOptions {
  failureThreshold?: number;
  failureWindowMs?: number;
  cooldownMs?: number;
}

interface FailureState {
  count: number;
  lastFailureAt: number;
  blockedUntil: number;
}

const DEFAULT_OPTIONS: Required<ActionFailureGuardOptions> = {
  failureThreshold: 3,
  failureWindowMs: 30_000,
  cooldownMs: 90_000,
};

export class ActionFailureGuard {
  private readonly options: Required<ActionFailureGuardOptions>;
  private readonly states = new Map<string, FailureState>();

  constructor(options: ActionFailureGuardOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  isBlocked(key: string, now = Date.now()): boolean {
    const state = this.states.get(key);
    if (!state) return false;
    if (state.blockedUntil <= now) {
      this.states.delete(key);
      return false;
    }
    return true;
  }

  recordFailure(key: string, now = Date.now()): { count: number; blocked: boolean } {
    const current = this.states.get(key);
    const withinWindow = current && now - current.lastFailureAt <= this.options.failureWindowMs;
    const count = withinWindow ? current.count + 1 : 1;
    const blocked = count >= this.options.failureThreshold;

    this.states.set(key, {
      count,
      lastFailureAt: now,
      blockedUntil: blocked ? now + this.options.cooldownMs : 0,
    });

    return { count, blocked };
  }

  recordSuccess(key: string): void {
    this.states.delete(key);
  }
}
