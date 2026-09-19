import type mineflayer from 'mineflayer';
import type { SharedStateBus } from '../cognitive/sharedState.js';
import { Vec3 } from 'vec3';
import type {
  ExecutiveTaskSnapshot,
  ExecutiveWorldState,
  SemanticPosition,
  SemanticTarget,
} from './executiveTypes.js';
import type { WorldProvenance } from './worldProvenance.js';
import {
  CapabilityRegistry,
  blockDropNames,
  canHarvestBlockNow,
} from './capabilityRegistry.js';

const WATERLIKE = new Set([
  'water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant',
]);

export class SemanticWorldModel {
  private revision = 0;
  private lastFingerprint = '';
  private readonly capabilityRegistry: CapabilityRegistry;

  constructor(
    private readonly bot: mineflayer.Bot,
    private readonly shared: SharedStateBus,
    private readonly provenance?: WorldProvenance,
  ) {
    this.capabilityRegistry = new CapabilityRegistry(bot);
  }

  capture(activeTask: ExecutiveTaskSnapshot): ExecutiveWorldState {
    const position = this.bot.entity.position;
    const inventory = inventoryMap(this.bot);
    const inWater = isInWater(this.bot);
    const onSolidGround = isSolidStand(this.bot.blockAt(position.offset(0, -1, 0)));

    const targets = this.buildTargets();
    const strategy = {
      mainGoal: this.shared.get().currentGoal || 'Survive as long as possible in this Hardcore world while continuing to live actively.',
      subGoals: [...this.shared.get().subGoals],
    };
    const capabilities = this.capabilityRegistry.capture(
      targets,
      [strategy.mainGoal, ...strategy.subGoals].join(' '),
    );

    const stateWithoutRevision = {
      capturedAt: Date.now(),
      player: {
        hp: this.bot.health,
        hunger: this.bot.food,
        oxygen: inWater ? Math.max(0, this.bot.oxygenLevel ?? 20) : 20,
        position: {
          x: position.x,
          y: position.y,
          z: position.z,
        },
        inWater,
        onSolidGround,
      },
      world: {
        timeOfDay: this.bot.time.timeOfDay,
        day: this.bot.time.day,
        isNight: this.bot.time.timeOfDay >= 12500 && this.bot.time.timeOfDay < 23500,
        raining: this.bot.isRaining,
      },
      inventory,
      facilities: {
        craftingTableNearby: Boolean(this.bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 8 })),
        furnaceNearby: Boolean(this.bot.findBlock({ matching: block => block.name === 'furnace', maxDistance: 8 })),
        bedNearby: Boolean(this.bot.findBlock({ matching: block => block.name.endsWith('_bed'), maxDistance: 16 })),
        shelterNearby: Boolean(this.provenance?.hasStructureNearby('shelter', position, 24)),
      },
      capabilities,
      strategy,
      activeTask,
      targets,
      recentEvents: this.shared.getRecentEvents(25_000).slice(-16).map(event => ({
        type: event.type,
        detail: event.detail,
        importance: event.importance,
      })),
    };

    const fingerprint = semanticFingerprint(stateWithoutRevision);
    if (fingerprint !== this.lastFingerprint) {
      this.revision++;
      this.lastFingerprint = fingerprint;
    }

    return {
      revision: this.revision,
      ...stateWithoutRevision,
    };
  }

  getRevision(): number {
    return this.revision;
  }

  private buildTargets(): SemanticTarget[] {
    return [
      ...this.findKnownStructures(),
      ...this.findShelterSites(),
      ...this.findExcavationSites(),
      ...this.findLandTargets(),
      ...this.findResourceSources(),
      ...this.findEntityTargets(),
      ...this.findItemDrops(),
    ].sort((a, b) => b.score - a.score).slice(0, 36);
  }

  private findKnownStructures(): SemanticTarget[] {
    const origin = this.bot.entity.position;
    const structures = this.provenance?.listStructures() ?? [];

    return structures
      .map(entry => {
        const distance = distance3(origin, entry.position);
        return {
          id: `known_structure:${entry.kind}:${entry.position.x}:${entry.position.y}:${entry.position.z}`,
          kind: 'known_structure' as const,
          position: { ...entry.position },
          distance: round1(distance),
          score: 230 - distance * 1.5,
          risk: distance <= 48 ? 'low' as const : 'medium' as const,
          metadata: {
            structureKind: entry.kind,
            completed: true,
            completedAt: entry.completedAt,
          },
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  private findExcavationSites(): SemanticTarget[] {
    const origin = this.bot.entity.position;
    const candidates: SemanticTarget[] = [];
    const originY = Math.floor(origin.y);

    for (let radius = 2; radius <= 28; radius += 2) {
      const samples = Math.max(12, Math.ceil(Math.PI * radius));
      for (let i = 0; i < samples; i++) {
        const angle = (Math.PI * 2 * i) / samples;
        const x = Math.floor(origin.x + Math.cos(angle) * radius);
        const z = Math.floor(origin.z + Math.sin(angle) * radius);
        const stand = this.findSurfaceStandableColumn(x, z, originY + 12, originY - 8);
        if (!stand) continue;

        const floor = this.bot.blockAt(new Vec3(stand.x, stand.y - 1, stand.z));
        if (!isExcavationMaterial(floor)) continue;

        const direction = this.findSafeExcavationDirection(stand);
        if (!direction) continue;

        const distance = distance3(origin, stand);
        candidates.push({
          id: `excavation_site:${stand.x}:${stand.y}:${stand.z}:${direction}`,
          kind: 'excavation_site',
          position: stand,
          distance: round1(distance),
          score: 165 - distance * 3 - Math.abs(stand.y - origin.y),
          risk: distance <= 18 ? 'low' : 'medium',
          metadata: {
            direction,
            floor: floor?.name ?? null,
            safeSteps: 4,
          },
        });
      }
      if (candidates.length >= 5 && radius >= 12) break;
    }

    return dedupeById(candidates)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  private findSafeExcavationDirection(
    stand: SemanticPosition,
  ): 'N' | 'E' | 'S' | 'W' | null {
    const directions = [
      ['N', 0, -1],
      ['E', 1, 0],
      ['S', 0, 1],
      ['W', -1, 0],
    ] as const;

    for (const [name, dx, dz] of directions) {
      let safe = true;
      for (let step = 1; step <= 4; step++) {
        const next = new Vec3(
          stand.x + dx * step,
          stand.y - step,
          stand.z + dz * step,
        );
        const support = this.bot.blockAt(next.offset(0, -1, 0));
        const feet = this.bot.blockAt(next);
        const head = this.bot.blockAt(next.offset(0, 1, 0));
        if (!isSafeExcavationSupport(support)) {
          safe = false;
          break;
        }
        if (!isExcavatableVolume(this.bot, feet) || !isExcavatableVolume(this.bot, head)) {
          safe = false;
          break;
        }
      }
      if (safe) return name;
    }
    return null;
  }

  private findShelterSites(): SemanticTarget[] {
    const origin = this.bot.entity.position;
    const candidates: SemanticTarget[] = [];
    const originY = Math.floor(origin.y);

    for (let radius = 2; radius <= 32; radius += 2) {
      const samples = Math.max(12, Math.ceil(Math.PI * radius));
      for (let i = 0; i < samples; i++) {
        const angle = (Math.PI * 2 * i) / samples;
        const x = Math.floor(origin.x + Math.cos(angle) * radius);
        const z = Math.floor(origin.z + Math.sin(angle) * radius);
        const stand = this.findSurfaceStandableColumn(x, z, originY + 32, originY - 4);
        if (!stand || !this.isFlatShelterPatch(stand)) continue;

        const distance = distance3(origin, stand);
        candidates.push({
          id: `shelter_site:${stand.x}:${stand.y}:${stand.z}`,
          kind: 'shelter_site',
          position: stand,
          distance: round1(distance),
          score: 180 - distance * 3 - Math.abs(stand.y - origin.y),
          risk: distance <= 20 ? 'low' : 'medium',
          metadata: {
            flat5x5: true,
            surfaceCandidate: true,
          },
        });
      }
      if (candidates.length >= 5 && radius >= 12) break;
    }

    return dedupeById(candidates)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  private findSurfaceStandableColumn(
    x: number,
    z: number,
    topY: number,
    bottomY: number,
  ): SemanticPosition | null {
    for (let y = topY; y >= bottomY; y--) {
      const floor = this.bot.blockAt(new Vec3(x, y - 1, z));
      const feet = this.bot.blockAt(new Vec3(x, y, z));
      const head = this.bot.blockAt(new Vec3(x, y + 1, z));
      if (!isSolidStand(floor)) continue;
      if (!isPassable(feet) || !isPassable(head)) continue;
      return { x, y, z };
    }
    return null;
  }

  private isFlatShelterPatch(center: SemanticPosition): boolean {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const floor = this.bot.blockAt(new Vec3(center.x + dx, center.y - 1, center.z + dz));
        const feet = this.bot.blockAt(new Vec3(center.x + dx, center.y, center.z + dz));
        const head = this.bot.blockAt(new Vec3(center.x + dx, center.y + 1, center.z + dz));
        if (!isSolidStand(floor) || !isPassable(feet) || !isPassable(head)) return false;
      }
    }
    return true;
  }

  private findLandTargets(): SemanticTarget[] {
    const origin = this.bot.entity.position;
    const candidates: SemanticTarget[] = [];

    // Sample nearby columns instead of asking the policy for compass directions.
    // This turns "find shore" into concrete, geolocated affordances.
    for (let radius = 2; radius <= 48; radius += 2) {
      const samples = Math.max(12, Math.ceil(Math.PI * radius));
      for (let i = 0; i < samples; i++) {
        const angle = (Math.PI * 2 * i) / samples;
        const x = Math.floor(origin.x + Math.cos(angle) * radius);
        const z = Math.floor(origin.z + Math.sin(angle) * radius);
        const stand = this.findStandableColumn(x, z);
        if (!stand) continue;

        const distance = distance3(origin, stand);
        candidates.push({
          id: `land:${stand.x}:${stand.y}:${stand.z}`,
          kind: 'land',
          position: stand,
          distance: round1(distance),
          score: 140 - distance * 4 - Math.abs(stand.y - origin.y) * 1.5,
          risk: distance <= 12 ? 'low' : 'medium',
          metadata: {
            solid: true,
            shorelineCandidate: isInWater(this.bot),
          },
        });
      }
      if (candidates.length >= 8 && radius >= 10) break;
    }

    return dedupeById(candidates)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  private findStandableColumn(x: number, z: number): SemanticPosition | null {
    const originY = Math.floor(this.bot.entity.position.y);
    for (let y = originY + 8; y >= originY - 14; y--) {
      const floor = this.bot.blockAt(new Vec3(x, y - 1, z));
      const feet = this.bot.blockAt(new Vec3(x, y, z));
      const head = this.bot.blockAt(new Vec3(x, y + 1, z));
      if (!isSolidStand(floor)) continue;
      if (!isPassable(feet) || !isPassable(head)) continue;
      return { x, y, z };
    }
    return null;
  }

  private findResourceSources(): SemanticTarget[] {
    let positions: any[] = [];
    try {
      positions = this.bot.findBlocks({
        matching: block =>
          Boolean(block?.diggable) &&
          block.name !== 'air' &&
          block.name !== 'water' &&
          block.name !== 'lava',
        maxDistance: 20,
        count: 1024,
      }) as any[];
    } catch {
      return [];
    }

    const origin = this.bot.entity.position;
    const nearestByResource = new Map<string, SemanticTarget>();

    for (const pos of positions) {
      const block = this.bot.blockAt(pos);
      if (!block || !block.diggable) continue;
      if (this.provenance?.isPlayerPlaced(block.position)) continue;
      if (!this.bot.canSeeBlock(block)) continue;
      if (!canHarvestBlockNow(this.bot, block)) continue;

      const resources = blockDropNames(this.bot, block);
      if (resources.length === 0) continue;
      const distance = origin.distanceTo(block.position);

      for (const resource of resources) {
        const existing = nearestByResource.get(resource);
        if (existing && existing.distance <= distance) continue;
        nearestByResource.set(resource, {
          id: `resource_source:${resource}:${block.position.x}:${block.position.y}:${block.position.z}`,
          kind: 'resource_source',
          position: {
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
          },
          distance: round1(distance),
          score: 190 - distance * 2,
          risk: distance <= 12 ? 'low' : 'medium',
          metadata: {
            resource,
            blockName: block.name,
            blockTargetId: `block:${block.name}:${block.position.x}:${block.position.y}:${block.position.z}`,
            harvestableNow: true,
          },
        });
      }
    }

    return [...nearestByResource.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }

  private findEntityTargets(): SemanticTarget[] {
    const origin = this.bot.entity.position;
    return Object.values(this.bot.entities)
      .filter(entity =>
        Boolean(
          entity &&
          entity !== this.bot.entity &&
          entity.name &&
          entity.name !== 'item' &&
          entity.position &&
          ((entity as any).type === 'mob' || String((entity as any).kind ?? '').toLowerCase().includes('mob')),
        ),
      )
      .map(entity => {
        const distance = origin.distanceTo(entity.position);
        const kind = String((entity as any).kind ?? '');
        const kindLower = kind.toLowerCase();
        const hostile = kindLower.includes('hostile') || kindLower.includes('monster');
        return {
          id: `entity:${entity.id}`,
          kind: 'entity' as const,
          position: {
            x: entity.position.x,
            y: entity.position.y,
            z: entity.position.z,
          },
          distance: round1(distance),
          score: 145 - distance,
          risk: hostile && distance <= 12 ? 'high' as const : distance <= 20 ? 'low' as const : 'medium' as const,
          metadata: {
            entityId: entity.id,
            entityName: entity.name ?? 'unknown',
            entityKind: kind || null,
            hostile,
          },
        };
      })
      .filter(target => target.distance <= 32)
      .sort((a, b) => b.score - a.score)
      .slice(0, 16);
  }

  private findItemDrops(): SemanticTarget[] {
    const origin = this.bot.entity.position;
    return Object.values(this.bot.entities)
      .filter(entity => Boolean(entity && entity.name === 'item' && entity.position))
      .map(entity => {
        const distance = origin.distanceTo(entity.position);
        return {
          id: `item_drop:${entity.id}`,
          kind: 'item_drop' as const,
          position: {
            x: entity.position.x,
            y: entity.position.y,
            z: entity.position.z,
          },
          distance: round1(distance),
          score: 170 - distance * 3,
          risk: distance <= 8 ? 'low' as const : 'medium' as const,
          metadata: {
            entityId: entity.id,
            collectible: true,
            itemName: (() => {
              try {
                return (entity as any).getDroppedItem?.()?.name ?? null;
              } catch {
                return null;
              }
            })(),
          },
        };
      })
      .filter(target => target.distance <= 20)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }


}

function inventoryMap(bot: mineflayer.Bot): Record<string, number> {
  const inventory: Record<string, number> = {};
  for (const item of bot.inventory.items()) {
    inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
  }
  return inventory;
}

function isInWater(bot: mineflayer.Bot): boolean {
  const position = bot.entity.position;
  const names = [
    bot.blockAt(position)?.name,
    bot.blockAt(position.offset(0, 1, 0))?.name,
    bot.blockAt(position.offset(0, -1, 0))?.name,
  ].filter(Boolean) as string[];
  return names.some(name => WATERLIKE.has(name));
}

function isSolidStand(block: any | null): boolean {
  if (!block) return false;
  if (WATERLIKE.has(block.name) || block.name === 'lava') return false;
  return block.boundingBox === 'block';
}

function isPassable(block: any | null): boolean {
  if (!block) return false;
  if (WATERLIKE.has(block.name) || block.name === 'lava') return false;
  return block.boundingBox !== 'block';
}

function distance3(origin: { x: number; y: number; z: number }, target: SemanticPosition): number {
  return Math.hypot(origin.x - target.x, origin.y - target.y, origin.z - target.z);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function dedupeById(targets: SemanticTarget[]): SemanticTarget[] {
  const seen = new Set<string>();
  return targets.filter(target => {
    if (seen.has(target.id)) return false;
    seen.add(target.id);
    return true;
  });
}

function semanticFingerprint(state: Omit<ExecutiveWorldState, 'revision'>): string {
  const inventory = Object.entries(state.inventory)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}:${count}`)
    .join(',');

  // Do not include ordinary position drift in the revision. Decisions are made
  // only at task boundaries, and water/current physics can move the bot while
  // the model is thinking. Revision tracks semantic changes that can invalidate
  // a decision: safety context, inventory, strategy, or task lifecycle.
  return [
    state.player.inWater ? 1 : 0,
    state.player.onSolidGround ? 1 : 0,
    Math.round(state.player.hp * 2) / 2,
    state.player.hunger,
    inventory,
    state.facilities.craftingTableNearby ? 1 : 0,
    state.facilities.furnaceNearby ? 1 : 0,
    state.facilities.bedNearby ? 1 : 0,
    state.facilities.shelterNearby ? 1 : 0,
    state.capabilities.gather.map(entry => entry.resource).sort().join(','),
    state.capabilities.craft.map(entry => entry.item).sort().join(','),
    state.capabilities.entityActions.map(entry => entry.targetId).sort().join(','),
    state.strategy.mainGoal,
    state.activeTask.id,
    state.activeTask.status,
  ].join('|');
}


function isSafeExcavationSupport(block: any | null): boolean {
  if (!block) return false;
  if (WATERLIKE.has(block.name) || block.name === 'lava') return false;
  return block.boundingBox === 'block';
}

function isExcavatableVolume(bot: mineflayer.Bot, block: any | null): boolean {
  if (!block) return false;
  if (block.name === 'air' || block.boundingBox === 'empty') return true;
  if (WATERLIKE.has(block.name) || block.name === 'lava') return false;
  if (!block.diggable || block.boundingBox !== 'block') return false;
  return canHarvestBlockNow(bot, block);
}
