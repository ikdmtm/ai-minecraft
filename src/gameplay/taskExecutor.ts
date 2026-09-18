import type mineflayer from 'mineflayer';
import type { SharedStateBus } from '../cognitive/sharedState.js';
import { SemanticWorldModel } from './semanticWorldModel.js';
import { SkillExecutor } from './skillExecutor.js';
import type { WorldSensor } from './worldSensor.js';
import type {
  ExecutiveDecision,
  ExecutiveTaskSnapshot,
  ExecutiveTaskType,
  ExecutiveWorldState,
  SemanticTarget,
  TaskExecutionResult,
} from './executiveTypes.js';
import type {
  JevWorldState,
  TypedGameplayDecision,
  WorldCandidate,
} from './typedActions.js';

const RAW_FOOD_ITEMS = new Set([
  'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'salmon', 'cod',
]);

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
      source: decision.source,
      confidence: decision.confidence,
      based_on_revision: decision.basedOnRevision,
    });

    try {
      let detail = '';
      switch (decision.task) {
        case 'REACH_LAND':
          detail = await this.reachLand(decision.targetId, startedGoal);
          break;
        case 'GATHER_WOOD':
          detail = await this.gatherWood(decision.amount ?? 8, decision.targetId, startedGoal);
          break;
        case 'PREPARE_STARTER_TOOLS':
          detail = await this.prepareStarterTools(startedGoal);
          break;
        case 'ACQUIRE_STONE':
          detail = await this.acquireStone(decision.amount ?? 12, startedGoal);
          break;
        case 'GATHER_FOOD':
          detail = await this.gatherFood(decision.amount ?? 4, decision.targetId, startedGoal);
          break;
        case 'ESTABLISH_SHELTER':
          detail = await this.establishShelter(startedGoal);
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

  private async reachLand(targetId: string | undefined, startedGoal: string): Promise<string> {
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = this.semantic.capture(this.snapshot());
      if (!state.player.inWater && state.player.onSolidGround) return 'already_on_land';

      const targets = state.targets
        .filter(target => target.kind === 'land' && !tried.has(target.id))
        .sort((a, b) => {
          if (a.id === targetId) return -1;
          if (b.id === targetId) return 1;
          return b.score - a.score;
        });

      const target = targets[0];
      if (!target) throw new Error('no_safe_land_target');
      tried.add(target.id);

      this.update('reaching_land', {
        attempt: attempt + 1,
        target: target.id,
        distance: target.distance,
      });
      const result = await this.runPrimitive({
        action: 'NAVIGATE',
        targetPosition: target.position,
        confidence: 1,
        source: 'task',
        reason: 'semantic_reach_land',
      }, 24_000);

      const after = this.semantic.capture(this.snapshot());
      if (!after.player.inWater && after.player.onSolidGround) {
        return `reached_land:${target.id}`;
      }
      if (result.status === 'interrupted') throw new Error('task_replan:safety_interrupted_land_navigation');
      this.safeCheckpoint(startedGoal, 'reach_land_attempt');
    }
    throw new Error('failed_to_reach_land_after_retries');
  }

  private async gatherWood(
    requestedAmount: number,
    targetId: string | undefined,
    startedGoal: string,
  ): Promise<string> {
    const initial = countLogs(inventoryMap(this.bot));
    const targetTotal = Math.max(initial, Math.max(1, requestedAmount));
    const triedClusters = new Set<string>();

    for (let step = 0; step < 24; step++) {
      const now = countLogs(inventoryMap(this.bot));
      this.update('gathering_wood', {
        collected: now - initial,
        target: requestedAmount,
        inventoryLogs: now,
      });
      if (now >= targetTotal) return `logs_collected:${now - initial}`;

      let raw = this.capturePrimitiveWorld();
      const visibleLog = nearestBlock(raw, block => block.name.endsWith('_log'));
      if (visibleLog) {
        const result = await this.runPrimitive({
          action: 'MINE',
          blockTargetId: visibleLog.id,
          confidence: 1,
          source: 'task',
          reason: 'gather_wood_visible_log',
        }, 25_000, raw);
        if (result.status === 'interrupted') throw new Error('task_replan:wood_skill_interrupted');
        this.safeCheckpoint(startedGoal, 'wood_mined');
        continue;
      }

      const semanticState = this.semantic.capture(this.snapshot());
      const trees = semanticState.targets
        .filter(target => target.kind === 'tree_cluster' && !triedClusters.has(target.id))
        .sort((a, b) => {
          if (a.id === targetId) return -1;
          if (b.id === targetId) return 1;
          return b.score - a.score;
        });
      const tree = trees[0];
      if (!tree) throw new Error('no_reachable_tree_cluster');
      triedClusters.add(tree.id);

      const result = await this.runPrimitive({
        action: 'NAVIGATE',
        targetPosition: tree.position,
        confidence: 1,
        source: 'task',
        reason: 'navigate_tree_cluster',
      }, 24_000);
      if (result.status === 'interrupted') throw new Error('task_replan:tree_navigation_interrupted');
      this.safeCheckpoint(startedGoal, 'tree_reached');
    }

    throw new Error('wood_task_step_limit');
  }

  private async prepareStarterTools(startedGoal: string): Promise<string> {
    if (hasPickaxe(inventoryMap(this.bot))) return 'pickaxe_already_available';

    this.update('preparing_starter_tools', { stage: 'wooden_pickaxe' });
    const result = await this.runPrimitive({
      action: 'CRAFT',
      craftItem: 'wooden_pickaxe',
      confidence: 1,
      source: 'task',
      reason: 'starter_tool_chain',
    }, 25_000);
    if (result.status !== 'succeeded') throw new Error(`starter_tools_failed:${result.detail}`);
    this.safeCheckpoint(startedGoal, 'starter_tools_crafted');

    if (!hasPickaxe(inventoryMap(this.bot))) throw new Error('starter_tools_missing_pickaxe_after_craft');
    return 'wooden_pickaxe_ready';
  }

  private async acquireStone(requestedAmount: number, startedGoal: string): Promise<string> {
    if (!hasPickaxe(inventoryMap(this.bot))) throw new Error('stone_requires_pickaxe');

    const initial = inventoryMap(this.bot).cobblestone ?? 0;
    const targetTotal = Math.max(initial, Math.max(3, requestedAmount));

    for (let step = 0; step < 24; step++) {
      const current = inventoryMap(this.bot).cobblestone ?? 0;
      this.update('acquiring_stone', {
        collected: current - initial,
        target: requestedAmount,
        cobblestone: current,
      });
      if (current >= targetTotal) return `cobblestone_collected:${current - initial}`;

      const raw = this.capturePrimitiveWorld();
      const visibleStone = nearestBlock(raw, block =>
        block.name === 'stone' || block.name === 'cobblestone',
      );

      if (visibleStone) {
        const result = await this.runPrimitive({
          action: 'MINE',
          blockTargetId: visibleStone.id,
          confidence: 1,
          source: 'task',
          reason: 'acquire_visible_stone',
        }, 25_000, raw);
        if (result.status === 'interrupted') throw new Error('task_replan:stone_mining_interrupted');
        this.safeCheckpoint(startedGoal, 'stone_mined');
        continue;
      }

      const semanticState = this.semantic.capture(this.snapshot());
      if (semanticState.player.inWater || !semanticState.player.onSolidGround) {
        throw new Error('stone_requires_safe_solid_ground');
      }

      const result = await this.runPrimitive({
        action: 'DIG_STAIRCASE',
        direction: chooseStairDirection(semanticState),
        confidence: 1,
        source: 'task',
        reason: 'no_exposed_stone_safe_staircase',
      }, 40_000);
      if (result.status !== 'succeeded') {
        throw new Error(`staircase_failed:${result.detail}`);
      }
      this.safeCheckpoint(startedGoal, 'staircase_step');
    }

    throw new Error('stone_task_step_limit');
  }

  private async gatherFood(
    requestedAmount: number,
    targetId: string | undefined,
    startedGoal: string,
  ): Promise<string> {
    const initial = countRawFood(inventoryMap(this.bot));
    const targetTotal = Math.max(initial, Math.max(1, requestedAmount));

    for (let step = 0; step < 8; step++) {
      const current = countRawFood(inventoryMap(this.bot));
      this.update('gathering_food', {
        collected: current - initial,
        target: requestedAmount,
      });
      if (current >= targetTotal) return `food_collected:${current - initial}`;

      const semanticState = this.semantic.capture(this.snapshot());
      const foodTarget = semanticState.targets
        .filter(target => target.kind === 'food_source')
        .sort((a, b) => {
          if (a.id === targetId) return -1;
          if (b.id === targetId) return 1;
          return b.score - a.score;
        })[0];
      if (!foodTarget) throw new Error('no_food_source');

      const raw = this.capturePrimitiveWorld();
      const entityId = Number(foodTarget.metadata.entityId);
      let candidate = raw.entityCandidates.find(entity => entity.id === `entity:${entityId}`);
      if (!candidate) {
        const nav = await this.runPrimitive({
          action: 'NAVIGATE',
          targetPosition: foodTarget.position,
          confidence: 1,
          source: 'task',
          reason: 'navigate_food_source',
        }, 22_000);
        if (nav.status === 'interrupted') throw new Error('task_replan:food_navigation_interrupted');
        candidate = this.capturePrimitiveWorld().entityCandidates.find(entity => entity.id === `entity:${entityId}`);
      }
      if (!candidate) throw new Error('food_entity_not_visible_after_navigation');

      const latest = this.capturePrimitiveWorld();
      const result = await this.runPrimitive({
        action: 'HUNT_FOOD',
        entityTargetId: candidate.id,
        confidence: 1,
        source: 'task',
        reason: 'gather_food',
      }, 30_000, latest);
      if (result.status === 'interrupted') throw new Error('task_replan:hunt_interrupted');
      this.safeCheckpoint(startedGoal, 'food_hunted');
    }

    throw new Error('food_task_step_limit');
  }

  private async establishShelter(startedGoal: string): Promise<string> {
    const state = this.semantic.capture(this.snapshot());
    if (state.player.inWater || !state.player.onSolidGround) {
      throw new Error('shelter_requires_land');
    }
    this.update('establishing_shelter', { stage: 'building' });
    const result = await this.runPrimitive({
      action: 'BUILD_SHELTER',
      confidence: 1,
      source: 'task',
      reason: 'semantic_first_night_shelter',
    }, 30_000);
    if (result.status !== 'succeeded') throw new Error(`shelter_failed:${result.detail}`);
    this.safeCheckpoint(startedGoal, 'shelter_built');
    return 'shelter_built';
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

    const taskAge = this.current.startedAt ? Date.now() - this.current.startedAt : 0;
    const latestGoal = this.shared.get().currentGoal;
    if (taskAge >= 10_000 && startedGoal && latestGoal && latestGoal !== startedGoal) {
      throw new Error('task_replan:strategy_changed_at_safe_checkpoint');
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

function countLogs(inventory: Record<string, number>): number {
  return Object.entries(inventory)
    .filter(([name]) => name.endsWith('_log'))
    .reduce((sum, [, count]) => sum + count, 0);
}

function countRawFood(inventory: Record<string, number>): number {
  return Object.entries(inventory)
    .filter(([name]) => RAW_FOOD_ITEMS.has(name))
    .reduce((sum, [, count]) => sum + count, 0);
}

function hasPickaxe(inventory: Record<string, number>): boolean {
  return Object.keys(inventory).some(name => name.endsWith('_pickaxe'));
}

function nearestBlock(
  world: JevWorldState,
  predicate: (candidate: WorldCandidate) => boolean,
): WorldCandidate | null {
  return world.blockCandidates
    .filter(candidate => candidate.kind === 'block' && predicate(candidate))
    .sort((a, b) => a.distance - b.distance)[0] ?? null;
}

function chooseStairDirection(state: ExecutiveWorldState): 'N' | 'E' | 'S' | 'W' {
  const food = state.targets.find(target => target.kind === 'food_source');
  if (!food) return 'E';
  const dx = food.position.x - state.player.position.x;
  const dz = food.position.z - state.player.position.z;
  if (Math.abs(dx) > Math.abs(dz)) return dx >= 0 ? 'W' : 'E';
  return dz >= 0 ? 'N' : 'S';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
