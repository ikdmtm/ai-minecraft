import type { WorldState, ActionCategory } from '../types/gameState.js';
import type { MappedActionType } from './types.js';

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman',
  'witch', 'slime', 'phantom', 'drowned', 'husk',
  'stray', 'blaze', 'ghast', 'magma_cube', 'hoglin',
  'piglin_brute', 'warden', 'wither_skeleton', 'cave_spider',
  'vindicator', 'evoker', 'pillager', 'ravager', 'vex',
  'guardian', 'elder_guardian', 'shulker', 'silverfish',
]);

export function classifyTimeOfDay(
  minecraftTime: number,
): WorldState['timeOfDay'] {
  const t = minecraftTime % 24000;
  if (t >= 23000 || t < 12000) return 'day';
  if (t >= 12000 && t < 13000) return 'dusk';
  if (t >= 13000 && t < 22000) return 'night';
  return 'dawn';
}

export function classifyWeather(
  isRaining: boolean,
  isThundering: boolean,
): WorldState['weather'] {
  if (isThundering) return 'thunder';
  if (isRaining) return 'rain';
  return 'clear';
}

export function categorizeEntity(type: string): boolean {
  return HOSTILE_MOBS.has(type);
}

export function summarizeInventory(
  items: Array<{ name: string; count: number }>,
): string[] {
  const grouped = new Map<string, number>();
  for (const item of items) {
    grouped.set(item.name, (grouped.get(item.name) ?? 0) + item.count);
  }
  return Array.from(grouped.entries()).map(([name, count]) => `${name} x${count}`);
}

const ACTION_CATEGORY_MAP: Record<MappedActionType, ActionCategory> = {
  mine_block: 'mining',
  craft_item: 'crafting',
  smelt_item: 'crafting',
  place_block: 'building',
  move_to_position: 'moving',
  move_to_block: 'moving',
  explore: 'exploring',
  attack_entity: 'combat',
  eat_food: 'farming',
  sleep: 'waiting',
  idle: 'waiting',
};

export function classifyActionCategory(
  actionType: MappedActionType,
): ActionCategory {
  return ACTION_CATEGORY_MAP[actionType] ?? 'waiting';
}
