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
import type { WorldProvenance } from './worldProvenance.js';

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
    private readonly provenance?: WorldProvenance,
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

  async runAndWait(
    decision: TypedGameplayDecision,
    world: JevWorldState | null,
    priority: 'normal' | 'safety' = 'normal',
    timeoutMs = 35_000,
  ): Promise<SkillSnapshot> {
    const beforeId = this.current.id;
    this.dispatch(decision, world, priority);

    const immediate = this.snapshot();
    if (
      decision.action !== 'CONTINUE' &&
      decision.action !== 'WAIT' &&
      immediate.id === beforeId &&
      immediate.status !== 'running'
    ) {
      return {
        ...immediate,
        status: 'failed',
        detail: `skill_not_started:${decision.action}`,
      };
    }

    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const snapshot = this.snapshot();
      if (snapshot.id !== beforeId && snapshot.status !== 'running') return snapshot;
      if (snapshot.id === beforeId && snapshot.status !== 'running' && decision.action === 'WAIT') return snapshot;
      await delay(75);
    }

    if (this.current.status === 'running') this.cancel(`primitive_wait_timeout:${decision.action}`);
    return this.snapshot();
  }

  dispatch(
    decision: TypedGameplayDecision,
    world: JevWorldState | null,
    priority: 'normal' | 'safety' = 'normal',
  ): void {
    if (priority === 'normal' && Date.now() < this.safetyOverrideUntil) return;
    if (priority === 'safety') this.safetyOverrideUntil = Date.now() + 1_500;

    // Normal policy decisions never pre-empt an in-flight embodied skill.
    // Safety may interrupt normal work, but must not continuously restart the
    // same reflex. Re-triggering FLEE every oxygen tick resets swimming controls
    // and can turn a recoverable drowning event into a death loop.
    if (priority === 'normal' && this.current.status === 'running') return;
    if (
      priority === 'safety' &&
      this.current.status === 'running' &&
      this.current.action === decision.action
    ) {
      if (decision.action !== 'FLEE') return;

      const incomingWaterEscape = decision.reason?.startsWith('low_oxygen') ?? false;
      const currentWaterEscape =
        this.current.detail === 'swimming_to_surface' ||
        this.current.detail.startsWith('low_oxygen');

      // Keep an active hostile/hazard flee moving instead of restarting it on
      // every 100ms safety tick. Drowning is the one mode that may replace a
      // non-water flee because it requires different controls.
      if (!incomingWaterEscape || currentWaterEscape) return;
    }

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
      place_item: decision.placeItem ?? null,
      use_item: decision.useItem ?? null,
      process_item: decision.processItem ?? null,
      cook_item: decision.cookItem ?? null,
      consume_item: decision.consumeItem ?? null,
      direction: decision.direction ?? null,
      excavation_mode: decision.excavationMode ?? null,
      target_position: decision.targetPosition ?? null,
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
        case 'NAVIGATE':
          if (!decision.targetPosition) throw new Error('navigate_target_missing');
          await this.navigate(decision.targetPosition, token);
          break;
        case 'EXPLORE':
          await this.explore(decision.direction ?? 'E', token);
          break;
        case 'MINE':
          await this.mine(this.findBlockCandidate(world, decision.blockTargetId), token);
          break;
        case 'DIG_STAIRCASE':
          await this.digStaircase(
            decision.direction ?? 'E',
            token,
            decision.targetPosition,
            decision.excavationMode ?? 'down',
          );
          break;
        case 'CRAFT':
          await this.craft(decision.craftItem ?? 'none', token);
          break;
        case 'PLACE_ITEM':
          await this.placeInventoryItem(decision.placeItem ?? 'none', token);
          break;
        case 'USE_ITEM':
          await this.useInventoryItem(decision.useItem ?? 'none', token);
          break;
        case 'PROCESS_ITEM':
          await this.processInventoryItem(decision.processItem ?? 'none', token, decision.targetPosition);
          break;
        case 'INTERACT_BLOCK':
          await this.interactBlock(decision.targetPosition, token);
          break;
        case 'COOK_FOOD':
          await this.cookFood(decision.cookItem ?? 'none', token);
          break;
        case 'BUILD_SHELTER':
          await this.buildShelter(token, decision.targetPosition);
          break;
        case 'HUNT_FOOD':
          await this.huntFood(this.findEntityCandidate(world, decision.entityTargetId), token);
          break;
        case 'EAT':
          await this.eat(token, decision.consumeItem);
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

  private async navigate(
    target: { x: number; y: number; z: number },
    token: number,
  ): Promise<void> {
    this.updateDetail(`navigating_to ${target.x.toFixed(1)},${target.y.toFixed(1)},${target.z.toFixed(1)}`);

    if (isBodyInWater(this.bot)) {
      await this.swimToward(target, token, 9_000);
      this.assertActive(token);
    }

    const targetVec = new Vec3(target.x, target.y, target.z);
    let distance = this.bot.entity.position.distanceTo(targetVec);
    if (distance <= 1.8 && !isBodyInWater(this.bot)) return;

    const shelters = this.provenance?.listStructures('shelter') ?? [];
    const currentShelter = shelters.find(entry =>
      this.bot.entity.position.distanceTo(
        new Vec3(entry.position.x, entry.position.y, entry.position.z),
      ) <= 1.6,
    );
    const targetShelter = shelters.find(entry =>
      targetVec.distanceTo(new Vec3(entry.position.x, entry.position.y, entry.position.z)) <= 1.2,
    );

    if (currentShelter && !targetShelter) {
      await this.passShelterDoor(currentShelter.position, 'out', token);
    } else if (targetShelter && !currentShelter) {
      await this.passShelterDoor(targetShelter.position, 'in', token);
      distance = this.bot.entity.position.distanceTo(targetVec);
      if (distance <= 1.8) return;
    }

    const movements = this.normalMovements();
    movements.canDig = false;
    this.bot.pathfinder.setMovements(movements);
    await withTimeout(
      this.bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1)),
      14_000,
      'navigate_path_timeout',
      () => this.bot.pathfinder.stop(),
    );
    this.assertActive(token);

    const finalDistance = this.bot.entity.position.distanceTo(targetVec);
    if (finalDistance > 2.25) {
      throw new Error(`navigate_postcondition_failed:${finalDistance.toFixed(1)}m`);
    }
  }

  private async passShelterDoor(
    center: { x: number; y: number; z: number },
    direction: 'in' | 'out',
    token: number,
  ): Promise<void> {
    const base = new Vec3(center.x, center.y, center.z);
    const outside = base.offset(0, 0, 2);
    const doorPos = base.offset(0, 0, 1);

    if (direction === 'in') {
      const movements = this.normalMovements();
      movements.canDig = false;
      this.bot.pathfinder.setMovements(movements);
      await withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNear(outside.x, outside.y, outside.z, 1)),
        8_000,
        'shelter_approach_timeout',
        () => this.bot.pathfinder.stop(),
      );
      this.assertActive(token);
    }

    await this.setShelterDoorOpen(doorPos, true, token);

    const destination = direction === 'in' ? base : outside;
    const movements = this.normalMovements();
    movements.canDig = false;
    this.bot.pathfinder.setMovements(movements);
    await withTimeout(
      this.bot.pathfinder.goto(new goals.GoalBlock(destination.x, destination.y, destination.z)),
      6_000,
      `shelter_door_${direction}_timeout`,
      () => this.bot.pathfinder.stop(),
    );
    this.assertActive(token);

    await this.setShelterDoorOpen(doorPos, false, token);
  }

  private async setShelterDoorOpen(
    position: Vec3,
    desiredOpen: boolean,
    token: number,
  ): Promise<void> {
    const door = this.bot.blockAt(position);
    if (!door || !door.name.endsWith('_door')) {
      throw new Error('known_shelter_door_missing');
    }

    const properties = typeof (door as any).getProperties === 'function'
      ? (door as any).getProperties()
      : {};
    const isOpen = Boolean(properties.open);
    if (isOpen === desiredOpen) return;

    await this.bot.lookAt(door.position.offset(0.5, 0.5, 0.5), true);
    this.assertActive(token);
    await this.bot.activateBlock(door);
    await delay(120);
    this.assertActive(token);

    const refreshed = this.bot.blockAt(position);
    const refreshedProperties = refreshed && typeof (refreshed as any).getProperties === 'function'
      ? (refreshed as any).getProperties()
      : {};
    if (Boolean(refreshedProperties.open) !== desiredOpen) {
      throw new Error(`shelter_door_state_failed:${desiredOpen ? 'open' : 'closed'}`);
    }
  }

  private async swimToward(
    target: { x: number; y: number; z: number },
    token: number,
    timeoutMs: number,
  ): Promise<void> {
    const started = Date.now();
    try { this.bot.pathfinder.stop(); } catch { /* best effort */ }
    this.bot.setControlState('forward', true);
    this.bot.setControlState('jump', true);
    this.bot.setControlState('sprint', true);

    try {
      while (Date.now() - started < timeoutMs) {
        this.assertActive(token);
        const position = this.bot.entity.position;
        await this.bot.lookAt(new Vec3(target.x, Math.max(position.y + 1.2, target.y + 1), target.z), true);
        if (!isBodyInWater(this.bot)) return;
        if (Math.hypot(position.x - target.x, position.z - target.z) <= 1.5 && position.y >= target.y - 1) return;
        await delay(100);
      }
      throw new Error('swim_to_land_timeout');
    } finally {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('jump', false);
      this.bot.setControlState('sprint', false);
    }
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

    // canDigBlock depends on the currently equipped harvest tool. Equip first
    // so diggability reflects the bot's actual capability rather than whatever
    // item happened to be in hand from the previous action.
    await this.equipAppropriateTool(fresh, token);
    if (!this.bot.canDigBlock(fresh)) throw new Error(`cannot_dig:${fresh.name}`);

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
    this.provenance?.forget(fresh.position);
    this.shared.pushEvent({ type: 'mined', detail: `${fresh.name} with ${held}`, importance: 'low' });

    await delay(250);
    this.assertActive(token);
    // Follow the actual dropped item rather than walking into the block that
    // was just removed. Targeting the old block position made the bot step
    // down into freshly dug floor holes and climb tree canopies after mining
    // upper logs, unintentionally turning ordinary gathering into excavation.
    await this.collectNearbyDrops(token, 4);
  }

  private async moveToExactAnchor(
    target: { x: number; y: number; z: number },
    token: number,
  ): Promise<void> {
    const exact = new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
    const current = this.bot.entity.position.floored();
    if (current.x === exact.x && current.y === exact.y && current.z === exact.z) return;

    const movements = this.normalMovements();
    movements.canDig = false;
    this.bot.pathfinder.setMovements(movements);
    await withTimeout(
      this.bot.pathfinder.goto(new goals.GoalBlock(exact.x, exact.y, exact.z)),
      6_000,
      'anchor_position_timeout',
      () => this.bot.pathfinder.stop(),
    );
    this.assertActive(token);
  }

  private async collectNearbyDrops(token: number, maxDistance: number): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      this.assertActive(token);
      const item = this.bot.nearestEntity(entity =>
        entity.name === 'item' &&
        Boolean(entity.position) &&
        this.bot.entity.position.distanceTo(entity.position) <= maxDistance,
      );
      if (!item?.position) return;

      const movements = this.normalMovements();
      movements.canDig = false;
      this.bot.pathfinder.setMovements(movements);
      try {
        await withTimeout(
          this.bot.pathfinder.goto(new goals.GoalNear(
            item.position.x,
            item.position.y + 1,
            item.position.z,
            1.6,
          )),
          2_500,
          'drop_collect_timeout',
          () => this.bot.pathfinder.stop(),
        );
      } catch {
        return;
      }
      await delay(120);
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

    const preferredTool = order
      .map(toolName => this.bot.inventory.items().find(item => item.name === toolName))
      .find(Boolean);

    if (preferredTool) {
      await this.bot.equip(preferredTool, 'hand');
      this.assertActive(token);
      return;
    }

    // Use minecraft-data/pathfinder only when the block actually requires a
    // harvest tool. For tool-optional blocks (logs, leaves, dirt) an arbitrary
    // held item is not a meaningful "best tool"; prefer empty hand unless a
    // real preferred tool exists above.
    if (requiresHarvestTool(block)) {
      const harvestTool = this.bot.pathfinder.bestHarvestTool(block);
      if (harvestTool) {
        await this.bot.equip(harvestTool, 'hand');
        this.assertActive(token);
        return;
      }
      throw new Error(`missing_harvest_tool:${name}`);
    }

    // Avoid hitting blocks with crafting tables, logs, sticks, or planks just
    // because they happen to be in hand.
    if (this.bot.heldItem) {
      try { await this.bot.unequip('hand'); } catch { /* best effort */ }
      this.assertActive(token);
    }
  }

  private async digStaircase(
    direction: CompassDirection,
    token: number,
    targetPosition?: { x: number; y: number; z: number },
    mode: 'down' | 'up' = 'down',
  ): Promise<void> {
    if (targetPosition) await this.moveToExactAnchor(targetPosition, token);
    const ground = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    if (!isSolidGround(ground)) throw new Error('staircase_requires_solid_ground');

    const [rawDx, rawDz] = directionVector(direction);
    const [dx, dz] = dominantCardinal(rawDx, rawDz);
    let anchor = targetPosition
      ? new Vec3(Math.floor(targetPosition.x), Math.floor(targetPosition.y), Math.floor(targetPosition.z))
      : this.bot.entity.position.floored();
    const startingCobble = this.inventoryCount('cobblestone');

    const verticalStep = mode === 'up' ? 1 : -1;
    this.updateDetail(`digging_safe_staircase_${mode} ${direction}`);
    for (let step = 0; step < 4; step++) {
      this.assertActive(token);
      const next = anchor.offset(dx, verticalStep, dz);
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
      await this.collectNearbyDrops(token, 3.5);

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
    if (gained <= 0) {
      // Completing a certified staircase segment is still useful progress even
      // when the local soil layer is deeper than four blocks. The task layer
      // will re-observe the world and may continue only through a newly
      // certified excavation site.
      this.shared.pushEvent({
        type: 'staircase_segment_completed',
        detail: 'cobblestone_gained=0',
        importance: 'low',
      });
      return;
    }
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

    await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    this.assertActive(token);
    await this.equipAppropriateTool(block, token);
    if (!this.bot.canDigBlock(block)) throw new Error(`staircase_cannot_dig:${block.name}`);

    const held = this.bot.heldItem?.name ?? 'hand';
    const expectedDigMs = Math.max(0, Number(this.bot.digTime(block)) || 0);
    await withTimeout(
      this.bot.dig(block),
      Math.min(20_000, Math.max(5_000, expectedDigMs * 3 + 2_000)),
      `staircase_dig_timeout:${block.name}:${held}`,
      () => this.bot.stopDigging(),
    );
    this.assertActive(token);
    this.provenance?.forget(block.position);
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
    if (!item || item === 'none') throw new Error('no_craft_item_selected');
    this.updateDetail(`crafting ${item}`);

    const itemId = this.bot.registry.itemsByName[item]?.id;
    if (!itemId) throw new Error(`unknown_item:${item}`);

    // First try the player's 2x2 inventory crafting grid exactly as Minecraft
    // exposes it. Do not synthesize prerequisite items here; deciding to make
    // ingredients is an executive decision.
    await this.prepareCraftingState();
    let recipes = this.bot.recipesFor(itemId, null, 1, null);
    if (recipes.length > 0) {
      await this.craftRecipeWithRecovery(item, recipes[0], null);
      return;
    }

    // If the recipe needs a crafting table, using an existing table is a body
    // mechanic. A table already carried may be placed, but this skill will not
    // craft a missing table or missing ingredients on the AI's behalf.
    let table = this.bot.findBlock({
      matching: block => block.name === 'crafting_table',
      maxDistance: 8,
    });
    if (!table) {
      const tableItem = this.bot.inventory.items().find(entry => entry.name === 'crafting_table');
      if (tableItem) table = await this.placeAdjacent(tableItem, token);
    }

    if (!table) {
      const tableRecipes = this.bot.recipesAll(itemId, null, true);
      if (tableRecipes.length > 0) throw new Error(`crafting_table_required:${item}`);
      throw new Error(`no_recipe:${item}`);
    }

    this.assertActive(token);
    recipes = this.bot.recipesFor(itemId, null, 1, table);
    if (recipes.length === 0) {
      const knownRecipes = this.bot.recipesAll(itemId, null, table);
      if (knownRecipes.length > 0) throw new Error(`missing_recipe_ingredients:${item}`);
      throw new Error(`no_recipe:${item}`);
    }

    await this.craftRecipeWithRecovery(item, recipes[0], table);
  }

  private async craftRecipeWithRecovery(
    itemName: string,
    recipe: any,
    table: any | null,
  ): Promise<void> {
    const before = this.inventoryCount(itemName);
    try {
      await withTimeout(
        this.bot.craft(recipe, 1, table ?? undefined),
        8_000,
        `craft_timeout:${itemName}`,
      );
    } catch (error) {
      await this.reconcileCraftingState();

      if (this.inventoryCount(itemName) > before) {
        this.shared.pushEvent({
          type: 'crafted_reconciled',
          detail: itemName,
          importance: 'medium',
        });
        return;
      }

      throw error;
    }

    this.shared.pushEvent({ type: 'crafted', detail: itemName, importance: 'low' });
  }

  private async prepareCraftingState(): Promise<void> {
    const currentWindow = this.bot.currentWindow;
    if (currentWindow) {
      try {
        const sync = (this.bot as any)._syncWindow?.(currentWindow);
        if (sync) await withTimeout(Promise.resolve(sync), 3_000, 'craft_window_sync_timeout');
      } catch {
        // Best effort; close the stale GUI even if its model cannot be synced.
      }
      try {
        await this.bot.closeWindow(currentWindow);
      } catch {
        // Best effort.
      }
    }

    await this.syncPlayerInventory();
  }

  private async reconcileCraftingState(): Promise<void> {
    const currentWindow = this.bot.currentWindow;
    if (currentWindow) {
      try {
        const sync = (this.bot as any)._syncWindow?.(currentWindow);
        if (sync) await withTimeout(Promise.resolve(sync), 3_000, 'craft_reconcile_window_timeout');
      } catch {
        // Continue with the authoritative player-inventory refresh below.
      }
      try {
        await this.bot.closeWindow(currentWindow);
      } catch {
        // Best effort.
      }
    }

    await delay(150);
    await this.syncPlayerInventory();
    await delay(100);
  }

  private async syncPlayerInventory(): Promise<void> {
    try {
      const sync = (this.bot as any)._syncWindow?.(this.bot.inventory);
      if (sync) await withTimeout(Promise.resolve(sync), 3_000, 'inventory_sync_timeout');
    } catch {
      // A sync failure should not itself wedge the skill executor.
    }
  }

  private async placeAdjacent(
    item: any,
    token: number,
    role: 'workstation' | 'utility' = 'workstation',
  ): Promise<any | null> {
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
        const placedPos = base.offset(dx, 0, dz);
        this.provenance?.markPlaced(placedPos, role);
        await delay(150);
        return this.bot.blockAt(placedPos);
      } catch {
        // Try another adjacent location.
      }
    }
    return null;
  }

  private async placeInventoryItem(itemName: string, token: number): Promise<void> {
    if (!itemName || itemName === 'none') throw new Error('place_item_missing_item');
    const item = this.bot.inventory.items().find(entry => entry.name === itemName);
    if (!item) throw new Error(`place_item_not_in_inventory:${itemName}`);

    this.updateDetail(`placing ${itemName}`);
    const role = placementRole(itemName);
    const placed = await this.placeAdjacent(item, token, role);
    if (!placed) throw new Error(`place_item_no_valid_location:${itemName}`);

    this.shared.pushEvent({
      type: 'item_placed',
      detail: `${itemName}@${placed.position.x},${placed.position.y},${placed.position.z}`,
      importance: 'medium',
    });
  }

  private async useInventoryItem(itemName: string, token: number): Promise<void> {
    if (!itemName || itemName === 'none') throw new Error('use_item_missing_item');
    const item = this.bot.inventory.items().find(entry => entry.name === itemName);
    if (!item) throw new Error(`use_item_not_in_inventory:${itemName}`);

    await this.bot.equip(item, 'hand');
    this.assertActive(token);
    const data = (this.bot.registry.items as any)?.[item.type] ?? {};
    const foodPoints = Number(data.foodPoints ?? data.food_points ?? 0);

    if (foodPoints > 0) {
      await this.bot.consume();
    } else {
      this.bot.activateItem();
      await delay(350);
      this.assertActive(token);
      this.bot.deactivateItem();
    }

    this.shared.pushEvent({
      type: 'item_used',
      detail: itemName,
      importance: 'low',
    });
  }

  private async processInventoryItem(
    inputName: string,
    token: number,
    targetPosition?: { x: number; y: number; z: number },
  ): Promise<void> {
    if (!inputName || inputName === 'none') throw new Error('process_item_missing_input');
    const input = this.bot.inventory.items().find(entry => entry.name === inputName);
    if (!input) throw new Error(`process_item_input_missing:${inputName}`);

    const station = targetPosition
      ? this.bot.blockAt(new Vec3(
          Math.floor(targetPosition.x),
          Math.floor(targetPosition.y),
          Math.floor(targetPosition.z),
        ))
      : this.bot.findBlock({
          matching: block => block.name === 'smoker' || block.name === 'furnace',
          maxDistance: 8,
        });
    if (!station || !['smoker', 'furnace'].includes(station.name)) {
      throw new Error('process_item_station_missing');
    }

    const fuel = this.findFuelItem();
    if (!fuel) throw new Error('process_item_fuel_missing');

    const movements = this.normalMovements();
    movements.canDig = false;
    this.bot.pathfinder.setMovements(movements);
    await withTimeout(
      this.bot.pathfinder.goto(new goals.GoalNear(station.position.x, station.position.y, station.position.z, 2)),
      8_000,
      'process_station_path_timeout',
      () => this.bot.pathfinder.stop(),
    );
    this.assertActive(token);

    const window: any = await (this.bot as any).openFurnace(station);
    try {
      await withTimeout(
        Promise.resolve(window.putInput(input.type, input.metadata ?? null, 1)),
        5_000,
        'process_put_input_timeout',
      );
      this.assertActive(token);
      const freshFuel = this.bot.inventory.items().find(entry => entry.name === fuel.name);
      if (!freshFuel) throw new Error('process_item_fuel_disappeared');
      await withTimeout(
        Promise.resolve(window.putFuel(freshFuel.type, freshFuel.metadata ?? null, 1)),
        5_000,
        'process_put_fuel_timeout',
      );
      this.assertActive(token);

      const started = Date.now();
      while (Date.now() - started < 20_000) {
        this.assertActive(token);
        const output = typeof window.outputItem === 'function' ? window.outputItem() : null;
        if (output) {
          await withTimeout(Promise.resolve(window.takeOutput()), 5_000, 'process_take_output_timeout');
          this.shared.pushEvent({
            type: 'item_processed',
            detail: `${inputName}->${output.name ?? 'output'} via ${station.name}`,
            importance: 'medium',
          });
          return;
        }
        await delay(250);
      }
      throw new Error(`process_output_timeout:${inputName}`);
    } finally {
      try { await window.close(); } catch { /* best effort */ }
    }
  }

  private async interactBlock(
    targetPosition: { x: number; y: number; z: number } | undefined,
    token: number,
  ): Promise<void> {
    if (!targetPosition) throw new Error('interact_block_target_missing');
    const block = this.bot.blockAt(new Vec3(
      Math.floor(targetPosition.x),
      Math.floor(targetPosition.y),
      Math.floor(targetPosition.z),
    ));
    if (!block) throw new Error('interact_block_missing');

    const movements = this.normalMovements();
    movements.canDig = false;
    this.bot.pathfinder.setMovements(movements);
    await withTimeout(
      this.bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)),
      8_000,
      'interact_block_path_timeout',
      () => this.bot.pathfinder.stop(),
    );
    this.assertActive(token);

    if (block.name.endsWith('_bed')) {
      await this.bot.sleep(block);
    } else {
      await this.bot.activateBlock(block);
    }
    this.shared.pushEvent({
      type: 'block_interacted',
      detail: `${block.name}@${block.position.x},${block.position.y},${block.position.z}`,
      importance: 'low',
    });
  }

  private async cookFood(inputName: string, token: number): Promise<void> {
    if (!inputName || inputName === 'none') throw new Error('cook_food_missing_input');
    const input = this.bot.inventory.items().find(entry => entry.name === inputName);
    if (!input) throw new Error(`cook_food_input_missing:${inputName}`);

    const station = this.bot.findBlock({
      matching: block => block.name === 'smoker' || block.name === 'furnace',
      maxDistance: 8,
    });
    if (!station) throw new Error('cook_food_station_missing');

    const fuel = this.findFuelItem();
    if (!fuel) throw new Error('cook_food_fuel_missing');

    const movements = this.normalMovements();
    movements.canDig = false;
    this.bot.pathfinder.setMovements(movements);
    await withTimeout(
      this.bot.pathfinder.goto(new goals.GoalNear(station.position.x, station.position.y, station.position.z, 2)),
      8_000,
      'cook_station_path_timeout',
      () => this.bot.pathfinder.stop(),
    );
    this.assertActive(token);

    this.updateDetail(`cooking ${inputName} in ${station.name}`);
    const window: any = await (this.bot as any).openFurnace(station);
    try {
      await withTimeout(Promise.resolve(window.putInput(input.type, input.metadata ?? null, 1)), 5_000, 'cook_put_input_timeout');
      this.assertActive(token);
      const freshFuel = this.bot.inventory.items().find(entry => entry.name === fuel.name);
      if (!freshFuel) throw new Error('cook_food_fuel_disappeared');
      await withTimeout(Promise.resolve(window.putFuel(freshFuel.type, freshFuel.metadata ?? null, 1)), 5_000, 'cook_put_fuel_timeout');
      this.assertActive(token);

      const expected = COOKED_FOOD[inputName] ?? null;
      const started = Date.now();
      while (Date.now() - started < 18_000) {
        this.assertActive(token);
        const output = typeof window.outputItem === 'function' ? window.outputItem() : null;
        if (output && (!expected || output.name === expected)) {
          await withTimeout(Promise.resolve(window.takeOutput()), 5_000, 'cook_take_output_timeout');
          this.shared.pushEvent({
            type: 'food_cooked',
            detail: `${inputName}->${output.name ?? expected ?? 'output'}`,
            importance: 'medium',
          });
          return;
        }
        await delay(250);
      }
      throw new Error(`cook_output_timeout:${inputName}`);
    } finally {
      try { window.close(); } catch { /* best effort */ }
    }
  }

  private findFuelItem(): any | null {
    const preferred = ['coal', 'charcoal'];
    for (const name of preferred) {
      const item = this.bot.inventory.items().find(entry => entry.name === name);
      if (item) return item;
    }
    return this.bot.inventory.items().find(item =>
      item.name.endsWith('_log') ||
      item.name.endsWith('_wood') ||
      item.name.endsWith('_planks') ||
      item.name === 'stick',
    ) ?? null;
  }

  private async buildShelter(
    token: number,
    targetPosition?: { x: number; y: number; z: number },
  ): Promise<void> {
    if (targetPosition) await this.moveToExactAnchor(targetPosition, token);
    const base = targetPosition
      ? new Vec3(Math.floor(targetPosition.x), Math.floor(targetPosition.y), Math.floor(targetPosition.z))
      : this.bot.entity.position.floored();
    const underPlayer = this.bot.blockAt(base.offset(0, -1, 0));
    if (!isSolidGround(underPlayer)) throw new Error('shelter_requires_solid_ground');

    // Structure skills execute a physical plan; they do not synthesize their
    // own progression prerequisites. The executive must explicitly obtain/craft
    // a door before asking the body to build this shelter template.
    const door = this.bot.inventory.items().find(item =>
      item.name.endsWith('_door') && item.name !== 'iron_door',
    );
    if (!door) throw new Error('shelter_requires_door_item');

    // Three 2-high walls + two roof blocks = 8 structural blocks.
    // The south side is the doorway.
    const requiredMaterials = 8;
    const availableMaterials = this.buildMaterialCount();
    if (availableMaterials < requiredMaterials) {
      throw new Error(`insufficient_build_material:available=${availableMaterials}/${requiredMaterials}_plus_door`);
    }

    await this.clearShelterObstructions(base, token);

    const walls = [[1, 0], [-1, 0], [0, -1]] as const;
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
        if (!item) throw new Error(`insufficient_build_material:placed=${placed}/${requiredMaterials}`);
        await this.bot.equip(item, 'hand');

        const reference = dy === 0
          ? this.bot.blockAt(base.offset(dx, -1, dz))
          : this.bot.blockAt(base.offset(dx, 0, dz));
        if (!reference || reference.name === 'air') {
          throw new Error(`shelter_missing_reference:${dx},${dy},${dz}`);
        }

        await this.bot.placeBlock(reference, new Vec3(0, 1, 0));
        this.provenance?.markPlaced(targetPos, 'structure');
        placed++;
        await delay(80);
      }
    }

    const eastRoofAnchorPos = base.offset(1, 2, 0);
    let eastRoofAnchor = this.bot.blockAt(eastRoofAnchorPos);
    if (!eastRoofAnchor || eastRoofAnchor.name === 'air') {
      const item = this.nextBuildItem();
      if (!item) throw new Error(`insufficient_build_material:placed=${placed}/${requiredMaterials}`);
      await this.bot.equip(item, 'hand');
      const eastWallTop = this.bot.blockAt(base.offset(1, 1, 0));
      if (!eastWallTop || eastWallTop.name === 'air') throw new Error('shelter_roof_anchor_reference_missing');
      await this.bot.placeBlock(eastWallTop, new Vec3(0, 1, 0));
      this.provenance?.markPlaced(eastRoofAnchorPos, 'structure');
      await delay(100);
      eastRoofAnchor = this.bot.blockAt(eastRoofAnchorPos);
      if (!eastRoofAnchor || eastRoofAnchor.name === 'air') throw new Error('shelter_roof_anchor_failed');
      placed++;
    }

    const roofPos = base.offset(0, 2, 0);
    const roofExisting = this.bot.blockAt(roofPos);
    if (!roofExisting || roofExisting.name === 'air') {
      const item = this.nextBuildItem();
      if (!item) throw new Error(`insufficient_build_material:placed=${placed}/${requiredMaterials}`);
      await this.bot.equip(item, 'hand');
      if (!eastRoofAnchor || eastRoofAnchor.name === 'air') throw new Error('shelter_roof_reference_missing');
      await this.bot.placeBlock(eastRoofAnchor, new Vec3(-1, 0, 0));
      this.provenance?.markPlaced(roofPos, 'structure');
      await delay(100);
      const placedRoof = this.bot.blockAt(roofPos);
      if (!placedRoof || placedRoof.name === 'air') throw new Error('shelter_roof_failed');
      placed++;
    }

    const entranceBottom = base.offset(0, 0, 1);
    const entranceTop = base.offset(0, 1, 1);
    const entranceGround = this.bot.blockAt(base.offset(0, -1, 1));
    if (!isSolidGround(entranceGround)) throw new Error('shelter_door_ground_missing');
    const existingBottom = this.bot.blockAt(entranceBottom);
    const existingTop = this.bot.blockAt(entranceTop);
    if ((existingBottom && existingBottom.name !== 'air') || (existingTop && existingTop.name !== 'air')) {
      throw new Error('shelter_doorway_blocked');
    }

    await this.bot.equip(door, 'hand');
    await this.bot.lookAt(base.offset(0, 1, 2), true);
    await this.bot.placeBlock(entranceGround!, new Vec3(0, 1, 0));
    await delay(150);
    const placedDoor = this.bot.blockAt(entranceBottom);
    if (!placedDoor || !placedDoor.name.endsWith('_door')) {
      throw new Error('shelter_door_failed');
    }
    this.provenance?.markPlaced(entranceBottom, 'structure');
    this.provenance?.markPlaced(entranceTop, 'structure');

    if (placed < requiredMaterials) throw new Error(`shelter_too_incomplete:placed=${placed}/${requiredMaterials}`);
    this.provenance?.markStructure('shelter', base);
    this.shared.pushEvent({
      type: 'shelter_built',
      detail: `placed=${placed} door=${placedDoor.name}`,
      importance: 'high',
    });
  }

  private async clearShelterObstructions(base: Vec3, token: number): Promise<void> {
    const positions: Vec3[] = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, -1]] as const) {
      positions.push(base.offset(dx, 0, dz), base.offset(dx, 1, dz));
    }
    positions.push(
      base.offset(0, 2, 0),
      base.offset(1, 2, 0),
      base.offset(0, 0, 1),
      base.offset(0, 1, 1),
    );

    for (const position of positions) {
      this.assertActive(token);
      const block = this.bot.blockAt(position);
      if (!block || block.name === 'air' || block.boundingBox === 'empty') continue;
      if (this.provenance?.isPlayerPlaced(block.position)) {
        throw new Error(`shelter_site_obstructed:player_placed:${block.name}`);
      }
      if (!isSoftShelterObstruction(block)) {
        throw new Error(`shelter_site_obstructed:${block.name}`);
      }
      await this.digAdjacentBlock(position, token);
      await delay(60);
    }
  }

  private buildMaterialCount(): number {
    return this.bot.inventory.items()
      .filter(item =>
        item.name === 'dirt' ||
        item.name === 'cobblestone' ||
        item.name.endsWith('_planks') ||
        item.name.endsWith('_log'),
      )
      .reduce((sum, item) => sum + item.count, 0);
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
    const name = entity.name ?? 'animal';
    await this.equipBestWeapon();
    await this.approachAndAttack(entity, token, 8);
    await delay(250);
    this.assertActive(token);
    await this.collectNearbyDrops(token, 7);
    this.shared.pushEvent({ type: 'hunted', detail: name, importance: 'medium' });
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

  private async eat(token: number, requestedItem?: string): Promise<void> {
    const food = requestedItem
      ? this.bot.inventory.items().find(item => item.name === requestedItem && isEdibleItem(this.bot, item))
      : this.bot.inventory.items().find(item => isEdibleItem(this.bot, item));
    if (!food) throw new Error(requestedItem
      ? `requested_food_unavailable:${requestedItem}`
      : 'no_food_available');
    const before = this.bot.food;
    await this.bot.equip(food, 'hand');
    this.assertActive(token);
    await this.bot.consume();
    this.assertActive(token);
    if (this.bot.food <= before) throw new Error(`eat_no_hunger_progress:${food.name}`);
    this.shared.pushEvent({
      type: 'ate_food',
      detail: `${food.name} hunger=${before}->${this.bot.food}`,
      importance: 'medium',
    });
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
    case 'NAVIGATE':
    case 'EXPLORE': return 'exploring';
    case 'MINE':
    case 'DIG_STAIRCASE': return 'mining';
    case 'CRAFT':
    case 'PLACE_ITEM':
    case 'PROCESS_ITEM':
    case 'COOK_FOOD':
    case 'BUILD_SHELTER': return 'crafting';
    case 'USE_ITEM': return 'eating';
    case 'INTERACT_BLOCK': return 'exploring';
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

const COOKED_FOOD: Record<string, string> = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp',
};

function placementRole(itemName: string): 'workstation' | 'utility' {
  if (
    itemName === 'crafting_table' ||
    itemName === 'furnace' ||
    itemName === 'smoker' ||
    itemName === 'blast_furnace' ||
    itemName === 'campfire'
  ) {
    return 'workstation';
  }
  return 'utility';
}

function isEdibleItem(bot: mineflayer.Bot, item: any): boolean {
  const data = (bot.registry.items as any)?.[item?.type] ?? {};
  const foodPoints = Number(data.foodPoints ?? data.food_points ?? 0);
  return foodPoints > 0 || FOOD_ITEMS.has(item?.name ?? '');
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

function isSoftShelterObstruction(block: any | null): boolean {
  if (!block) return false;
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

function isHazardBlock(block: any | null): boolean {
  const name = block?.name ?? '';
  return name === 'lava' || name === 'water' || name === 'bubble_column';
}

function isHeadSubmerged(bot: mineflayer.Bot): boolean {
  const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name ?? '';
  return head === 'water' || head === 'bubble_column';
}


function isBodyInWater(bot: mineflayer.Bot): boolean {
  const position = bot.entity.position;
  const waterlike = new Set(['water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);
  const names = [
    bot.blockAt(position)?.name,
    bot.blockAt(position.offset(0, 1, 0))?.name,
    bot.blockAt(position.offset(0, -1, 0))?.name,
  ].filter(Boolean) as string[];
  return names.some(name => waterlike.has(name));
}
