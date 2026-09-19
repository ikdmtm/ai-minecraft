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
  private lastSurfaceAnchor: SemanticPosition | null = null;

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

    this.observeSurfaceAnchor();
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
    // Spatial affordances must never be crowded out by resource/entity targets.
    // Scores are useful within a kind, but a global top-N made rich scenes erase
    // every answer to "where can I move/build/excavate?".
    const spatial = [
      ...this.findKnownStructures(),
      ...this.findShelterSites(),
      ...this.findExcavationSites(),
      ...this.findLandTargets(),
    ];
    const resources = this.findResourceSources().slice(0, 18);
    const drops = this.findItemDrops().slice(0, 6);
    const entities = this.findEntityTargets().slice(0, 10);

    return dedupeById([
      ...spatial,
      ...drops,
      ...resources,
      ...entities,
    ]).slice(0, 56);
  }

  private observeSurfaceAnchor(): void {
    const p = this.bot.entity.position.floored();
    const current = { x: p.x, y: p.y, z: p.z };
    if (!isLikelySurfaceStand(this.bot, current)) return;
    this.lastSurfaceAnchor = current;
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
    const current: SemanticPosition = {
      x: Math.floor(origin.x),
      y: Math.floor(origin.y),
      z: Math.floor(origin.z),
    };

    // If we previously observed the bot on the natural surface and it is now
    // several blocks below it, expose an upward excavation affordance. This is
    // spatial memory, not an攻略 sequence: any cause of getting underground can
    // be recovered by a short re-observed ascent segment.
    if (this.lastSurfaceAnchor && this.lastSurfaceAnchor.y - current.y >= 4) {
      const floor = this.bot.blockAt(new Vec3(current.x, current.y - 1, current.z));
      const preferred = preferredCardinalToward(current, this.lastSurfaceAnchor);
      const direction = isSafeExcavationSupport(floor)
        ? this.findSafeExcavationDirection(current, 'up', preferred)
        : null;
      if (direction) {
        candidates.push({
          id: `excavation_site:surface_return:${current.x}:${current.y}:${current.z}:${direction}`,
          kind: 'excavation_site',
          position: current,
          distance: 0,
          score: 225,
          risk: 'low',
          metadata: {
            direction,
            mode: 'up',
            purpose: 'surface_return',
            rememberedSurfaceY: this.lastSurfaceAnchor.y,
            safeSteps: 4,
          },
        });
      }
    }

    const addDownwardCandidate = (stand: SemanticPosition): void => {
      const floor = this.bot.blockAt(new Vec3(stand.x, stand.y - 1, stand.z));
      if (!isSafeExcavationSupport(floor)) return;
      const direction = this.findSafeExcavationDirection(stand, 'down');
      if (!direction) return;
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
          mode: 'down',
          floor: floor?.name ?? null,
          safeSteps: 4,
        },
      });
    };

    // The current grounded position is often the best safe place to begin a
    // controlled staircase. The old radius=2 start accidentally excluded it.
    addDownwardCandidate(current);

    for (let radius = 2; radius <= 28; radius += 2) {
      const samples = Math.max(12, Math.ceil(Math.PI * radius));
      for (let i = 0; i < samples; i++) {
        const angle = (Math.PI * 2 * i) / samples;
        const x = Math.floor(origin.x + Math.cos(angle) * radius);
        const z = Math.floor(origin.z + Math.sin(angle) * radius);
        const stand = this.findSurfaceStandableColumn(x, z, originY + 12, originY - 8);
        if (!stand) continue;
        addDownwardCandidate(stand);
      }
      if (candidates.length >= 6 && radius >= 12) break;
    }

    return dedupeById(candidates)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  private findSafeExcavationDirection(
    stand: SemanticPosition,
    mode: 'down' | 'up',
    preferred?: 'N' | 'E' | 'S' | 'W' | null,
  ): 'N' | 'E' | 'S' | 'W' | null {
    const all = [
      ['N', 0, -1],
      ['E', 1, 0],
      ['S', 0, 1],
      ['W', -1, 0],
    ] as const;
    const directions = preferred
      ? [...all.filter(([name]) => name === preferred), ...all.filter(([name]) => name !== preferred)]
      : [...all];
    const verticalStep = mode === 'up' ? 1 : -1;

    for (const [name, dx, dz] of directions) {
      let safe = true;
      for (let step = 1; step <= 4; step++) {
        const next = new Vec3(
          stand.x + dx * step,
          stand.y + verticalStep * step,
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

    const addCandidate = (stand: SemanticPosition): void => {
      if (!this.isShelterFootprintBuildable(stand)) return;
      const distance = distance3(origin, stand);
      candidates.push({
        id: `shelter_site:${stand.x}:${stand.y}:${stand.z}`,
        kind: 'shelter_site',
        position: stand,
        distance: round1(distance),
        score: 190 - distance * 3 - Math.abs(stand.y - origin.y),
        risk: distance <= 20 ? 'low' : 'medium',
        metadata: {
          buildableFootprint: 'compact_cross',
          surfaceCandidate: true,
          foliageClearable: true,
        },
      });
    };

    // Include the place the bot is already standing. Excluding radius zero was
    // particularly harmful in forests where the nearest clear footprint is the
    // current one and surrounding samples sit under low leaves.
    addCandidate({
      x: Math.floor(origin.x),
      y: Math.floor(origin.y),
      z: Math.floor(origin.z),
    });

    for (let radius = 2; radius <= 32; radius += 2) {
      const samples = Math.max(12, Math.ceil(Math.PI * radius));
      for (let i = 0; i < samples; i++) {
        const angle = (Math.PI * 2 * i) / samples;
        const x = Math.floor(origin.x + Math.cos(angle) * radius);
        const z = Math.floor(origin.z + Math.sin(angle) * radius);
        const stand = this.findSurfaceStandableColumn(x, z, originY + 32, originY - 4);
        if (!stand) continue;
        addCandidate(stand);
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
      if (!isStableTerrainSupport(floor)) continue;
      if (!isPassable(feet) || !isPassable(head)) continue;
      return { x, y, z };
    }
    return null;
  }

  private isShelterFootprintBuildable(center: SemanticPosition): boolean {
    const footprint = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, -1],
      [0, 1],
    ] as const;

    for (const [dx, dz] of footprint) {
      const floor = this.bot.blockAt(new Vec3(center.x + dx, center.y - 1, center.z + dz));
      const feet = this.bot.blockAt(new Vec3(center.x + dx, center.y, center.z + dz));
      const head = this.bot.blockAt(new Vec3(center.x + dx, center.y + 1, center.z + dz));
      if (!isStableTerrainSupport(floor)) return false;

      // The center must already be genuinely standable so navigation can reach
      // it without secretly digging. Wall/door columns may contain foliage or
      // plants that the shelter primitive can explicitly clear before placing.
      if (dx === 0 && dz === 0) {
        if (!isPassable(feet) || !isPassable(head)) return false;
      } else if (!isBuildClearance(feet) || !isBuildClearance(head)) {
        return false;
      }

      if (
        (feet && this.provenance?.isPlayerPlaced(feet.position)) ||
        (head && this.provenance?.isPlayerPlaced(head.position))
      ) {
        return false;
      }
    }

    const roofCenter = this.bot.blockAt(new Vec3(center.x, center.y + 2, center.z));
    const roofEast = this.bot.blockAt(new Vec3(center.x + 1, center.y + 2, center.z));
    return isBuildClearance(roofCenter) && isBuildClearance(roofEast);
  }

  private findLandTargets(): SemanticTarget[] {
    const origin = this.bot.entity.position;
    const candidates: SemanticTarget[] = [];

    const addCandidate = (stand: SemanticPosition, local = false): void => {
      const floor = this.bot.blockAt(new Vec3(stand.x, stand.y - 1, stand.z));
      const feet = this.bot.blockAt(new Vec3(stand.x, stand.y, stand.z));
      const head = this.bot.blockAt(new Vec3(stand.x, stand.y + 1, stand.z));
      if (!isStableTerrainSupport(floor) || !isPassable(feet) || !isPassable(head)) return;
      const distance = distance3(origin, stand);
      candidates.push({
        id: `land:${stand.x}:${stand.y}:${stand.z}`,
        kind: 'land',
        position: stand,
        distance: round1(distance),
        score: (local ? 188 : 172) - distance * 2 - Math.abs(stand.y - origin.y),
        risk: distance <= 16 ? 'low' : 'medium',
        metadata: {
          solid: true,
          shorelineCandidate: isInWater(this.bot),
          localStand: local,
        },
      });
    };

    addCandidate({
      x: Math.floor(origin.x),
      y: Math.floor(origin.y),
      z: Math.floor(origin.z),
    }, true);

    for (let radius = 2; radius <= 48; radius += 2) {
      const samples = Math.max(12, Math.ceil(Math.PI * radius));
      for (let i = 0; i < samples; i++) {
        const angle = (Math.PI * 2 * i) / samples;
        const x = Math.floor(origin.x + Math.cos(angle) * radius);
        const z = Math.floor(origin.z + Math.sin(angle) * radius);
        const stand = this.findStandableColumn(x, z);
        if (!stand) continue;
        addCandidate(stand);
      }
      if (candidates.length >= 8 && radius >= 10) break;
    }

    return dedupeById(candidates)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  private findStandableColumn(x: number, z: number): SemanticPosition | null {
    const originY = Math.floor(this.bot.entity.position.y);
    for (let y = originY + 24; y >= originY - 16; y--) {
      const floor = this.bot.blockAt(new Vec3(x, y - 1, z));
      const feet = this.bot.blockAt(new Vec3(x, y, z));
      const head = this.bot.blockAt(new Vec3(x, y + 1, z));
      if (!isStableTerrainSupport(floor)) continue;
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
      // Resource gathering must not silently become excavation by removing the
      // floor beneath/next to the bot. Controlled terrain opening belongs to
      // excavation_site + DIG_STAIRCASE, which is re-observed segment by segment.
      if (isUnsafeSupportMiningTarget(origin, block.position)) continue;
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
    state.strategy.mainGoal,
    state.activeTask.id,
    state.activeTask.status,
  ].join('|');
}


function isStableTerrainSupport(block: any | null): boolean {
  if (!block) return false;
  if (WATERLIKE.has(block.name) || block.name === 'lava') return false;
  if (block.boundingBox !== 'block') return false;
  if (isGravityAffectedSupport(block.name)) return false;
  if (isFoliageOrTrunk(block.name)) return false;

  // Prefer physical/world semantics over version-sensitive material labels.
  // Grass, dirt, stone, deepslate, ores and similar natural full blocks are
  // valid support even when prismarine-block does not expose the legacy
  // "rock"/"dirt" material string for the current Minecraft version.
  return block.diggable !== false;
}

function isGravityAffectedSupport(name: string): boolean {
  return (
    name === 'sand' ||
    name === 'red_sand' ||
    name === 'gravel' ||
    name.endsWith('_concrete_powder')
  );
}

function isFoliageOrTrunk(name: string): boolean {
  return (
    name.endsWith('_leaves') ||
    name.endsWith('_log') ||
    name.endsWith('_wood') ||
    name === 'mushroom_stem' ||
    name === 'cactus' ||
    name === 'bamboo'
  );
}

function isSoftNaturalObstruction(block: any | null): boolean {
  if (!block) return false;
  if (isPassable(block)) return true;
  if (WATERLIKE.has(block.name) || block.name === 'lava') return false;
  const name = String(block.name ?? '');
  return (
    name.endsWith('_leaves') ||
    name.endsWith('_sapling') ||
    name.endsWith('_flower') ||
    name === 'grass' ||
    name === 'short_grass' ||
    name === 'tall_grass' ||
    name === 'fern' ||
    name === 'large_fern' ||
    name === 'dead_bush' ||
    name === 'vine' ||
    name === 'glow_lichen' ||
    name === 'snow'
  );
}

function isBuildClearance(block: any | null): boolean {
  return isPassable(block) || isSoftNaturalObstruction(block);
}

function isLikelySurfaceStand(bot: mineflayer.Bot, stand: SemanticPosition): boolean {
  const floor = bot.blockAt(new Vec3(stand.x, stand.y - 1, stand.z));
  const feet = bot.blockAt(new Vec3(stand.x, stand.y, stand.z));
  const head = bot.blockAt(new Vec3(stand.x, stand.y + 1, stand.z));
  if (!isStableTerrainSupport(floor) || !isPassable(feet) || !isPassable(head)) return false;

  // A forest canopy still counts as surface. What disqualifies a position is
  // terrain/structure overhead, not leaves or plants.
  for (let dy = 2; dy <= 16; dy++) {
    const above = bot.blockAt(new Vec3(stand.x, stand.y + dy, stand.z));
    if (!above) return false;
    if (isPassable(above) || isSoftNaturalObstruction(above)) continue;
    return false;
  }
  return true;
}

function preferredCardinalToward(
  from: SemanticPosition,
  to: SemanticPosition,
): 'N' | 'E' | 'S' | 'W' | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) < 1 && Math.abs(dz) < 1) return null;
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 'E' : 'W';
  return dz >= 0 ? 'S' : 'N';
}

function isUnsafeSupportMiningTarget(
  player: { x: number; y: number; z: number },
  block: { x: number; y: number; z: number },
): boolean {
  const horizontal = Math.hypot(player.x - (block.x + 0.5), player.z - (block.z + 0.5));
  const playerFeetY = Math.floor(player.y);
  return horizontal <= 1.45 && block.y <= playerFeetY - 1 && block.y >= playerFeetY - 2;
}

function isSafeExcavationSupport(block: any | null): boolean {
  return isStableTerrainSupport(block);
}

function isExcavatableVolume(bot: mineflayer.Bot, block: any | null): boolean {
  if (!block) return false;
  if (block.name === 'air' || block.boundingBox === 'empty') return true;
  if (WATERLIKE.has(block.name) || block.name === 'lava') return false;
  if (!block.diggable || block.boundingBox !== 'block') return false;
  return canHarvestBlockNow(bot, block);
}
