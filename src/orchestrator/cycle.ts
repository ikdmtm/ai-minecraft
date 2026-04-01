import type { GameState, PreviousPlan } from '../types/gameState.js';
import type { LLMOutput, ThreatLevel } from '../types/llm.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

export interface OverlayUpdate {
  currentGoal: string;
  threatLevel: ThreatLevel;
  commentary: string;
}

export interface ActionLogEntry {
  timestamp: string;
  type: 'llm_response' | 'reactive_action' | 'state_change' | 'error';
  content: string;
}

/**
 * 1 サイクルに必要な外部依存をすべてこのインターフェースで注入する。
 * テスト時はモック、本番時は実モジュールを渡す。
 */
export interface CycleDeps {
  getGameState: () => GameState;
  callLLM: (state: GameState) => Promise<Result<LLMOutput>>;
  executeSteps: (steps: string[]) => Promise<void>;
  speakCommentary: (text: string) => Promise<void>;
  updateOverlay: (update: OverlayUpdate) => void;
  updateAvatar: (threatLevel: ThreatLevel, isSpeaking: boolean) => void;
  triggerAvatarSpecial: (expression: string, durationMs?: number) => void;
  logAction: (entry: ActionLogEntry) => void;
}

/**
 * AI 思考→行動→実況の 1 サイクルを制御する。
 * 仕様書 §23 のフローをそのまま実装。
 */
export class CycleRunner {
  private previousPlan: PreviousPlan | null = null;
  private currentGoal = '';
  private running = false;

  constructor(private deps: CycleDeps) {}

  isRunning(): boolean {
    return this.running;
  }

  /**
   * 1 サイクルを実行する。
   * [1] ゲーム状態取得 → [2,3] LLM 呼び出し → [4] パース → [5a,b,c] 並列実行
   *
   * - speakCommentary の失敗は executeSteps に影響しない（allSettled）
   * - 同時に 2 サイクルが走ることを防ぐガード付き
   */
  async runOneCycle(): Promise<Result<LLMOutput>> {
    if (this.running) {
      return err('前のサイクルが実行中です');
    }

    this.running = true;
    try {
      return await this.executeOneCycle();
    } finally {
      this.running = false;
    }
  }

  private async executeOneCycle(): Promise<Result<LLMOutput>> {
    const gameState = this.deps.getGameState();

    this.deps.triggerAvatarSpecial('thinking');

    const llmResult = await this.deps.callLLM(gameState);
    if (!llmResult.ok) {
      this.deps.logAction({
        timestamp: new Date().toISOString(),
        type: 'error',
        content: `LLM 失敗: ${llmResult.error}`,
      });
      return err(llmResult.error);
    }

    const output = llmResult.value;

    if (output.currentGoalUpdate) {
      this.currentGoal = output.currentGoalUpdate;
    }

    this.previousPlan = {
      goal: output.action.goal,
      status: 'in_progress',
      progress: '',
    };

    this.deps.logAction({
      timestamp: new Date().toISOString(),
      type: 'llm_response',
      content: JSON.stringify({
        goal: output.action.goal,
        steps: output.action.steps,
        threatLevel: output.threatLevel,
      }),
    });

    this.deps.updateOverlay({
      currentGoal: this.currentGoal || output.action.goal,
      threatLevel: output.threatLevel,
      commentary: output.commentary,
    });

    this.deps.updateAvatar(output.threatLevel, !!output.commentary);

    const results = await Promise.allSettled([
      this.deps.executeSteps(output.action.steps),
      output.commentary
        ? this.deps.speakCommentary(output.commentary)
        : Promise.resolve(),
    ]);

    for (const r of results) {
      if (r.status === 'rejected') {
        this.deps.logAction({
          timestamp: new Date().toISOString(),
          type: 'error',
          content: `サイクル内エラー: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        });
      }
    }

    return ok(output);
  }

  getPreviousPlan(): PreviousPlan | null {
    return this.previousPlan;
  }

  getCurrentGoal(): string {
    return this.currentGoal;
  }
}
