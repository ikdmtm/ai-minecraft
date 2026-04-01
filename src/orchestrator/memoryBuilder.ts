import type { Memory, DeathRecord } from '../types/gameState.js';

export interface MemorySource {
  getRecentDeaths: (limit: number) => DeathRecord[];
  getBestRecord: () => number;
  getTotalDeaths: () => number;
}

const DEFAULT_RECENT_LIMIT = 5;

/**
 * DB の死亡履歴から LLM 入力用の Memory オブジェクトを構築する。
 * 毎サイクルの GameState 構築時に呼び出す。
 */
export function buildMemory(source: MemorySource, limit = DEFAULT_RECENT_LIMIT): Memory {
  return {
    totalDeaths: source.getTotalDeaths(),
    bestRecordMinutes: source.getBestRecord(),
    recentDeaths: source.getRecentDeaths(limit),
  };
}
