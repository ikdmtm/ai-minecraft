import type mineflayer from 'mineflayer';
import type { SharedStateBus } from '../cognitive/sharedState.js';
import { SemanticWorldModel } from './semanticWorldModel.js';
import { SkillExecutor } from './skillExecutor.js';
import type { WorldSensor } from './worldSensor.js';
import type {
  ExecutiveActionCapability,
  ExecutiveDecision,
  ExecutiveTaskSnapshot,
  TaskExecutionResult,
} from './executiveTypes.js';
import type {
  JevWorldState,
  TypedGameplayDecision,
  WorldCandidate,
} from './typedActions.js';
import type { WorldMemory } from './worldMemory.js';

export class TaskExecutor {
  private sequence = 0;
  private current: ExecutiveTaskSnapshot = idleTask();

  constructor(
    private readonly bot: mineflayer.Bot,
    private readonly shared: SharedStateBus,
    private readonly primitive: SkillExecutor,
    private readonly sensor: WorldSensor,
    private readonly semantic: SemanticWorldModel,
    private readonly memory: WorldMemory,
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
      affordance_id: decision.capabilityId ?? null,
      source: decision.source,
      confidence: decision.confidence,
      based_on_revision: decision.basedOnRevision,
    });

    let affordance: ExecutiveActionCapability | undefined;
    let learningBefore: LearningSnapshot | undefined;
    try {
      let detail = '';
      switch (decision.task) {
        case 'EXECUTE_AFFORDANCE': {
          if (!decision.capabilityId) throw new Error('affordance_missing');
          const state = this.semantic.capture(this.snapshot());
          affordance = state.capabilities.actions.find(action => action.id === decision.capabilityId);
          if (!affordance) throw new Error(`affordance_unavailable:${decision.capabilityId}`);
          learningBefore = captureLearningSnapshot(this.bot);
          detail = await this.executeAffordance(affordance, startedGoal);
          const learningAfter = captureLearningSnapshot(this.bot);
          this.memory.recordProcedureOutcome({
            key: procedureKey(affordance),
            label: procedureLabel(affordance),
            success: true,
            detail: 'success',
            metadata: {
              ...procedureMetadata(affordance),
              observedEffect: summarizeEffect(learningBefore, learningAfter),
            },
          });
          break;
        }
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
      if (affordance) {
        this.memory.recordProcedureOutcome({
          key: procedureKey(affordance),
          label: procedureLabel(affordance),
          success: false,
          detail: sanitizeProcedureDetail(message, affordance),
          metadata: {
            ...procedureMetadata(affordance),
            observedEffect: learningBefore
              ? summarizeEffect(learningBefore, captureLearningSnapshot(this.bot))
              : 'unknown',
          },
        });
      }
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

  private async executeAffordance(
    affordance: ExecutiveActionCapability,
    startedGoal: string,
  ): Promise<string> {
    this.update('executing_affordance', {
      affordance: affordance.id,
      kind: affordance.kind,
      item: affordance.item ?? null,
      target: affordance.targetId ?? null,
    });

    switch (affordance.kind) {
      case 'move_to': {
        if (!affordance.position) throw new Error('move_affordance_missing_position');
        await this.requirePrimitiveSuccess(await this.runPrimitive({
          action: 'NAVIGATE',
          targetPosition: affordance.position,
          confidence: 1,
          source: 'task',
          reason: `affordance:${affordance.id}`,
        }, 30_000), affordance);
        break;
      }

      case 'break_block': {
        if (!affordance.blockTargetId || !affordance.position) {
          throw new Error('break_affordance_missing_target');
        }
        const raw = this.capturePrimitiveWorld();
        const blockName = stringSpec(affordance, 'blockName') ?? 'block';
        const candidate: WorldCandidate = {
          id: affordance.blockTargetId,
          kind: 'block',
          name: blockName,
          distance: round1(this.bot.entity.position.distanceTo(affordance.position as any)),
          position: { ...affordance.position },
        };
        if (!raw.blockCandidates.some(entry => entry.id === candidate.id)) {
          raw.blockCandidates.unshift(candidate);
        }
        await this.requirePrimitiveSuccess(await this.runPrimitive({
          action: 'MINE',
          blockTargetId: affordance.blockTargetId,
          confidence: 1,
          source: 'task',
          reason: `affordance:${affordance.id}`,
        }, 25_000, raw), affordance);
        break;
      }

      case 'attack_entity': {
        if (!affordance.entityTargetId || !affordance.position) {
          throw new Error('attack_affordance_missing_target');
        }
        const raw = this.capturePrimitiveWorld();
        const candidate: WorldCandidate = {
          id: affordance.entityTargetId,
          kind: 'entity',
          name: stringSpec(affordance, 'entityName') ?? 'entity',
          distance: round1(this.bot.entity.position.distanceTo(affordance.position as any)),
          position: { ...affordance.position },
          hostile: Boolean(affordance.preconditions.hostile),
        };
        if (!raw.entityCandidates.some(entry => entry.id === candidate.id)) {
          raw.entityCandidates.unshift(candidate);
        }
        await this.requirePrimitiveSuccess(await this.runPrimitive({
          action: 'ATTACK',
          entityTargetId: affordance.entityTargetId,
          confidence: 1,
          source: 'task',
          reason: `affordance:${affordance.id}`,
        }, 20_000, raw), affordance);
        break;
      }

      case 'collect_drop': {
        if (!affordance.position) throw new Error('collect_affordance_missing_position');
        await this.requirePrimitiveSuccess(await this.runPrimitive({
          action: 'NAVIGATE',
          targetPosition: affordance.position,
          confidence: 1,
          source: 'task',
          reason: `affordance:${affordance.id}`,
        }, 15_000), affordance);
        await delay(250);
        break;
      }

      case 'use_item': {
        if (!affordance.item) throw new Error('use_affordance_missing_item');
        await this.requirePrimitiveSuccess(await this.runPrimitive({
          action: 'USE_ITEM',
          useItem: affordance.item,
          confidence: 1,
          source: 'task',
          reason: `affordance:${affordance.id}`,
        }, 20_000), affordance);
        break;
      }

      case 'place_item': {
        if (!affordance.item) throw new Error('place_affordance_missing_item');
        await this.requirePrimitiveSuccess(await this.runPrimitive({
          action: 'PLACE_ITEM',
          placeItem: affordance.item,
          targetPosition: affordance.position,
          confidence: 1,
          source: 'task',
          reason: `affordance:${affordance.id}`,
        }, 20_000), affordance);
        break;
      }

      case 'craft_recipe': {
        if (!affordance.item) throw new Error('craft_affordance_missing_item');
        await this.requirePrimitiveSuccess(await this.runPrimitive({
          action: 'CRAFT',
          craftItem: affordance.item,
          confidence: 1,
          source: 'task',
          reason: `affordance:${affordance.id}`,
        }, 30_000), affordance);
        break;
      }

      case 'process_recipe': {
        if (!affordance.item) throw new Error('process_affordance_missing_item');
        await this.requirePrimitiveSuccess(await this.runPrimitive({
          action: 'PROCESS_ITEM',
          processItem: affordance.item,
          targetPosition: affordance.position,
          confidence: 1,
          source: 'task',
          reason: `affordance:${affordance.id}`,
        }, 35_000), affordance);
        break;
      }

      case 'interact_block': {
        if (!affordance.position) throw new Error('interact_affordance_missing_position');
        await this.requirePrimitiveSuccess(await this.runPrimitive({
          action: 'INTERACT_BLOCK',
          targetPosition: affordance.position,
          confidence: 1,
          source: 'task',
          reason: `affordance:${affordance.id}`,
        }, 20_000), affordance);
        break;
      }

      case 'wait_condition':
        await this.waitForCondition(affordance);
        break;
    }

    this.safeCheckpoint(startedGoal, `affordance_completed:${affordance.kind}`);
    return `affordance_executed:${affordance.id}`;
  }

  private async requirePrimitiveSuccess(
    result: Awaited<ReturnType<SkillExecutor['runAndWait']>>,
    affordance: ExecutiveActionCapability,
  ): Promise<void> {
    if (result.status === 'succeeded') return;
    if (result.status === 'interrupted') {
      throw new Error(`task_replan:affordance_interrupted:${affordance.id}:${result.detail}`);
    }
    throw new Error(`affordance_failed:${affordance.id}:${result.detail}`);
  }

  private async waitForCondition(affordance: ExecutiveActionCapability): Promise<void> {
    const condition = stringSpec(affordance, 'condition');
    if (condition !== 'daylight' && condition !== 'night') {
      throw new Error(`unsupported_wait_condition:${condition ?? 'none'}`);
    }

    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const time = this.bot.time.timeOfDay;
      const night = time >= 12500 && time < 23500;
      if ((condition === 'daylight' && !night) || (condition === 'night' && night)) return;

      const threat = this.shared.get().threatLevel;
      if (threat === 'danger' || threat === 'critical') {
        throw new Error(`task_replan:wait_interrupted_by_threat:${threat}`);
      }

      this.update('waiting_for_condition', {
        affordance: affordance.id,
        condition,
        timeOfDay: time,
      });
      await delay(1_000);
    }

    throw new Error(`wait_condition_timeout:${condition}`);
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

function procedureLabel(affordance: ExecutiveActionCapability): string {
  const parts = [affordance.kind];
  if (affordance.item) parts.push(`item=${affordance.item}`);
  if (affordance.outputItem) parts.push(`output=${affordance.outputItem}`);
  if (affordance.station) parts.push(`station=${affordance.station}`);
  const blockName = stringSpec(affordance, 'blockName');
  const entityName = stringSpec(affordance, 'entityName');
  const targetKind = stringSpec(affordance, 'targetKind');
  if (blockName) parts.push(`block=${blockName}`);
  if (entityName) parts.push(`entity=${entityName}`);
  if (targetKind) parts.push(`target=${targetKind}`);
  return parts.join(' ');
}

function sanitizeProcedureDetail(
  message: string,
  affordance: ExecutiveActionCapability,
): string {
  return message
    .replaceAll(affordance.id, '<affordance>')
    .replace(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g, '<position>')
    .slice(0, 240);
}

function procedureKey(affordance: ExecutiveActionCapability): string {
  return [
    affordance.kind,
    affordance.item ?? '',
    affordance.outputItem ?? '',
    affordance.station ?? '',
    stringSpec(affordance, 'blockName') ?? '',
    stringSpec(affordance, 'entityName') ?? '',
    stringSpec(affordance, 'targetKind') ?? '',
  ].join('|');
}

function procedureMetadata(
  affordance: ExecutiveActionCapability,
): Record<string, string | number | boolean | null> {
  return {
    kind: affordance.kind,
    item: affordance.item ?? null,
    outputItem: affordance.outputItem ?? null,
    station: affordance.station ?? null,
    blockName: stringSpec(affordance, 'blockName'),
    entityName: stringSpec(affordance, 'entityName'),
  };
}

function stringSpec(affordance: ExecutiveActionCapability, key: string): string | null {
  const value = affordance.specification[key];
  return typeof value === 'string' && value ? value : null;
}

interface LearningSnapshot {
  hp: number;
  hunger: number;
  position: { x: number; y: number; z: number };
  inventory: Record<string, number>;
}

function captureLearningSnapshot(bot: mineflayer.Bot): LearningSnapshot {
  const inventory: Record<string, number> = {};
  for (const item of bot.inventory.items()) {
    inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
  }
  return {
    hp: bot.health,
    hunger: bot.food,
    position: {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z,
    },
    inventory,
  };
}

function summarizeEffect(before: LearningSnapshot, after: LearningSnapshot): string {
  const changes: string[] = [];
  const hpDelta = after.hp - before.hp;
  const hungerDelta = after.hunger - before.hunger;
  if (hpDelta !== 0) changes.push(`hp:${signed(hpDelta)}`);
  if (hungerDelta !== 0) changes.push(`hunger:${signed(hungerDelta)}`);

  const names = new Set([...Object.keys(before.inventory), ...Object.keys(after.inventory)]);
  for (const name of [...names].sort()) {
    const delta = (after.inventory[name] ?? 0) - (before.inventory[name] ?? 0);
    if (delta !== 0) changes.push(`inventory:${name}:${signed(delta)}`);
  }

  const moved = Math.hypot(
    after.position.x - before.position.x,
    after.position.y - before.position.y,
    after.position.z - before.position.z,
  );
  if (moved >= 0.5) changes.push(`moved:${Math.round(moved * 10) / 10}`);
  return changes.length > 0 ? changes.join(',') : 'no_observable_state_change';
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
