import type mineflayer from 'mineflayer';
import type { SharedStateBus } from '../cognitive/sharedState.js';
import type { JevWorldState, SkillSnapshot, WorldCandidate } from './typedActions.js';
import type { WorldProvenance } from './worldProvenance.js';

const TRACKED_BLOCKS = new Set([
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log',
  'stone', 'cobblestone', 'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
  'crafting_table', 'furnace',
]);

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'drowned', 'husk',
  'stray', 'pillager', 'vindicator', 'evoker', 'ravager', 'slime', 'phantom', 'blaze', 'ghast',
]);

const FOOD_ANIMALS = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit']);

export class WorldSensor {
  constructor(
    private readonly bot: mineflayer.Bot,
    private readonly shared: SharedStateBus,
    private readonly provenance?: WorldProvenance,
  ) {}

  capture(currentSkill: SkillSnapshot): JevWorldState {
    const position = this.bot.entity.position;
    const inventory: Record<string, number> = {};
    for (const item of this.bot.inventory.items()) {
      inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
    }

    return {
      ts: Date.now(),
      player: {
        hp: this.bot.health,
        hunger: this.bot.food,
        oxygen: isHeadSubmerged(this.bot) ? (this.bot.oxygenLevel ?? 20) : 20,
        onFire: Boolean((this.bot.entity as any).isOnFire),
        position: { x: position.x, y: position.y, z: position.z },
        heldItem: this.bot.heldItem?.name ?? null,
      },
      world: {
        timeOfDay: this.bot.time.timeOfDay,
        day: this.bot.time.day,
        isNight: this.bot.time.timeOfDay >= 12500 && this.bot.time.timeOfDay < 23500,
        raining: this.bot.isRaining,
        blockBelow: this.bot.blockAt(position.offset(0, -1, 0))?.name ?? null,
      },
      inventory,
      strategy: {
        mainGoal: this.shared.get().currentGoal || 'Survive and make normal Minecraft progress.',
        subGoals: [...this.shared.get().subGoals],
      },
      currentSkill,
      blockCandidates: this.getBlockCandidates(),
      entityCandidates: this.getEntityCandidates(),
      recentEvents: this.shared.getRecentEvents(20_000).slice(-12).map(event => ({
        type: event.type,
        detail: event.detail,
        importance: event.importance,
      })),
    };
  }

  private getBlockCandidates(): WorldCandidate[] {
    let positions: any[] = [];
    try {
      positions = this.bot.findBlocks({
        matching: block => TRACKED_BLOCKS.has(block.name),
        maxDistance: 48,
        count: 24,
      }) as any[];
    } catch {
      return [];
    }

    const origin = this.bot.entity.position;
    const result: WorldCandidate[] = [];
    for (const pos of positions) {
      const block = this.bot.blockAt(pos);
      if (!block || !TRACKED_BLOCKS.has(block.name)) continue;
      if (block.name.endsWith('_log') && this.provenance?.isPlayerPlaced(block.position)) continue;
      const distance = origin.distanceTo(block.position);

      // Only expose targets the bot can currently see. The policy should choose
      // among executable affordances, not hidden blocks inside a canopy or underground.
      // Hidden resources are reached through EXPLORE / DIG_STAIRCASE first.
      if (!this.bot.canSeeBlock(block)) continue;

      result.push({
        id: `block:${block.name}:${block.position.x}:${block.position.y}:${block.position.z}`,
        kind: 'block',
        name: block.name,
        distance: Math.round(distance * 10) / 10,
        position: { x: block.position.x, y: block.position.y, z: block.position.z },
      });
    }

    return dedupeCandidates(result)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 16);
  }

  private getEntityCandidates(): WorldCandidate[] {
    const origin = this.bot.entity.position;
    const result: WorldCandidate[] = [];
    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || entity === this.bot.entity || !entity.name || !entity.position) continue;
      const distance = origin.distanceTo(entity.position);
      if (distance > 32) continue;
      const hostile = HOSTILE_MOBS.has(entity.name);
      const foodAnimal = FOOD_ANIMALS.has(entity.name);
      if (!hostile && !foodAnimal && entity.name !== 'item') continue;
      result.push({
        id: `entity:${entity.id}`,
        kind: 'entity',
        name: entity.name,
        distance: Math.round(distance * 10) / 10,
        position: {
          x: Number(entity.position.x.toFixed(1)),
          y: Number(entity.position.y.toFixed(1)),
          z: Number(entity.position.z.toFixed(1)),
        },
        hostile,
        foodAnimal,
      });
    }

    return result.sort((a, b) => a.distance - b.distance).slice(0, 16);
  }
}

function dedupeCandidates(candidates: WorldCandidate[]): WorldCandidate[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

export function isHostileMob(name: string): boolean {
  return HOSTILE_MOBS.has(name);
}

export function isFoodAnimal(name: string): boolean {
  return FOOD_ANIMALS.has(name);
}


function isHeadSubmerged(bot: mineflayer.Bot): boolean {
  const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name ?? '';
  return head === 'water' || head === 'bubble_column';
}
