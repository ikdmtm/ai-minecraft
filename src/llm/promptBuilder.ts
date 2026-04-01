import type { GameState } from '../types/gameState.js';
import { REI_PERSONA_GUIDELINES, REI_SYSTEM_INTRO } from '../persona/rei.js';

/**
 * LLM に毎回渡すシステムプロンプト（固定部分）。
 * キャラクター定義、行動原則、ペーシングの価値観、出力フォーマットを含む。
 */
export function buildSystemPrompt(): string {
  return `${REI_SYSTEM_INTRO}

${REI_PERSONA_GUIDELINES}

## 行動原則
1. 生存を最優先する
2. 不確実な戦闘を避ける
3. 安全が確保されていない状態で無理な探索をしない
4. 食料・寝床・基本装備の安定化を先に行う
5. 安全時のみサブタスクを自律生成する
6. 過去の死亡原因を記憶し、同じ過ちを避ける

## ペーシングの価値観
- 「安全だが退屈な状態」は、配信としては「危険だが見どころがある状態」より悪い
- 同じ行動を長時間続けていないか、常に自分で判断する
- 生存リスクだけでなく、視聴者離脱リスクも判断に含める
- 進捗フェーズに応じてリスクテイクの水準を引き上げる

## 利用可能な行動カテゴリ
mining, building, exploring, combat, waiting, moving, crafting, farming

## 出力フォーマット
以下の JSON を返してください。JSON 以外のテキストは含めないでください。

\`\`\`json
{
  "action": {
    "goal": "行動の目標（1文）",
    "reason": "なぜその行動を選んだか",
    "steps": ["ステップ1", "ステップ2", "..."]
  },
  "commentary": "実況テキスト（1〜3文。今の状況に即した自然な思考）",
  "current_goal_update": null,
  "threat_level": "low"
}
\`\`\`

- action.steps: 「拠点へ帰還する」「鉄鉱石を採掘する」「ベッドで寝る」「木を伐採する」「食料を食べる」「かまどで精錬する」「周辺を探索する」「洞窟に入る」等の自然言語で記述
- commentary: テンプレートではなく、今の状況に即した自然な思考を出力すること
- current_goal_update: 中目標に変更がある場合のみ記載。変更なしは null
- threat_level: "low" / "medium" / "high" / "critical"`;
}

/**
 * 毎ターンの user メッセージを構築する。
 * GameState を仕様書で定義された JSON フォーマット（snake_case）に変換する。
 */
export function buildUserMessage(state: GameState): string {
  const payload = {
    player: {
      hp: state.player.hp,
      max_hp: state.player.maxHp,
      hunger: state.player.hunger,
      position: state.player.position,
      biome: state.player.biome,
      equipment: state.player.equipment,
      inventory_summary: state.player.inventorySummary,
    },
    world: {
      time_of_day: state.world.timeOfDay,
      minecraft_time: state.world.minecraftTime,
      weather: state.world.weather,
      light_level: state.world.lightLevel,
      nearby_entities: state.world.nearbyEntities,
      nearby_blocks_of_interest: state.world.nearbyBlocksOfInterest,
    },
    base: {
      known: state.base.known,
      position: state.base.position,
      distance: state.base.distance,
      has_bed: state.base.hasBed,
      has_furnace: state.base.hasFurnace,
      has_crafting_table: state.base.hasCraftingTable,
    },
    pacing: {
      current_action_category: state.pacing.currentActionCategory,
      category_duration_minutes: state.pacing.categoryDurationMinutes,
      survival_time_minutes: state.pacing.survivalTimeMinutes,
      progress_phase: state.pacing.progressPhase,
      best_record_minutes: state.pacing.bestRecordMinutes,
    },
    previous_plan: state.previousPlan
      ? {
          goal: state.previousPlan.goal,
          status: state.previousPlan.status,
          progress: state.previousPlan.progress,
        }
      : null,
    recent_events: state.recentEvents,
    stagnation_warning: state.stagnationWarning,
    memory: {
      total_deaths: state.memory.totalDeaths,
      best_record_minutes: state.memory.bestRecordMinutes,
      recent_deaths: state.memory.recentDeaths.map((d) => ({
        generation: d.generation,
        survival_minutes: d.survivalMinutes,
        cause: d.cause,
        lesson: d.lesson,
      })),
    },
  };
  return JSON.stringify(payload, null, 2);
}
