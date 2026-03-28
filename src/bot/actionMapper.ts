import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import type { MappedAction } from './types.js';

interface PatternRule {
  pattern: RegExp;
  map: (step: string, match: RegExpMatchArray) => MappedAction;
}

const ORE_MAP: Record<string, string> = {
  '鉄': 'iron_ore',
  '石炭': 'coal_ore',
  '金': 'gold_ore',
  'ダイヤ': 'diamond_ore',
  'ダイヤモンド': 'diamond_ore',
  'レッドストーン': 'redstone_ore',
  'ラピスラズリ': 'lapis_ore',
  'エメラルド': 'emerald_ore',
  '銅': 'copper_ore',
};

const RULES: PatternRule[] = [
  {
    pattern: /拠点.*(帰還|戻|帰)/,
    map: (step) => ({ type: 'move_to_position', params: { target: 'base' }, originalStep: step }),
  },
  {
    pattern: /ベッド.*(寝|使)/,
    map: (step) => ({ type: 'sleep', params: {}, originalStep: step }),
  },
  {
    pattern: /食料.*食べ|食べ.*食料|何か食べ/,
    map: (step) => ({ type: 'eat_food', params: {}, originalStep: step }),
  },
  {
    pattern: /かまど.*精錬|精錬/,
    map: (step) => ({ type: 'smelt_item', params: {}, originalStep: step }),
  },
  {
    pattern: /作業台.*作|クラフト|作成/,
    map: (step) => ({ type: 'craft_item', params: {}, originalStep: step }),
  },
  {
    pattern: /洞窟.*(入|探検|進)/,
    map: (step) => ({ type: 'explore', params: { variant: 'cave' }, originalStep: step }),
  },
  {
    pattern: /探索|散策|見回/,
    map: (step) => ({ type: 'explore', params: { variant: 'surface' }, originalStep: step }),
  },
  {
    pattern: /(鉄|石炭|金|ダイヤモンド|ダイヤ|レッドストーン|ラピスラズリ|エメラルド|銅).*(掘|採掘|採取)/,
    map: (step, match) => {
      const oreName = match[1];
      const blockType = ORE_MAP[oreName] ?? 'iron_ore';
      return { type: 'mine_block', params: { blockType }, originalStep: step };
    },
  },
  {
    pattern: /木.*(伐採|切|掘)/,
    map: (step) => ({ type: 'mine_block', params: { blockType: 'oak_log' }, originalStep: step }),
  },
  {
    pattern: /石.*掘|丸石.*集/,
    map: (step) => ({ type: 'mine_block', params: { blockType: 'stone' }, originalStep: step }),
  },
  {
    pattern: /砂.*掘/,
    map: (step) => ({ type: 'mine_block', params: { blockType: 'sand' }, originalStep: step }),
  },
  {
    pattern: /待機|待つ|様子を見/,
    map: (step) => ({ type: 'idle', params: {}, originalStep: step }),
  },
];

/**
 * LLM が返した自然言語の step を、実行可能なアクションにマッピングする。
 * マッチするルールがなければ err を返す。
 */
export function mapStep(step: string): Result<MappedAction> {
  for (const rule of RULES) {
    const match = step.match(rule.pattern);
    if (match) {
      return ok(rule.map(step, match));
    }
  }
  return err(`マッピング不可: "${step}"`);
}

/**
 * 複数の steps をマッピングし、マッピングできたもののみを返す。
 */
export function mapSteps(steps: string[]): MappedAction[] {
  const results: MappedAction[] = [];
  for (const step of steps) {
    const result = mapStep(step);
    if (result.ok) {
      results.push(result.value);
    }
  }
  return results;
}
