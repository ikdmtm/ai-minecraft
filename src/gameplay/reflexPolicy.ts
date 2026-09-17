import { Vec3 } from 'vec3';
import type { SharedStateBus } from '../cognitive/sharedState.js';
import type { ReflexLayer } from '../cognitive/reflexLayer.js';

const SHELTER_KEYWORDS = [
  'シェルター', '仮拠点', '避難', '入口', '密閉', '夜を', '夜明け', '柱立ち', '高所', '窪地',
];

const BUILDABLE_SUFFIXES = ['_planks', '_log'];
const BUILDABLE_EXACT = new Set(['dirt', 'cobblestone']);

/**
 * Gameplay-first development policy.
 *
 * ReflexLayer's historical night fallback always tried the same dirt-based
 * shelter before higher-level goals could execute. During revival testing this
 * caused a 250ms retry loop when the bot had plenty of logs but <12 dirt.
 *
 * This policy keeps urgent survival reactions in ReflexLayer, but replaces the
 * non-urgent goal dispatcher so shelter goals map to an actually executable
 * emergency shelter skill that can consume logs/planks/dirt/cobblestone.
 */
export function installGameplayReflexPolicy(
  reflexLayer: ReflexLayer,
  shared: SharedStateBus,
): void {
  const layer = reflexLayer as any;

  layer.executeGoalBehavior = function executeGameplayGoalBehavior(): void {
    const bot = layer.requireBot();
    const state = shared.get();
    const goal = (state.currentGoal || state.subGoals[0] || '').toLowerCase();
    const isNight = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay < 23500;

    // Night survival is still important, but it must be an executable skill,
    // not an endless retry of the historical dirt-only implementation.
    if (!layer.shelterBuilt && (isNight || isShelterGoal(goal))) {
      shared.setReflexState('crafting');
      layer.runAction(() => buildEmergencyShelter(layer, shared));
      return;
    }

    if (!goal) {
      layer.doIdleBehavior();
      return;
    }

    if (isShelterGoal(goal)) {
      shared.setReflexState('crafting');
      layer.runAction(() => buildEmergencyShelter(layer, shared));
    } else if (goal.includes('木') || goal.includes('log') || goal.includes('伐採')) {
      shared.setReflexState('mining');
      layer.runAction(() => layer.doMineBlock([
        'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
        'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log',
      ]));
    } else if (goal.includes('石炭') || goal.includes('coal')) {
      shared.setReflexState('mining');
      layer.runAction(() => layer.doMineBlock(['coal_ore', 'deepslate_coal_ore']));
    } else if (goal.includes('石') || goal.includes('stone') || goal.includes('cobble')) {
      shared.setReflexState('mining');
      layer.runAction(() => layer.doMineBlock(['stone', 'cobblestone']));
    } else if (goal.includes('鉄') || goal.includes('iron')) {
      shared.setReflexState('mining');
      layer.runAction(() => layer.doMineBlock(['iron_ore', 'deepslate_iron_ore']));
    } else if (goal.includes('ダイヤ') || goal.includes('diamond')) {
      shared.setReflexState('mining');
      layer.runAction(() => layer.doMineBlock(['diamond_ore', 'deepslate_diamond_ore']));
    } else if (
      goal.includes('クラフト') || goal.includes('craft') || goal.includes('作成') ||
      goal.includes('板材') || goal.includes('作業台') || goal.includes('道具') || goal.includes('ツルハシ')
    ) {
      shared.setReflexState('crafting');
      layer.runAction(() => layer.doCraftAdvanced());
    } else if (goal.includes('食料') || goal.includes('food') || goal.includes('狩')) {
      shared.setReflexState('gathering');
      layer.runAction(() => layer.doHuntAnimal(''));
    } else if (goal.includes('寝') || goal.includes('sleep') || goal.includes('ベッド')) {
      shared.setReflexState('sleeping');
      layer.runAction(() => layer.doSleep());
    } else if (goal.includes('帰') || goal.includes('base')) {
      shared.setReflexState('returning_to_base');
      layer.runAction(() => layer.doReturnToBase());
    } else {
      shared.setReflexState('exploring');
      layer.runAction(() => layer.doExplore());
    }
  };
}

function isShelterGoal(goal: string): boolean {
  return SHELTER_KEYWORDS.some(keyword => goal.includes(keyword));
}

async function buildEmergencyShelter(layer: any, shared: SharedStateBus): Promise<void> {
  const bot = layer.requireBot();
  const start = bot.entity.position.floored();
  let placed = 0;

  shared.pushEvent({
    type: 'action_started',
    detail: `build_emergency_shelter at ${start.x},${start.y},${start.z}`,
    importance: 'medium',
  });

  try {
    // Build a two-block-high ring around the bot. This is deliberately simple:
    // reliability matters more than aesthetics during gameplay revival.
    const offsets = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0],           [1, 0],
      [-1, 1],  [0, 1],  [1, 1],
    ] as const;

    for (const [dx, dz] of offsets) {
      const ground = bot.blockAt(start.offset(dx, 0, dz));
      if (!ground || ground.name === 'air') continue;

      const lowerPos = start.offset(dx, 1, dz);
      let lower = bot.blockAt(lowerPos);
      if (!lower || lower.name === 'air') {
        const item = nextBuildItem(bot);
        if (!item) break;
        await bot.equip(item, 'hand');
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        placed++;
        await sleep(80);
        lower = bot.blockAt(lowerPos);
      }

      if (lower && lower.name !== 'air') {
        const upper = bot.blockAt(start.offset(dx, 2, dz));
        if (!upper || upper.name === 'air') {
          const item = nextBuildItem(bot);
          if (!item) break;
          await bot.equip(item, 'hand');
          await bot.placeBlock(lower, new Vec3(0, 1, 0));
          placed++;
          await sleep(80);
        }
      }
    }

    if (placed >= 6) {
      layer.shelterBuilt = true;
      shared.pushEvent({
        type: 'shelter_built',
        detail: `emergency shelter placed ${placed} blocks`,
        importance: 'high',
      });
      shared.updateEmotion({ valence: 0.1, dominance: 0.1 }, 'built_emergency_shelter');
      return;
    }

    shared.pushEvent({
      type: 'action_failed',
      detail: `build_emergency_shelter insufficient placements=${placed}; buildable=${countBuildable(bot)}`,
      importance: 'high',
    });
  } catch (error) {
    shared.pushEvent({
      type: 'action_failed',
      detail: `build_emergency_shelter error=${error instanceof Error ? error.message : String(error)} placed=${placed}`,
      importance: 'high',
    });
  }
}

function nextBuildItem(bot: any): any | null {
  return bot.inventory.items().find((item: any) => isBuildable(item.name)) ?? null;
}

function countBuildable(bot: any): number {
  return bot.inventory.items()
    .filter((item: any) => isBuildable(item.name))
    .reduce((sum: number, item: any) => sum + item.count, 0);
}

function isBuildable(name: string): boolean {
  return BUILDABLE_EXACT.has(name) || BUILDABLE_SUFFIXES.some(suffix => name.endsWith(suffix));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
