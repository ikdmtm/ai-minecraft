import type { ThreatLevel } from '../types/llm.js';

export interface OverlayInput {
  survivalTimeMinutes: number;
  bestRecordMinutes: number;
  currentGoal: string;
  threatLevel: ThreatLevel;
  commentary: string;
  generation: number;
}

export interface OverlayData {
  survivalTime: string;
  bestRecord: string;
  generation: string;
  currentGoal: string;
  threatLabel: string;
  threatColor: string;
  commentary: string;
}

const THREAT_COLOR: Record<ThreatLevel, string> = {
  low: '#4CAF50',
  medium: '#FF9800',
  high: '#F44336',
  critical: '#D32F2F',
};

const THREAT_LABEL: Record<ThreatLevel, string> = {
  low: '安全',
  medium: '注意',
  high: '危険',
  critical: '致命的',
};

const MAX_COMMENTARY_LENGTH = 100;

export function formatSurvivalTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * オーバーレイ UI に表示するデータを整形する。
 * 実際の描画は FFmpeg drawtext / ASS subtitle で行うため、
 * ここでは表示文字列と色のみを計算する。
 */
export function buildOverlayData(input: OverlayInput): OverlayData {
  let commentary = input.commentary;
  if (commentary.length > MAX_COMMENTARY_LENGTH) {
    commentary = commentary.slice(0, MAX_COMMENTARY_LENGTH - 1) + '…';
  }

  return {
    survivalTime: formatSurvivalTime(input.survivalTimeMinutes),
    bestRecord: formatSurvivalTime(input.bestRecordMinutes),
    generation: `Gen #${input.generation}`,
    currentGoal: input.currentGoal,
    threatLabel: THREAT_LABEL[input.threatLevel],
    threatColor: THREAT_COLOR[input.threatLevel],
    commentary,
  };
}
