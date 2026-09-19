import type mineflayer from 'mineflayer';
import type { SharedStateBus } from '../cognitive/sharedState.js';
import { SemanticWorldModel } from './semanticWorldModel.js';
import { SkillExecutor } from './skillExecutor.js';
import type { WorldSensor } from './worldSensor.js';
import type {
  ExecutiveDecision,
  ExecutiveResource,
  ExecutiveStructure,
  ExecutiveTaskSnapshot,
  ExecutiveWorldState,
  SemanticTarget,
  TaskExecutionResult,
} from './executiveTypes.js';
import type {
  JevWorldState,
  TypedGameplayDecision,
  WorldCandidate,
} from './typedActions.js';

export class TaskExecutor {
  private sequence = 0;
  private current: ExecutiveTaskSnapshot = idleTask();

  constructor(
    private readonly bot: mineflayer.Bot,
    private readonly shared: SharedStateBus,
    private readonly primitive: SkillExecutor,
    private readonly sensor: WorldSensor,
    private readonly semantic: SemanticWorldModel,
  ) {}

  snapshot(): ExecutiveTaskSnapshot {
    return {
      ...this.current,
      progress: { ...this.current.progress },
    };
  }

  async execute(decision: ExecutiveDecision): Promise<TaskExecutionResult> {
    if (decision.task === 'CONTINUE_TASK' && this.current.status !== 'running') {
      return { status: 'failed', detail: 'no_running_task_to_continue' };
    }

    const taskId = ++this.sequence;
    const startedGoal = this.shared.get().currentGoal;
    this.current = {
      id: taskId,
      task: decision.task,
      targetId: decision.targetId ?? null,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      detail: '',
      progress: {},
    };
    this.log('task_started', {
      task_id: taskId,
      task: decision.task,
      target_id: decision.targetId ?? null,
      amount: decision.amount ?? null,
      resource: decision.resource ?? null,
      craft_item: decision.craftItem ?? null,
      structure: decision.structure ?? null,
      source: decision.source,
      confidence: decision.confidence,
      based_on_revision: decision.basedOnRevision,
    });

    try {
      let detail = '';
      switch (decision.task) {
        case 'NAVIGATE_TARGET':
          detail = await this.navigateTarget(decision.targetId, startedGoal);
          break;
        case 'GATHER_RESOURCE':
          detail = await this.gatherResource(
            decision.resource ?? 'none',
            decision.amount ?? 1,
            decision.targetId,
            startedGoal,
          );
          break;
        case 'EXCAVATE_TARGET':
          detail = await this.excavateTarget(decision.targetId, startedGoal);
          break;
        case 'ATTACK_TARGET':
          detail = await this.attackTarget(decision.targetId, startedGoal);
          break;
        case 'CRAFT_ITEM':
          detail = await this.craftExecutiveItem(
            decision.craftItem ?? 'none',
            decision.amount ?? 1,
            startedGoal,
          );
          break;
        case 'BUILD_STRUCTURE':
          detail = await this.buildStructure(
            decision.structure ?? 'none',
            decision.targetId,
            startedGoal,
          );
          break;
        case 'WAIT':
          await delay(500);
          detail = 'waited';
          break;
        case 'CONTINUE_TASK':
          detail = 'continued';
          break;
      }

      this.finish('succeeded', detail);
      return { status: 'succeeded', detail };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith('task_replan:') ? 'interrupted' : 'failed';
      this.finish(status, message);
      return { status, detail: message };
    }
  }

  stop(): void {
    if (this.current.status === 'running') {
      this.finish('interrupted', 'runtime_stop');
    }
  }

  private async navigateTarget(
    targetId: string | undefined,
    startedGoal: string,
  ): Promise<string> {
    const state = this.semantic.capture(this.snapshot());
    const target = state.targets.find(candidate => candidate.id === targetId);
    if (!target) throw new Error('navigate_semantic_target_missing');

    this.update('navigating_target', {
      target: target.id,
      kind: target.kind,
      distance: target.distance,
    });
    const result = await this.runPrimitive({
      action: 'NAVIGATE',
      targetPosition: target.position,
      confidence: 1,
      source: 'task',
      reason: `executive_navigate:${target.kind}`,
    }, 30_000);
    if (result.status !== 'succeeded') {
      throw new Error(`navigate_target_failed:${result.detail}`);
    }
    this.safeCheckpoint(startedGoal, 'target_reached');
    return `reached:${target.id}`;
  }

  private async gatherResource(
    resource: ExecutiveResource,
    amount: number,
    targetId: string | undefined,
    startedGoal: string,
  ): Promise<string> {
    if (!resource || resource === 'none') throw new Error('gather_resource_missing_resource');

    const initial = inventoryMap(this.bot)[resource] ?? 0;
    const targetTotal = Math.max(initial, Math.max(1, amount));
    const triedSources = new Set<string>();

    for (let step = 0; step < 24; step++) {
      const current = inventoryMap(this.bot)[resource] ?? 0;
      this.update('gathering_resource', {
        resource,
        collected: current - initial,
        target: targetTotal,
        inventoryCount: current,
      });
      if (current >= targetTotal) {
        return `resource_collected:${resource}:${current - initial}`;
      }

      const state = this.semantic.capture(this.snapshot());

      const dropped = state.targets
        .filter(target =>
          target.kind === 'item_drop' &&
          target.metadata.itemName === resource &&
          !triedSources.has(target.id),
        )
        .sort((a, b) => a.distance - b.distance)[0];
      if (dropped) {
        triedSources.add(dropped.id);
        const collect = await this.runPrimitive({
          action: 'NAVIGATE',
          targetPosition: dropped.position,
          confidence: 1,
          source: 'task',
          reason: `collect_dropped_resource:${resource}`,
        }, 15_000);
        if (collect.status === 'interrupted') throw new Error('task_replan:resource_collection_interrupted');
        this.safeCheckpoint(startedGoal, 'resource_drop_collected');
        continue;
      }

      const sources = state.targets
        .filter(target =>
          target.kind === 'resource_source' &&
          target.metadata.resource === resource &&
          !triedSources.has(target.id),
        )
        .sort((a, b) => {
          if (a.id === targetId) return -1;
          if (b.id === targetId) return 1;
          return a.distance - b.distance;
        });

      const source = sources[0];
      if (!source) throw new Error(`resource_source_unavailable:${resource}`);
      triedSources.add(source.id);

      const blockName = typeof source.metadata.blockName === 'string'
        ? source.metadata.blockName
        : null;
      const blockTargetId = typeof source.metadata.blockTargetId === 'string'
        ? source.metadata.blockTargetId
        : null;
      if (!blockName || !blockTargetId) {
        throw new Error(`resource_source_invalid:${resource}`);
      }

      const raw = this.capturePrimitiveWorld();
      const candidate: WorldCandidate = {
        id: blockTargetId,
        kind: 'block',
        name: blockName,
        distance: Math.round(this.bot.entity.position.distanceTo({
          x: source.position.x,
          y: source.position.y,
          z: source.position.z,
        } as any) * 10) / 10,
        position: { ...source.position },
      };
      if (!raw.blockCandidates.some(entry => entry.id === candidate.id)) {
        raw.blockCandidates.unshift(candidate);
      }

      const result = await this.runPrimitive({
        action: 'MINE',
        blockTargetId,
        confidence: 1,
        source: 'task',
        reason: `gather_dynamic_resource:${resource}`,
      }, 25_000, raw);
      if (result.status === 'interrupted') throw new Error('task_replan:resource_mining_interrupted');
      if (result.status !== 'succeeded') {
        this.safeCheckpoint(startedGoal, 'resource_source_failed');
        continue;
      }
      this.safeCheckpoint(startedGoal, 'resource_mined');
    }

    throw new Error(`resource_task_step_limit:${resource}`);
  }

  private async excavateTarget(
    targetId: string | undefined,
    startedGoal: string,
  ): Promise<string> {
    const state = this.semantic.capture(this.snapshot());
    const target = state.targets.find(candidate =>
      candidate.id === targetId && candidate.kind === 'excavation_site',
    );
    if (!target) throw new Error('excavate_target_missing');

    const direction = excavationDirection(target);
    if (!direction) throw new Error('excavate_target_missing_direction');
    const mode = excavationMode(target);

    this.update('excavating_target', {
      target: target.id,
      distance: target.distance,
      direction,
      mode,
    });

    const result = await this.runPrimitive({
      action: 'DIG_STAIRCASE',
      direction,
      excavationMode: mode,
      targetPosition: target.position,
      confidence: 1,
      source: 'task',
      reason: `executive_excavate:${mode}:${target.id}`,
    }, 40_000);
    if (result.status === 'interrupted') throw new Error('task_replan:excavation_interrupted');
    if (result.status !== 'succeeded') throw new Error(`excavate_failed:${result.detail}`);

    this.safeCheckpoint(startedGoal, 'excavation_segment_completed');
    return `excavated:${mode}:${target.id}`;
  }

  private async attackTarget(
    targetId: string | undefined,
    startedGoal: string,
  ): Promise<string> {
    const state = this.semantic.capture(this.snapshot());
    const target = state.targets.find(candidate =>
      candidate.id === targetId && candidate.kind === 'entity',
    );
    if (!target) throw new Error('attack_target_missing');

    const entityId = Number(target.metadata.entityId);
    const entityName = typeof target.metadata.entityName === 'string'
      ? target.metadata.entityName
      : 'entity';
    if (!Number.isFinite(entityId)) throw new Error('attack_target_invalid_entity');

    const raw = this.capturePrimitiveWorld();
    const candidate: WorldCandidate = {
      id: `entity:${entityId}`,
      kind: 'entity',
      name: entityName,
      distance: target.distance,
      position: { ...target.position },
      hostile: Boolean(target.metadata.hostile),
    };
    if (!raw.entityCandidates.some(entry => entry.id === candidate.id)) {
      raw.entityCandidates.unshift(candidate);
    }

    this.update('attacking_target', {
      target: target.id,
      entity: entityName,
      distance: target.distance,
    });
    const result = await this.runPrimitive({
      action: 'ATTACK',
      entityTargetId: candidate.id,
      confidence: 1,
      source: 'task',
      reason: `executive_attack:${entityName}`,
    }, 30_000, raw);
    if (result.status === 'interrupted') throw new Error('task_replan:attack_interrupted');
    if (result.status !== 'succeeded') throw new Error(`attack_failed:${result.detail}`);

    this.safeCheckpoint(startedGoal, 'entity_attacked');
    return `attacked:${entityName}`;
  }

  private async craftExecutiveItem(
    item: TypedGameplayDecision['craftItem'],
    requestedAmount: number,
    startedGoal: string,
  ): Promise<string> {
    if (!item || item === 'none') throw new Error('craft_item_missing_item');

    const initial = inventoryMap(this.bot)[item] ?? 0;
    const targetTotal = Math.max(initial, Math.max(1, requestedAmount));

    for (let attempt = 0; attempt < 32; attempt++) {
      const current = inventoryMap(this.bot)[item] ?? 0;
      this.update('crafting_item', {
        item,
        inventoryCount: current,
        target: targetTotal,
        crafted: current - initial,
      });
      if (current >= targetTotal) {
        return `crafted:${item}:${current - initial}`;
      }

      const before = current;
      const result = await this.runPrimitive({
        action: 'CRAFT',
        craftItem: item,
        confidence: 1,
        source: 'task',
        reason: 'executive_craft_item',
      }, 30_000);
      if (result.status === 'interrupted') {
        throw new Error('task_replan:craft_interrupted');
      }
      if (result.status !== 'succeeded') {
        throw new Error(`craft_item_failed:${item}:${result.detail}`);
      }

      const after = inventoryMap(this.bot)[item] ?? 0;
      if (after <= before) {
        throw new Error(`craft_no_inventory_progress:${item}`);
      }
      this.safeCheckpoint(startedGoal, `crafted_${item}`);
    }

    throw new Error(`craft_item_step_limit:${item}`);
  }

  private async buildStructure(
    structure: ExecutiveStructure,
    targetId: string | undefined,
    startedGoal: string,
  ): Promise<string> {
    switch (structure) {
      case 'shelter':
        return this.establishShelter(targetId, startedGoal);
      default:
        throw new Error('build_structure_missing_structure');
    }
  }

  private async establishShelter(
    targetId: string | undefined,
    startedGoal: string,
  ): Promise<string> {
    const tried = new Set<string>();

    for (let attempt = 0; attempt < 4; attempt++) {
      const state = this.semantic.capture(this.snapshot());
      const sites = state.targets
        .filter(target => target.kind === 'shelter_site' && !tried.has(target.id))
        .sort((a, b) => {
          if (a.id === targetId) return -1;
          if (b.id === targetId) return 1;
          return b.score - a.score;
        });
      const site = sites[0];
      if (!site) throw new Error('no_buildable_shelter_site');
      tried.add(site.id);

      this.update('establishing_shelter', {
        stage: 'navigating',
        site: site.id,
        attempt: attempt + 1,
      });

      const distance = Math.hypot(
        this.bot.entity.position.x - site.position.x,
        this.bot.entity.position.y - site.position.y,
        this.bot.entity.position.z - site.position.z,
      );
      let buildPosition = site.position;
      if (distance > 1.5) {
        const nav = await this.runPrimitive({
          action: 'NAVIGATE',
          targetPosition: site.position,
          confidence: 1,
          source: 'task',
          reason: 'navigate_buildable_shelter_site',
        }, 30_000);
        if (nav.status === 'interrupted') {
          throw new Error('task_replan:shelter_navigation_interrupted');
        }
        if (nav.status !== 'succeeded') {
          // A selected site can become locally unreachable after digging or
          // terrain changes. If the bot is already dry and grounded nearby,
          // let BUILD_SHELTER validate the current footprint instead of
          // rejecting the whole intent before construction is even attempted.
          const current = this.semantic.capture(this.snapshot());
          if (
            distance <= 6 &&
            !current.player.inWater &&
            current.player.onSolidGround
          ) {
            buildPosition = {
              x: Math.floor(this.bot.entity.position.x),
              y: Math.floor(this.bot.entity.position.y),
              z: Math.floor(this.bot.entity.position.z),
            };
            this.update('establishing_shelter', {
              stage: 'local_fallback',
              site: site.id,
              attempt: attempt + 1,
            });
          } else {
            continue;
          }
        }
      }

      const arrived = this.semantic.capture(this.snapshot());
      if (arrived.player.inWater || !arrived.player.onSolidGround) continue;

      this.update('establishing_shelter', {
        stage: 'building',
        site: site.id,
        attempt: attempt + 1,
      });
      const result = await this.runPrimitive({
        action: 'BUILD_SHELTER',
        targetPosition: buildPosition,
        confidence: 1,
        source: 'task',
        reason: buildPosition === site.position
          ? 'semantic_first_night_shelter'
          : 'local_validated_shelter_fallback',
      }, 30_000);

      if (result.status === 'succeeded') {
        this.safeCheckpoint(startedGoal, 'shelter_built');
        return `shelter_built:${site.id}`;
      }
      if (result.status === 'interrupted') {
        throw new Error('task_replan:shelter_build_interrupted');
      }
      if (!isRetriableShelterSiteFailure(result.detail)) {
        throw new Error(`shelter_failed:${result.detail}`);
      }

      this.safeCheckpoint(startedGoal, 'shelter_site_rejected');
    }

    throw new Error('shelter_failed:no_viable_site_after_retries');
  }

  private async runPrimitive(
    decision: TypedGameplayDecision,
    timeoutMs: number,
    state?: JevWorldState,
  ) {
    const world = state ?? this.capturePrimitiveWorld();
    const result = await this.primitive.runAndWait(decision, world, 'normal', timeoutMs);
    this.log('task_primitive_result', {
      task_id: this.current.id,
      task: this.current.task,
      primitive_action: decision.action,
      primitive_status: result.status,
      primitive_detail: result.detail,
      primitive_target: result.targetId,
    });
    return result;
  }

  private capturePrimitiveWorld(): JevWorldState {
    return this.sensor.capture(this.primitive.snapshot());
  }

  private safeCheckpoint(startedGoal: string, label: string): void {
    this.current = {
      ...this.current,
      updatedAt: Date.now(),
      detail: label,
    };
    this.log('task_checkpoint', {
      task_id: this.current.id,
      task: this.current.task,
      checkpoint: label,
      strategy_goal: this.shared.get().currentGoal,
    });

    const latestGoal = this.shared.get().currentGoal;
    if (startedGoal && latestGoal && latestGoal !== startedGoal) {
      this.log('task_strategy_updated', {
        task_id: this.current.id,
        task: this.current.task,
        checkpoint: label,
        previous_goal: startedGoal,
        latest_goal: latestGoal,
        handling: 'defer_until_task_boundary',
      });
    }
  }

  private update(detail: string, progress: Record<string, number | string | boolean | null>): void {
    this.current = {
      ...this.current,
      updatedAt: Date.now(),
      detail,
      progress: {
        ...this.current.progress,
        ...progress,
      },
    };
  }

  private finish(
    status: 'succeeded' | 'failed' | 'interrupted',
    detail: string,
  ): void {
    this.current = {
      ...this.current,
      status,
      updatedAt: Date.now(),
      detail,
    };
    this.log(`task_${status}`, {
      task_id: this.current.id,
      task: this.current.task,
      target_id: this.current.targetId,
      detail,
      duration_ms: this.current.startedAt ? Date.now() - this.current.startedAt : null,
      progress: this.current.progress,
    });
    this.shared.pushEvent({
      type: `task_${status}`,
      detail: `${this.current.task}: ${detail}`,
      importance: status === 'failed' ? 'high' : 'medium',
    });
  }

  private log(kind: string, payload: Record<string, unknown>): void {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      ...payload,
    }));
  }
}

function idleTask(): ExecutiveTaskSnapshot {
  return {
    id: 0,
    task: 'NONE',
    targetId: null,
    status: 'idle',
    startedAt: null,
    updatedAt: Date.now(),
    detail: '',
    progress: {},
  };
}

function inventoryMap(bot: mineflayer.Bot): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of bot.inventory.items()) {
    result[item.name] = (result[item.name] ?? 0) + item.count;
  }
  return result;
}

function isRetriableShelterSiteFailure(detail: string): boolean {
  return [
    'shelter_requires_solid_ground',
    'shelter_uneven_or_liquid_ground',
    'shelter_missing_reference',
    'shelter_roof_anchor_reference_missing',
    'shelter_roof_anchor_failed',
    'shelter_roof_reference_missing',
    'shelter_roof_failed',
    'shelter_door_ground_missing',
    'shelter_doorway_blocked',
    'shelter_door_failed',
    'shelter_too_incomplete',
  ].some(reason => detail.includes(reason));
}

function excavationDirection(target: SemanticTarget): 'N' | 'E' | 'S' | 'W' | null {
  const value = target.metadata.direction;
  return value === 'N' || value === 'E' || value === 'S' || value === 'W'
    ? value
    : null;
}

function excavationMode(target: SemanticTarget): 'down' | 'up' {
  return target.metadata.mode === 'up' ? 'up' : 'down';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
