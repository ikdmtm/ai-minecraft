import mineflayer from 'mineflayer';
import { Movements, goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { SharedStateBus, ReflexState } from '../cognitive/sharedState.js';
import type {
  CompassDirection,
  CraftItem,
  JevWorldState,
  SkillSnapshot,
  TypedGameplayDecision,
  WorldCandidate,
} from './typedActions.js';
import { isFoodAnimal } from './worldSensor.js';

const FOOD_ITEMS = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'baked_potato', 'apple',
  'golden_carrot', 'sweet_berries', 'glow_berries', 'melon_slice', 'dried_kelp',
  'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'salmon', 'cod',
]);

const WEAPON_ORDER = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe',
];

export class SkillExecutor {
  private sequence = 0;
  private cancellationToken = 0;
  private safetyOverrideUntil = 0;
  private current: SkillSnapshot = {
    id: 0,
    action: 'NONE',
    targetId: null,
    status: 'idle',
    startedAt: null,
    updatedAt: Date.now(),
    detail: '',
  };

  constructor(
    private readonly bot: mineflayer.Bot,
    private readonly shared: SharedStateBus,
  ) {}

  snapshot(): SkillSnapshot {
    return { ...this.current };
  }

  stop(): void {
    this.cancel('runtime_stop');
  }

  dispatch(
    decision: TypedGameplayDecision,
    world: JevWorldState | null,
    priority: 'normal' | 'safety' = 'normal',
  ): void {
    if (priority === 'normal' && Date.now() < this.safetyOverrideUntil) return;
    if (priority === 'safety') this.safetyOverrideUntil = Date.now() + 1_500;

    if (decision.action === 'CONTINUE') {
      if (this.current.status === 'running') return;
      return;
    }

    if (decision.action === 'WAIT') {
      if (this.current.status === 'running') return;
      this.setIdle('wait');
      return;
    }

    const targetId = decision.blockTargetId ?? decision.entityTargetId ?? null;
    if (
      this.current.status === 'running' &&
      this.current.action === decision.action &&
      this.current.targetId === targetId
    ) {
      return;
    }

    this.cancel(`switch_to_${decision.action}`);
    const token = ++this.cancellationToken;
    const skillId = ++this.sequence;
    this.current = {
      id: skillId,
      action: decision.action,
      targetId,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      detail: decision.reason ?? '',
    };
    this.shared.setReflexState(actionToReflexState(decision.action));
    this.log('skill_started', {
      skill_id: skillId,
      action: decision.action,
      target_id: targetId,
      craft_item: decision.craftItem ?? null,
      direction: decision.direction ?? null,
      source: decision.source,
      confidence: decision.confidence,
    });

    void this.execute(decision, world, token, skillId);
  }

  private async execute(
    decision: TypedGameplayDecision,
    world: JevWorldState | null,
    token: number,
    skillId: number,
  ): Promise<void> {
    try {
      switch (decision.action) {
        case 'EXPLORE':
          await this.explore(decision.direction ?? 'E', token);
          break;
        case 'MINE':
          await this.mine(this.findBlockCandidate(world, decision.blockTargetId), token);
          break;
        case 'CRAFT':
          await this.craft(decision.craftItem ?? 'planks', token);
          break;
        case 'BUILD_SHELTER':
          await this.buildShelter(token);
          break;
        case 'HUNT_FOOD':
          await this.huntFood(this.findEntityCandidate(world, decision.entityTargetId), token);
          break;
        case 'EAT':
          await this.eat(token);
          break;
        case 'FLEE':
          await this.flee(decision.direction ?? 'E', token);
          break;
        case 'ATTACK':
          await this.attack(this.findEntityCandidate(world, decision.entityTargetId), token);
          break;
        case 'SLEEP':
          await this.sleepInBed(token);
          break;
        default:
          break;
      }

      if (token !== this.cancellationToken || this.current.id !== skillId) return;
      this.current = {
        ...this.current,
        status: 'succeeded',
        updatedAt: Date.now(),
        detail: 'completed',
      };
      this.log('skill_succeeded', {
        skill_id: skillId,
        action: decision.action,
        duration_ms: this.current.startedAt ? Date.now() - this.current.startedAt : null,
      });
      this.shared.pushEvent({
        type: 'skill_succeeded',
        detail: `${decision.action}${this.current.targetId ? ` ${this.current.targetId}` : ''}`,
        importance: 'low',
      });
    } catch (error) {
      if (token !== this.cancellationToken || this.current.id !== skillId) return;
      const message = error instanceof Error ? error.message : String(error);
      this.current = {
        ...this.current,
        status: 'failed',
        updatedAt: Date.now(),
        detail: message,
      };
      try { this.bot.pathfinder.stop(); } catch { /* best effort */ }
      this.log('skill_failed', {
        skill_id: skillId,
        action: decision.action,
        target_id: this.current.targetId,
        message,
      });
      this.shared.pushEvent({
        type: 'skill_failed',
        detail: `${decision.action}: ${message}`,
        importance: 'high',
      });
    }
  }

  private cancel(reason: string): void {
    this.cancellationToken++;
    try { this.bot.pathfinder.stop(); } catch { /* best effort */ }
    if (this.current.status === 'running') {
      this.log('skill_interrupted', {
        skill_id: this.current.id,
        action: this.current.action,
        reason,
      });
      this.current = {
        ...this.current,
        status: 'interrupted',
        updatedAt: Date.now(),
        detail: reason,
      };
    }
  }

  private setIdle(detail: string): void {
    this.current = {
      id: this.current.id,
      action: 'NONE',
      targetId: null,
      status: 'idle',
      startedAt: null,
      updatedAt: Date.now(),
      detail,
    };
    this.shared.setReflexState('idle');
  }

  private async explore(direction: CompassDirection, token: number): Promise<void> {
    const [dx, dz] = directionVector(direction);
    const start = this.bot.entity.position;
    const distance = 18;
    const tx = start.x + dx * distance;
    const tz = start.z + dz * distance;
    this.updateDetail(`exploring ${direction} toward ${tx.toFixed(1)},${tz.toFixed(1)}`);
    const movements = new Movements(this.bot);
    movements.allowSprinting = true;
    this.bot.pathfinder.setMovements(movements);
    await this.bot.pathfinder.goto(new goals.GoalXZ(tx, tz));
    this.assertActive(token);
  }

  private async mine(candidate: WorldCandidate | null, token: number): Promise<void> {
    if (!candidate || candidate.kind !== 'block') throw new Error('no_valid_block_target');
    const pos = new Vec3(candidate.position.x, candidate.position.y, candidate.position.z);
    const block = this.bot.blockAt(pos);
    if (!block || block.name === 'air') throw new Error(`target_block_missing:${candidate.id}`);

    this.updateDetail(`moving_to ${block.name} ${block.position.x},${block.position.y},${block.position.z}`);
    const movements = new Movements(this.bot);
    movements.allowSprinting = true;
    this.bot.pathfinder.setMovements(movements);
    await this.bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2));
    this.assertActive(token);

    const fresh = this.bot.blockAt(pos);
    if (!fresh || fresh.name === 'air') return;
    if (!this.bot.canDigBlock(fresh)) throw new Error(`cannot_dig:${fresh.name}`);
    this.updateDetail(`digging ${fresh.name}`);
    await this.bot.dig(fresh);
    this.assertActive(token);
    this.shared.pushEvent({ type: 'mined', detail: fresh.name, importance: 'low' });

    await delay(250);
    this.assertActive(token);
    try {
      await this.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 1));
    } catch {
      // Picking up the drop is best effort; mining already succeeded.
    }
  }

  private async craft(item: CraftItem, token: number): Promise<void> {
    if (item === 'none') throw new Error('no_craft_item_selected');
    this.updateDetail(`crafting ${item}`);

    if (item === 'planks') {
      const log = this.bot.inventory.items().find(entry => entry.name.endsWith('_log'));
      if (!log) throw new Error('no_log_for_planks');
      const planks = `${log.name.slice(0, -4)}_planks`;
      await this.craftNamed(planks, null);
      return;
    }

    if (item === 'sticks' || item === 'crafting_table') {
      await this.ensurePlanks();
      await this.craftNamed(item === 'sticks' ? 'stick' : 'crafting_table', null);
      return;
    }

    const actualName = item;
    const table = await this.ensureCraftingTable(token);
    await this.craftNamed(actualName, table);
  }

  private async craftNamed(itemName: string, table: any | null): Promise<void> {
    const itemId = this.bot.registry.itemsByName[itemName]?.id;
    if (!itemId) throw new Error(`unknown_item:${itemName}`);
    const recipes = this.bot.recipesFor(itemId, null, 1, table ?? null);
    if (recipes.length === 0) throw new Error(`no_recipe:${itemName}`);
    await this.bot.craft(recipes[0], 1, table ?? undefined);
    this.shared.pushEvent({ type: 'crafted', detail: itemName, importance: 'low' });
  }

  private async ensurePlanks(): Promise<void> {
    if (this.bot.inventory.items().some(item => item.name.endsWith('_planks'))) return;
    const log = this.bot.inventory.items().find(item => item.name.endsWith('_log'));
    if (!log) throw new Error('no_logs_for_planks');
    await this.craftNamed(`${log.name.slice(0, -4)}_planks`, null);
  }

  private async ensureCraftingTable(token: number): Promise<any> {
    let table = this.bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 8 });
    if (table) return table;

    let item = this.bot.inventory.items().find(entry => entry.name === 'crafting_table');
    if (!item) {
      await this.ensurePlanks();
      await this.craftNamed('crafting_table', null);
      item = this.bot.inventory.items().find(entry => entry.name === 'crafting_table');
    }
    if (!item) throw new Error('crafting_table_not_in_inventory');

    table = await this.placeAdjacent(item, token);
    if (!table) throw new Error('failed_to_place_crafting_table');
    return table;
  }

  private async placeAdjacent(item: any, token: number): Promise<any | null> {
    const base = this.bot.entity.position.floored();
    const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    await this.bot.equip(item, 'hand');
    for (const [dx, dz] of offsets) {
      this.assertActive(token);
      const ground = this.bot.blockAt(base.offset(dx, -1, dz));
      const target = this.bot.blockAt(base.offset(dx, 0, dz));
      if (!ground || ground.name === 'air' || (target && target.name !== 'air')) continue;
      try {
        await this.bot.placeBlock(ground, new Vec3(0, 1, 0));
        await delay(150);
        return this.bot.blockAt(base.offset(dx, 0, dz));
      } catch {
        // Try another adjacent location.
      }
    }
    return null;
  }

  private async buildShelter(token: number): Promise<void> {
    const base = this.bot.entity.position.floored();
    const offsets = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0],           [1, 0],
      [-1, 1],  [0, 1], [1, 1],
    ] as const;
    let placed = 0;

    for (const [dx, dz] of offsets) {
      this.assertActive(token);
      for (let dy = 1; dy <= 2; dy++) {
        const targetPos = base.offset(dx, dy, dz);
        const existing = this.bot.blockAt(targetPos);
        if (existing && existing.name !== 'air') continue;
        const item = this.nextBuildItem();
        if (!item) {
          if (placed >= 6) return;
          throw new Error(`insufficient_build_material:placed=${placed}`);
        }
        await this.bot.equip(item, 'hand');
        const reference = this.bot.blockAt(base.offset(dx, dy - 1, dz));
        if (!reference || reference.name === 'air') continue;
        try {
          await this.bot.placeBlock(reference, new Vec3(0, 1, 0));
          placed++;
          await delay(70);
        } catch {
          // Some faces are not placeable; continue building the rest of the ring.
        }
      }
    }

    if (placed < 6) throw new Error(`shelter_too_incomplete:placed=${placed}`);
    this.shared.pushEvent({ type: 'shelter_built', detail: `placed=${placed}`, importance: 'high' });
  }

  private nextBuildItem(): any | null {
    return this.bot.inventory.items().find(item =>
      item.name === 'dirt' || item.name === 'cobblestone' || item.name.endsWith('_planks') || item.name.endsWith('_log'),
    ) ?? null;
  }

  private async huntFood(candidate: WorldCandidate | null, token: number): Promise<void> {
    let entity = candidate ? this.entityFromCandidate(candidate) : null;
    if (!entity || !entity.name || !isFoodAnimal(entity.name)) {
      entity = this.bot.nearestEntity(e => Boolean(e.name && isFoodAnimal(e.name)));
    }
    if (!entity) throw new Error('no_food_animal_target');
    await this.approachAndAttack(entity, token, 8);
    this.shared.pushEvent({ type: 'hunted', detail: entity.name ?? 'animal', importance: 'medium' });
  }

  private async attack(candidate: WorldCandidate | null, token: number): Promise<void> {
    const entity = candidate ? this.entityFromCandidate(candidate) : null;
    if (!entity) throw new Error('no_attack_target');
    await this.equipBestWeapon();
    await this.approachAndAttack(entity, token, 6);
  }

  private async approachAndAttack(entity: any, token: number, maxHits: number): Promise<void> {
    const movements = new Movements(this.bot);
    movements.allowSprinting = true;
    this.bot.pathfinder.setMovements(movements);
    await this.bot.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
    this.assertActive(token);

    for (let i = 0; i < maxHits; i++) {
      this.assertActive(token);
      const fresh = this.bot.entities[entity.id];
      if (!fresh || !fresh.position) break;
      const distance = this.bot.entity.position.distanceTo(fresh.position);
      if (distance > 4) {
        await this.bot.pathfinder.goto(new goals.GoalNear(fresh.position.x, fresh.position.y, fresh.position.z, 2));
        this.assertActive(token);
      }
      this.bot.attack(fresh);
      await delay(550);
    }
  }

  private async eat(token: number): Promise<void> {
    const food = this.bot.inventory.items().find(item => FOOD_ITEMS.has(item.name));
    if (!food) throw new Error('no_food_available');
    await this.bot.equip(food, 'hand');
    this.assertActive(token);
    await this.bot.consume();
  }

  private async flee(direction: CompassDirection, token: number): Promise<void> {
    const hostile = this.bot.nearestEntity(entity => Boolean(entity.name && isDangerous(entity.name)));
    let dx: number;
    let dz: number;
    if (hostile) {
      dx = this.bot.entity.position.x - hostile.position.x;
      dz = this.bot.entity.position.z - hostile.position.z;
      const length = Math.hypot(dx, dz) || 1;
      dx /= length;
      dz /= length;
    } else {
      [dx, dz] = directionVector(direction);
    }
    const start = this.bot.entity.position;
    const tx = start.x + dx * 18;
    const tz = start.z + dz * 18;
    const movements = new Movements(this.bot);
    movements.allowSprinting = true;
    this.bot.pathfinder.setMovements(movements);
    await this.bot.pathfinder.goto(new goals.GoalXZ(tx, tz));
    this.assertActive(token);
  }

  private async sleepInBed(token: number): Promise<void> {
    const bed = this.bot.findBlock({ matching: block => block.name.includes('bed'), maxDistance: 32 });
    if (!bed) throw new Error('no_bed_nearby');
    const movements = new Movements(this.bot);
    this.bot.pathfinder.setMovements(movements);
    await this.bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
    this.assertActive(token);
    await this.bot.sleep(bed);
  }

  private async equipBestWeapon(): Promise<void> {
    for (const name of WEAPON_ORDER) {
      const item = this.bot.inventory.items().find(entry => entry.name === name);
      if (item) {
        await this.bot.equip(item, 'hand');
        return;
      }
    }
  }

  private findBlockCandidate(world: JevWorldState | null, id: string | undefined): WorldCandidate | null {
    if (!world || !id) return null;
    return world.blockCandidates.find(candidate => candidate.id === id) ?? null;
  }

  private findEntityCandidate(world: JevWorldState | null, id: string | undefined): WorldCandidate | null {
    if (!world || !id) return null;
    return world.entityCandidates.find(candidate => candidate.id === id) ?? null;
  }

  private entityFromCandidate(candidate: WorldCandidate): any | null {
    if (candidate.kind !== 'entity') return null;
    const match = /^entity:(\d+)$/.exec(candidate.id);
    if (!match) return null;
    return this.bot.entities[Number(match[1])] ?? null;
  }

  private updateDetail(detail: string): void {
    this.current = { ...this.current, detail, updatedAt: Date.now() };
  }

  private assertActive(token: number): void {
    if (token !== this.cancellationToken) throw new Error('skill_interrupted');
  }

  private log(kind: string, payload: Record<string, unknown>): void {
    console.log(JSON.stringify({ ts: new Date().toISOString(), kind, ...payload }));
  }
}

function actionToReflexState(action: TypedGameplayDecision['action']): ReflexState {
  switch (action) {
    case 'EXPLORE': return 'exploring';
    case 'MINE': return 'mining';
    case 'CRAFT':
    case 'BUILD_SHELTER': return 'crafting';
    case 'HUNT_FOOD': return 'gathering';
    case 'EAT': return 'eating';
    case 'FLEE': return 'fleeing';
    case 'ATTACK': return 'combat';
    case 'SLEEP': return 'sleeping';
    default: return 'idle';
  }
}

function directionVector(direction: CompassDirection): [number, number] {
  const diag = Math.SQRT1_2;
  switch (direction) {
    case 'N': return [0, -1];
    case 'NE': return [diag, -diag];
    case 'E': return [1, 0];
    case 'SE': return [diag, diag];
    case 'S': return [0, 1];
    case 'SW': return [-diag, diag];
    case 'W': return [-1, 0];
    case 'NW': return [-diag, -diag];
  }
}

function isDangerous(name: string): boolean {
  return [
    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'drowned', 'husk',
    'stray', 'pillager', 'vindicator', 'evoker', 'ravager', 'slime', 'phantom', 'blaze', 'ghast',
  ].includes(name);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
