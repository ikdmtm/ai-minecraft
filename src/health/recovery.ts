import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

export interface RecoveryAction {
  targetName: string;
  command: string;
}

export interface CommandExecutor {
  exec(command: string): Promise<{ success: boolean; output: string }>;
}

interface RecoveryOptions {
  cooldownMs?: number;
  onRecoveryAttempt?: (targetName: string, command: string, success: boolean) => void;
}

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * ヘルスチェック異常時の復旧コマンドを実行する。
 * 同じ対象への連続復旧を防ぐクールダウン付き。
 */
export class RecoveryDispatcher {
  private actionMap: Map<string, string>;
  private lastRecovery = new Map<string, number>();
  private cooldownMs: number;
  private onAttempt?: (name: string, cmd: string, success: boolean) => void;

  constructor(
    actions: RecoveryAction[],
    private executor: CommandExecutor,
    options?: RecoveryOptions,
  ) {
    this.actionMap = new Map(actions.map((a) => [a.targetName, a.command]));
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.onAttempt = options?.onRecoveryAttempt;
  }

  async recover(targetName: string): Promise<Result<void>> {
    const command = this.actionMap.get(targetName);
    if (!command) {
      return err(`復旧アクション未定義: ${targetName}`);
    }

    const lastTime = this.lastRecovery.get(targetName) ?? 0;
    if (Date.now() - lastTime < this.cooldownMs) {
      return err(`${targetName} はクールダウン中です`);
    }

    try {
      this.lastRecovery.set(targetName, Date.now());
      const result = await this.executor.exec(command);
      this.onAttempt?.(targetName, command, result.success);

      if (!result.success) {
        return err(`復旧コマンド失敗: ${result.output}`);
      }
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.onAttempt?.(targetName, command, false);
      return err(`復旧実行エラー: ${msg}`);
    }
  }
}
