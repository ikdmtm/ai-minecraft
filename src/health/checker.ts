export interface HealthCheckTarget {
  name: string;
  check: () => Promise<boolean>;
  failureThreshold: number;
}

export interface HealthStatus {
  name: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  lastChecked: string;
}

interface HealthCheckerOptions {
  onUnhealthy?: (name: string, status: HealthStatus) => void;
  onRecovered?: (name: string) => void;
}

/**
 * 複数のヘルスチェック対象を監視する。
 * 10秒間隔で runChecks() を呼び出す想定（呼び出し側の責務）。
 * 連続失敗が閾値に達したら onUnhealthy、復旧したら onRecovered をコールバック。
 */
export class HealthChecker {
  private statuses = new Map<string, HealthStatus>();
  private alerted = new Set<string>();

  constructor(
    private targets: HealthCheckTarget[],
    private options: HealthCheckerOptions = {},
  ) {
    for (const t of targets) {
      this.statuses.set(t.name, {
        name: t.name,
        healthy: true,
        consecutiveFailures: 0,
        lastError: null,
        lastChecked: '',
      });
    }
  }

  async runChecks(): Promise<void> {
    const promises = this.targets.map((t) => this.checkOne(t));
    await Promise.allSettled(promises);
  }

  private async checkOne(target: HealthCheckTarget): Promise<void> {
    const status = this.statuses.get(target.name)!;
    const now = new Date().toISOString();

    let ok: boolean;
    try {
      ok = await target.check();
    } catch (e) {
      ok = false;
      status.lastError = e instanceof Error ? e.message : String(e);
    }

    status.lastChecked = now;

    if (ok) {
      const wasUnhealthy = !status.healthy;
      status.consecutiveFailures = 0;
      status.healthy = true;
      status.lastError = null;

      if (wasUnhealthy) {
        this.alerted.delete(target.name);
        this.options.onRecovered?.(target.name);
      }
    } else {
      status.consecutiveFailures++;
      if (status.consecutiveFailures >= target.failureThreshold) {
        status.healthy = false;
        if (!this.alerted.has(target.name)) {
          this.alerted.add(target.name);
          this.options.onUnhealthy?.(target.name, status);
        }
      }
    }
  }

  getStatuses(): HealthStatus[] {
    return Array.from(this.statuses.values());
  }

  getStatus(name: string): HealthStatus | undefined {
    return this.statuses.get(name);
  }

  isAllHealthy(): boolean {
    return Array.from(this.statuses.values()).every((s) => s.healthy);
  }
}
