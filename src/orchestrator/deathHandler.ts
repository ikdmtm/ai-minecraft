import type { Position, RecentEvent, DeathRecord } from '../types/gameState.js';
import type { PersistentState } from '../types/state.js';
import type { Result } from '../types/result.js';
import { ok } from '../types/result.js';
import type { ActionLogEntry } from './cycle.js';

export interface DeathContext {
  position: Position;
  recentActions: RecentEvent[];
}

export interface DeathResult {
  generation: number;
  survivalMinutes: number;
  cause: string;
  lesson: string;
  isNewRecord: boolean;
}

export interface DeathHandlerDeps {
  generateLesson: (context: {
    position: Position;
    cause: string;
    recentActions: RecentEvent[];
    survivalMinutes: number;
  }) => Promise<Result<string>>;
  addDeathRecord: (record: DeathRecord) => void;
  getState: () => Pick<PersistentState, 'currentGeneration' | 'bestRecordMinutes' | 'survivalStartTime'>;
  saveState: (partial: Partial<PersistentState>) => void;
  getBestRecord: () => number;
  logAction: (entry: ActionLogEntry) => void;
}

/**
 * 死亡時の一連の処理を実行する。
 * 1. 生存時間を計算
 * 2. LLM で教訓を生成
 * 3. 死亡履歴を DB に保存
 * 4. 世代番号をインクリメント
 * 5. 最高記録を更新（該当する場合）
 */
export class DeathHandler {
  constructor(private deps: DeathHandlerDeps) {}

  async handleDeath(cause: string, context: DeathContext): Promise<Result<DeathResult>> {
    const state = this.deps.getState();
    const survivalMinutes = this.calcSurvivalMinutes(state.survivalStartTime);

    const lessonResult = await this.deps.generateLesson({
      position: context.position,
      cause,
      recentActions: context.recentActions,
      survivalMinutes,
    });
    const lesson = lessonResult.ok ? lessonResult.value : '（教訓生成失敗）';

    const record: DeathRecord = {
      generation: state.currentGeneration,
      survivalMinutes,
      cause,
      lesson,
    };
    this.deps.addDeathRecord(record);

    const prevBest = this.deps.getBestRecord();
    const isNewRecord = survivalMinutes > prevBest;

    const stateUpdate: Partial<PersistentState> = {
      currentGeneration: state.currentGeneration + 1,
      survivalStartTime: null,
      currentState: 'DEATH_DETECTED',
      lastStateUpdate: new Date().toISOString(),
    };

    if (isNewRecord) {
      stateUpdate.bestRecordMinutes = survivalMinutes;
    }

    this.deps.saveState(stateUpdate);

    this.deps.logAction({
      timestamp: new Date().toISOString(),
      type: 'state_change',
      content: `死亡: Gen#${state.currentGeneration} ${survivalMinutes}分 原因: ${cause} 教訓: ${lesson}`,
    });

    return ok({
      generation: state.currentGeneration,
      survivalMinutes,
      cause,
      lesson,
      isNewRecord,
    });
  }

  private calcSurvivalMinutes(startTime: string | null): number {
    if (!startTime) return 0;
    const start = new Date(startTime).getTime();
    const now = Date.now();
    return Math.floor((now - start) / 60_000);
  }
}
