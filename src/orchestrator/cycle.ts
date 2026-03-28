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
  logAction: (entry: ActionLogEntry) => void;
}

/**
 * AI 思考→行動→実況の 1 サイクルを制御する。
 * 仕様書 §23 のフローをそのまま実装。
 */
export class CycleRunner {
  private previousPlan: PreviousPlan | null = null;
  private currentGoal = '';

  constructor(private deps: CycleDeps) {}

  /**
   * 1 サイクルを実行する。
   * [1] ゲーム状態取得 → [2,3] LLM 呼び出し → [4] パース → [5a,b,c] 並列実行
   */
  async runOneCycle(): Promise<Result<LLMOutput>> {
    const gameState = this.deps.getGameState();

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

    const executePromise = this.deps.executeSteps(output.action.steps);
    const speakPromise = output.commentary
      ? this.deps.speakCommentary(output.commentary)
      : Promise.resolve();

    await Promise.all([executePromise, speakPromise]);

    return ok(output);
  }

  getPreviousPlan(): PreviousPlan | null {
    return this.previousPlan;
  }

  getCurrentGoal(): string {
    return this.currentGoal;
  }
}
