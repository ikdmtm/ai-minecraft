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

const PICKAXE_ORDER = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
const AXE_ORDER = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'];
const SHOVEL_ORDER = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel'];
const NORMAL_LIQUID_COST = 12;

export class SkillExecutor {
  private sequence = 0;
  private cancellationToken = 0;
  private safetyOverrideUntil = 0;
  private readonly blockedTargets = new Map<string, number>();
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

  isTargetTemporarilyBlocked(id: string): boolean {
    const until = this.blockedTargets.get(id) ?? 0;
    if (until <= Date.now()) {
      this.blockedTargets.delete(id);
      return false;
    }
    return true;
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

    // Normal policy decisions never pre-empt an in-flight embodied skill.
    // Safety is the only layer allowed to interrupt. This avoids oscillating
    // between plausible actions while pathfinding/digging/building is underway.
    if (priority === 'normal' && this.current.status === 'running') return;

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
    if (targetId && this.isTargetTemporarilyBlocked(targetId)) {
      this.log('skill_target_suppressed', {
        action: decision.action,
        target_id: targetId,
        reason: 'recent_failure_cooldown',
      });
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
        case 'DIG_STAIRCASE':
          await this.digStaircase(decision.direction ?? 'E', token);
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
          await this.flee(decision.direction ?? 'E', token, decision.reason);
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
      if (this.current.targetId && shouldBlockFailedTarget(message)) {
        this.blockedTargets.set(this.current.targetId, Date.now() + 20_000);
      }
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
    const movements = this.normalMovements();
    this.bot.pathfinder.setMovements(movements);
    await withTimeout(
      this.bot.pathfinder.goto(new goals.GoalXZ(tx, tz)),
      15_000,
      'explore_path_timeout',
      () => this.bot.pathfinder.stop(),
    );
    this.assertActive(token);
  }

  private async mine(candidate: WorldCandidate | null, token: number): Promise<void> {
    if (!candidate || candidate.kind !== 'block') throw new Error('no_valid_block_target');
    const pos = new Vec3(candidate.position.x, candidate.position.y, candidate.position.z);
    const block = this.bot.blockAt(pos);
    if (!block || block.name === 'air') throw new Error(`target_block_missing:${candidate.id}`);

    this.updateDetail(`moving_to_visible_face ${block.name} ${block.position.x},${block.position.y},${block.position.z}`);
    const movements = this.normalMovements();
    this.bot.pathfinder.setMovements(movements);

    await withTimeout(
      this.bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, this.bot.world, { reach: 4.2 })),
      12_000,
      `mine_path_timeout:${block.name}`,
      () => this.bot.pathfinder.stop(),
    );
    this.assertActive(token);

    const fresh = this.bot.blockAt(pos);
    if (!fresh || fresh.name === 'air') return;
    if (!this.bot.canSeeBlock(fresh)) throw new Error(`target_not_visible:${fresh.name}`);
    if (!this.bot.canDigBlock(fresh)) throw new Error(`cannot_dig:${fresh.name}`);

    await this.equipAppropriateTool(fresh, token);

    const held = this.bot.heldItem?.name ?? 'hand';
    this.updateDetail(`digging ${fresh.name} with ${held}`);
    const expectedDigMs = Math.max(0, Number(this.bot.digTime(fresh)) || 0);
    const digTimeoutMs = Math.min(30_000, Math.max(5_000, expectedDigMs * 3 + 2_000));
    await withTimeout(
      this.bot.dig(fresh),
      digTimeoutMs,
      `dig_timeout:${fresh.name}:${held}`,
      () => this.bot.stopDigging(),
    );
    this.assertActive(token);
    this.shared.pushEvent({ type: 'mined', detail: `${fresh.name} with ${held}`, importance: 'low' });

    await delay(250);
    this.assertActive(token);
    try {
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 1)),
        4_000,
        'pickup_path_timeout',
        () => this.bot.pathfinder.stop(),
      );
    } catch {
      // Picking up the drop is best effort; mining already succeeded.
    }
  }

  private normalMovements(): Movements {
    const movements = new Movements(this.bot);
    movements.allowSprinting = true;
    (movements as any).liquidCost = NORMAL_LIQUID_COST;
    return movements;
  }

  private async equipAppropriateTool(block: any, token: number): Promise<void> {
    let order: string[] = [];
    const name = block?.name ?? '';
    if (name.endsWith('_log') || name.endsWith('_wood') || name === 'crafting_table') {
      order = AXE_ORDER;
    } else if (
      name === 'stone' || name === 'cobblestone' || name === 'furnace' ||
      name.endsWith('_ore') || name.startsWith('deepslate_')
    ) {
      order = PICKAXE_ORDER;
    } else if (
      name === 'dirt' || name === 'grass_block' || name === 'gravel' ||
      name === 'sand' || name.endsWith('_sand')
    ) {
      order = SHOVEL_ORDER;
    }

    const tool = order
      .map(toolName => this.bot.inventory.items().find(item => item.name === toolName))
      .find(Boolean);

    if (tool) {
      await this.bot.equip(tool, 'hand');
      this.assertActive(token);
      return;
    }

    if (requiresHarvestTool(block)) {
      throw new Error(`missing_harvest_tool:${name}`);
    }

    // Using a log/stick/plank as a "tool" is valid to Minecraft but looks
    // nonsensical and can be slower. Empty hand is the intended fallback.
    if (this.bot.heldItem) {
      try { await this.bot.unequip('hand'); } catch { /* best effort */ }
      this.assertActive(token);
    }
  }

  private async digStaircase(direction: CompassDirection, token: number): Promise<void> {
    const ground = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    if (!isSolidGround(ground)) throw new Error('staircase_requires_solid_ground');

    const [rawDx, rawDz] = directionVector(direction);
    const [dx, dz] = dominantCardinal(rawDx, rawDz);
    let anchor = this.bot.entity.position.floored();
    const startingCobble = this.inventoryCount('cobblestone');

    this.updateDetail(`digging_safe_staircase ${direction}`);
    for (let step = 0; step < 8; step++) {
      this.assertActive(token);
      const next = anchor.offset(dx, -1, dz);
      const headPos = new Vec3(next.x, next.y + 1, next.z);
      const feetPos = new Vec3(next.x, next.y, next.z);
      const supportPos = new Vec3(next.x, next.y - 1, next.z);
      const support = this.bot.blockAt(supportPos);

      if (!isSolidGround(support) || isHazardBlock(support)) {
        throw new Error('staircase_drop_or_liquid_risk');
      }

      await this.digAdjacentBlock(headPos, token);
      await this.digAdjacentBlock(feetPos, token);

      const movements = this.normalMovements();
      movements.canDig = false;
      this.bot.pathfinder.setMovements(movements);
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalBlock(next.x, next.y, next.z)),
        6_000,
        'staircase_move_timeout',
        () => this.bot.pathfinder.stop(),
      );
      this.assertActive(token);
      anchor = next;

      if (this.inventoryCount('cobblestone') - startingCobble >= 6) {
        this.shared.pushEvent({
          type: 'staircase_reached_stone',
          detail: `cobblestone_gained=${this.inventoryCount('cobblestone') - startingCobble}`,
          importance: 'medium',
        });
        return;
      }
    }

    const gained = this.inventoryCount('cobblestone') - startingCobble;
    if (gained <= 0) throw new Error('staircase_no_stone_reached');
    this.shared.pushEvent({
      type: 'staircase_reached_stone',
      detail: `cobblestone_gained=${gained}`,
      importance: 'medium',
    });
  }

  private async digAdjacentBlock(pos: Vec3, token: number): Promise<void> {
    const block = this.bot.blockAt(pos);
    if (!block || block.name === 'air') return;
    if (isHazardBlock(block) || block.name === 'water') throw new Error(`staircase_hazard:${block.name}`);
    if (!this.bot.canDigBlock(block)) throw new Error(`staircase_cannot_dig:${block.name}`);

    await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    this.assertActive(token);
    await this.equipAppropriateTool(block, token);

    const held = this.bot.heldItem?.name ?? 'hand';
    const expectedDigMs = Math.max(0, Number(this.bot.digTime(block)) || 0);
    await withTimeout(
      this.bot.dig(block),
      Math.min(20_000, Math.max(5_000, expectedDigMs * 3 + 2_000)),
      `staircase_dig_timeout:${block.name}:${held}`,
      () => this.bot.stopDigging(),
    );
    this.assertActive(token);
    this.shared.pushEvent({
      type: 'mined',
      detail: `${block.name} with ${held} staircase`,
      importance: 'low',
    });
  }

  private inventoryCount(name: string): number {
    return this.bot.inventory.items()
      .filter(item => item.name === name)
      .reduce((total, item) => total + item.count, 0);
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

    if (item.startsWith('wooden_')) {
      const tableAlreadyAvailable = Boolean(
        this.bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 8 }) ||
        this.bot.inventory.items().some(entry => entry.name === 'crafting_table'),
      );
      await this.ensurePlankCount(tableAlreadyAvailable ? 5 : 9);
      const table = await this.ensureCraftingTable(token);
      await this.ensureStickCount(2);
      await this.ensurePlankCount(item === 'wooden_sword' ? 2 : 3);
      await this.craftNamed(item, table);
      return;
    }

    if (item.startsWith('stone_')) {
      const neededStone = item === 'stone_sword' ? 2 : 3;
      if (this.inventoryCount('cobblestone') < neededStone) {
        throw new Error(`insufficient_cobblestone:${this.inventoryCount('cobblestone')}/${neededStone}`);
      }
      const table = await this.ensureCraftingTable(token);
      await this.ensureStickCount(2);
      await this.craftNamed(item, table);
      return;
    }

    if (item === 'furnace') {
      if (this.inventoryCount('cobblestone') < 8) {
        throw new Error(`insufficient_cobblestone:${this.inventoryCount('cobblestone')}/8`);
      }
      const table = await this.ensureCraftingTable(token);
      await this.craftNamed('furnace', table);
      return;
    }

    const table = await this.ensureCraftingTable(token);
    await this.craftNamed(item, table);
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
    await this.ensurePlankCount(1);
  }

  private async ensurePlankCount(minimum: number): Promise<void> {
    while (this.plankCount() < minimum) {
      const log = this.bot.inventory.items().find(item => item.name.endsWith('_log'));
      if (!log) throw new Error(`insufficient_planks:${this.plankCount()}/${minimum}`);
      await this.craftNamed(`${log.name.slice(0, -4)}_planks`, null);
    }
  }

  private async ensureStickCount(minimum: number): Promise<void> {
    while (this.inventoryCount('stick') < minimum) {
      await this.ensurePlankCount(2);
      await this.craftNamed('stick', null);
    }
  }

  private plankCount(): number {
    return this.bot.inventory.items()
      .filter(item => item.name.endsWith('_planks'))
      .reduce((total, item) => total + item.count, 0);
  }

  private async ensureCraftingTable(token: number): Promise<any> {
    let table = this.bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 8 });
    if (table) return table;

    let item = this.bot.inventory.items().find(entry => entry.name === 'crafting_table');
    if (!item) {
      await this.ensurePlankCount(4);
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
    const underPlayer = this.bot.blockAt(base.offset(0, -1, 0));
    if (!isSolidGround(underPlayer)) throw new Error('shelter_requires_solid_ground');

    // Emergency first-night shelter: four 2-high cardinal walls plus one roof
    // block over the player. Nine blocks is intentionally affordable early-game.
    const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    let placed = 0;

    for (const [dx, dz] of walls) {
      this.assertActive(token);
      const ground = this.bot.blockAt(base.offset(dx, -1, dz));
      if (!isSolidGround(ground)) throw new Error('shelter_uneven_or_liquid_ground');

      for (let dy = 0; dy <= 1; dy++) {
        this.assertActive(token);
        const targetPos = base.offset(dx, dy, dz);
        const existing = this.bot.blockAt(targetPos);
        if (existing && existing.name !== 'air') continue;

        const item = this.nextBuildItem();
        if (!item) throw new Error(`insufficient_build_material:placed=${placed}/9`);
        await this.bot.equip(item, 'hand');

        const reference = dy === 0
          ? this.bot.blockAt(base.offset(dx, -1, dz))
          : this.bot.blockAt(base.offset(dx, 0, dz));
        if (!reference || reference.name === 'air') {
          throw new Error(`shelter_missing_reference:${dx},${dy},${dz}`);
        }

        await this.bot.placeBlock(reference, new Vec3(0, 1, 0));
        placed++;
        await delay(80);
      }
    }

    const roofPos = base.offset(0, 2, 0);
    const roofExisting = this.bot.blockAt(roofPos);
    if (!roofExisting || roofExisting.name === 'air') {
      const item = this.nextBuildItem();
      if (!item) throw new Error(`insufficient_build_material:placed=${placed}/9`);
      await this.bot.equip(item, 'hand');
      const eastTop = this.bot.blockAt(base.offset(1, 1, 0));
      if (!eastTop || eastTop.name === 'air') throw new Error('shelter_roof_reference_missing');
      await this.bot.placeBlock(eastTop, new Vec3(-1, 0, 0));
      placed++;
    }

    if (placed < 8) throw new Error(`shelter_too_incomplete:placed=${placed}`);
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

  private async flee(direction: CompassDirection, token: number, reason?: string): Promise<void> {
    if (reason?.startsWith('low_oxygen')) {
      await this.escapeWater(token);
      return;
    }

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
    const movements = this.normalMovements();
    this.bot.pathfinder.setMovements(movements);
    await withTimeout(
      this.bot.pathfinder.goto(new goals.GoalXZ(tx, tz)),
      12_000,
      'flee_path_timeout',
      () => this.bot.pathfinder.stop(),
    );
    this.assertActive(token);
  }

  private async escapeWater(token: number): Promise<void> {
    this.updateDetail('swimming_to_surface');
    try { this.bot.pathfinder.stop(); } catch { /* best effort */ }
    this.bot.setControlState('jump', true);
    try {
      for (let i = 0; i < 60; i++) {
        this.assertActive(token);
        if (!isHeadSubmerged(this.bot)) return;
        await delay(100);
      }
      throw new Error('water_escape_timeout');
    } finally {
      this.bot.setControlState('jump', false);
    }
  }

  private async sleepInBed(token: number): Promise<void> {
    const bed = this.bot.findBlock({ matching: block => block.name.includes('bed'), maxDistance: 32 });
    if (!bed) throw new Error('no_bed_nearby');
    const movements = this.normalMovements();
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
    case 'MINE':
    case 'DIG_STAIRCASE': return 'mining';
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


function requiresHarvestTool(block: any): boolean {
  const tools = block?.harvestTools;
  return Boolean(tools && typeof tools === 'object' && Object.keys(tools).length > 0);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout?.(); } catch { /* best effort */ }
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}


function shouldBlockFailedTarget(message: string): boolean {
  return [
    'target_not_visible',
    'target_block_missing',
    'cannot_dig',
    'mine_path_timeout',
    'dig_timeout',
    'Digging aborted',
  ].some(reason => message.includes(reason));
}


function dominantCardinal(dx: number, dz: number): [number, number] {
  if (Math.abs(dx) >= Math.abs(dz)) return [dx >= 0 ? 1 : -1, 0];
  return [0, dz >= 0 ? 1 : -1];
}

function isSolidGround(block: any | null): boolean {
  if (!block || isHazardBlock(block)) return false;
  return block.boundingBox === 'block';
}

function isHazardBlock(block: any | null): boolean {
  const name = block?.name ?? '';
  return name === 'lava' || name === 'water' || name === 'bubble_column';
}

function isHeadSubmerged(bot: mineflayer.Bot): boolean {
  const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name ?? '';
  return head === 'water' || head === 'bubble_column';
}
