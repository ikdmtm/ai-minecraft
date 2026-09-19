import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import type { SharedStateBus } from '../cognitive/sharedState.js';
import { SemanticWorldModel } from './semanticWorldModel.js';
import { SkillExecutor } from './skillExecutor.js';
import type { WorldSensor } from './worldSensor.js';
import type { ExecutiveActionCapability, ExecutiveDecision, ExecutiveTaskSnapshot, TaskExecutionResult } from './executiveTypes.js';
import { normalizeMemoryDimension, type WorldMemory } from './worldMemory.js';
import { ExperienceMemory, bindProcedureStep, completeProcedureStepBinding, ProcedureBindingError, procedureEnvironmentMatches } from './experienceMemory.js';
import { parseOperation, windowSnapshot, type PrimitiveOperation } from './primitiveOperations.js';
import { observeOperation as observation, assessOperationEffect, type EffectAssessment } from './operationEvidence.js';
import type { SpatialRuntimeContext } from './spatialRuntimeContext.js';

export class TaskExecutor {
  private sequence = 0;
  private epoch = 0;
  private stopped = false;
  private current: ExecutiveTaskSnapshot = {
    id: 0, task: 'NONE', targetId: null, status: 'idle', startedAt: null, updatedAt: Date.now(), detail: '', progress: {},
  };
  constructor(
    private readonly bot: mineflayer.Bot,
    private readonly shared: SharedStateBus,
    private readonly primitive: SkillExecutor,
    private readonly sensor: WorldSensor,
    private readonly semantic: SemanticWorldModel,
    private readonly memory: WorldMemory,
    private readonly experience: ExperienceMemory = new ExperienceMemory(),
    private readonly spatial?: SpatialRuntimeContext,
  ) {
    this.log('run_context', { context: {
      world_id: this.memory.getWorldId(), minecraft_version: this.bot.version ?? null,
      registry_version: this.bot.registry?.version?.minecraftVersion ?? null,
      dimension: this.bot.game?.dimension == null ? null : String(this.bot.game.dimension),
      experience_session_id: this.experience.sessionId,
    } });
  }
  snapshot(): ExecutiveTaskSnapshot { return { ...this.current, progress: { ...this.current.progress } }; }
  async execute(decision: ExecutiveDecision): Promise<TaskExecutionResult> {
    if (this.stopped) return { status: 'interrupted', detail: 'runtime_stopped' };
    if (this.spatial && !this.spatial.isReady()) return { status: 'interrupted', detail: 'task_replan:spatial_not_ready' };
    if (this.current.status === 'running') return { status: 'failed', detail: 'task_already_running' };
    const ticket = this.spatial?.ticket();
    const token = ++this.epoch;
    const taskWorldId = this.memory.getWorldId();
    const taskDimension = normalizeMemoryDimension(this.bot.game.dimension);
    this.current = { id: ++this.sequence, task: decision.task, targetId: decision.targetId ?? null,
      status: 'running', startedAt: Date.now(), updatedAt: Date.now(), detail: '', progress: {} };
    this.log('task_started', { task_id: this.current.id, task: decision.task,
      spatial_epoch: ticket?.epoch ?? null,
      affordance_id: decision.capabilityId ?? null, operation: decision.operation ?? null,
      knowledge_query: decision.knowledgeQuery ?? null, knowledge_offset: decision.knowledgeOffset ?? null,
      procedure_id: decision.procedureId ?? null, procedure_name: decision.procedureName ?? null,
      evidence_ids: decision.evidenceIds ?? null,
      reason: decision.reason ?? null, based_on_revision: decision.basedOnRevision });
    const check = () => {
      if (ticket && !this.spatial!.matches(ticket)) throw new Error('task_replan:spatial_context_changed');
      if (this.stopped || token !== this.epoch) throw new Error('task_replan:cancelled');
      if (taskDimension == null) throw new Error('task_replan:dimension_unavailable');
      if (this.memory.getWorldId() !== taskWorldId || normalizeMemoryDimension(this.bot.game.dimension) !== taskDimension) {
        throw new Error('task_replan:spatial_context_changed');
      }
    };
    try {
      check(); let detail: string;
      switch (decision.task) {
        case 'EXECUTE_AFFORDANCE': {
          const state = this.semantic.capture(this.snapshot());
          const action = state.capabilities.actions.find(a => a.id === decision.capabilityId);
          if (!action) throw new Error('affordance_unavailable');
          detail = (await this.operate(affordanceOperation(action), check)).detail;
          break;
        }
        case 'EXECUTE_OPERATION': detail = (await this.operate(parseOperation(decision.operation), check)).detail; break;
        case 'LOOKUP_KNOWLEDGE': {
          this.semantic.lookupKnowledge(decision.knowledgeQuery ?? '', decision.knowledgeOffset ?? 0);
          detail = 'knowledge_query_completed'; break;
        }
        case 'SAVE_PROCEDURE': {
          const procedure = this.experience.save(decision.procedureName ?? '', decision.evidenceIds ?? []);
          detail = `procedure_saved:${procedure.id}:${procedure.status}`;
          this.log('procedure_saved', { task_id: this.current.id, procedure_id: procedure.id,
            procedure_name: procedure.name, procedure_status: procedure.status,
            evidence_ids: procedure.evidenceIds, source: decision.source,
            based_on_revision: decision.basedOnRevision });
          break;
        }
        case 'RUN_PROCEDURE': {
          const procedure = this.experience.get(decision.procedureId ?? '');
          if (!procedure) throw new Error('procedure_not_found');
          if (!procedureEnvironmentMatches(procedure, this.bot.version, this.bot.game.dimension)) throw new Error('procedure_environment_mismatch');
          const anchor = this.bot.entity.position.floored(), bindings = new Map<string, number>();
          const deadline = Date.now() + 60000, startedGoal = this.shared.get().currentGoal;
          try {
            for (const [stepIndex, step] of procedure.steps.entries()) {
              check();
              if (this.shared.get().currentGoal !== startedGoal || Date.now() >= deadline) throw new Error('task_replan:procedure_boundary_changed');
              const op = bindProcedureStep(step, this.bot, anchor, bindings);
              this.log('procedure_step_bound', { task_id: this.current.id, procedure_id: procedure.id,
                step_index: stepIndex, operation: op, world_id: taskWorldId, dimension: taskDimension,
                evidence_id: procedure.evidenceIds[stepIndex] ?? null });
              const outcome = await this.operate(op, check, Math.max(100, deadline - Date.now()));
              // Missing confirmation calls for re-observation/replanning, not
              // a false failure of this skill or blind execution of its next step.
              if (!outcome.verified) throw new Error('task_replan:procedure_step_effect_unconfirmed');
              completeProcedureStepBinding(step, this.bot, bindings);
            }
            check();
            this.experience.recordReplay(procedure.id, true);
          } catch (error) {
            if (error instanceof ProcedureBindingError) {
              this.log('procedure_rebind_required', { task_id: this.current.id, procedure_id: procedure.id, reason: error.message });
              throw new Error(`task_replan:${error.message}`);
            }
            if (!(error instanceof Error && error.message.startsWith('task_replan:'))) this.experience.recordReplay(procedure.id, false);
            throw error;
          }
          detail = `procedure_replayed:${procedure.id}`; break;
        }
        case 'WAIT': detail = (await this.operate({ action: 'WAIT', durationMs: 3000, until: 'timeout' }, check)).detail; break;
        default: throw new Error('unsupported_executive_task');
      }
      check(); this.finish('succeeded', detail); return { status: 'succeeded', detail };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = detail.startsWith('task_replan:') || this.stopped || token !== this.epoch ? 'interrupted' : 'failed';
      if (token === this.epoch) this.finish(status, detail);
      return { status, detail };
    }
  }
  /** Temporary interruption, unlike stop(): destination work may start once ready. */
  interruptSpatialTransition(reason: string): void {
    this.epoch++;
    this.primitive.stop();
    if (this.current.status === 'running') this.finish('interrupted', `spatial_transition:${reason}`);
  }
  stop(): void {
    this.stopped = true; this.epoch++; this.primitive.stop();
    if (this.current.status === 'running') this.finish('interrupted', 'runtime_stop');
  }
  private async operate(op: PrimitiveOperation, check: () => void, timeout = 70000): Promise<{ detail: string; verified: boolean }> {
    check();
    const taskId = this.current.id, operationEpoch = this.epoch;
    const ticket = this.spatial?.ticket();
    const before = observation(this.bot, op);
    const win = windowSnapshot(this.bot);
    const origin = { x: this.bot.entity.position.x, y: this.bot.entity.position.y, z: this.bot.entity.position.z };
    const blockName = op.position ? this.bot.blockAt(new Vec3(op.position.x, op.position.y, op.position.z))?.name : undefined;
    const entityName = op.entityId != null ? this.bot.entities[op.entityId]?.name : undefined;
    const worldId = this.memory.getWorldId();
    const dimension = String(this.bot.game.dimension), version = this.bot.version;
    const contextChanged = () => (ticket != null && !this.spatial!.matches(ticket)) || this.memory.getWorldId() !== worldId ||
      normalizeMemoryDimension(this.bot.game.dimension) !== normalizeMemoryDimension(dimension);
    let hurt = false;
    const hurtListener = (entity: any) => {
      if (!contextChanged() && operationEpoch === this.epoch && entity.id === op.entityId) hurt = true;
    };
    this.bot.on('entityHurt', hurtListener);
    this.current.detail = op.action === 'WAIT' ? 'waiting_for_condition' : `operation:${op.action}`;
    this.current.progress = { operation: op.action, condition: op.until ?? null };
    let status: 'succeeded' | 'failed' | 'interrupted' = 'failed', detail = '', verified = false;
    let assessment: EffectAssessment = { verified: false, outcome: 'effect_unconfirmed', reason: 'not_assessed' };
    try {
      const result = await this.primitive.runAndWait({ action: 'OPERATE', operation: op,
        confidence: 1, source: 'task', reason: `operation:${op.action}` }, this.sensor.capture(this.primitive.snapshot()), 'normal', timeout);
      check();
      if (result.action !== 'OPERATE' || result.status === 'interrupted') throw new Error(`task_replan:operation_interrupted:${result.detail}`);
      if (result.status !== 'succeeded') throw new Error(`operation_failed:${result.detail}`);
      const after = observation(this.bot, op);
      assessment = assessOperationEffect(op, before, after, hurt, result.detail);
      verified = assessment.verified;
      status = 'succeeded'; detail = `${op.action}:${result.detail}:${assessment.outcome}`;
      if (verified && op.action === 'PLACE' && op.position && op.item) {
        this.memory.observe({ kind: 'placed_block', key: `${op.position.x}:${op.position.y}:${op.position.z}`, label: op.item,
          position: op.position, dimension, scope: 'world', retention: 'stable', confidence: 1, metadata: { source: 'verified_self_action' } });
      }
      if (verified && op.action === 'BREAK' && op.position) this.memory.markContradictedNear(op.position, 0.1, ['placed_block'], 1, dimension);
      return { detail, verified };
    } catch (error) {
      detail = contextChanged() ? 'task_replan:spatial_context_changed' : error instanceof Error ? error.message : String(error);
      status = detail.startsWith('task_replan:') ? 'interrupted' : 'failed';
      verified = false;
      throw new Error(detail);
    } finally {
      this.bot.removeListener('entityHurt', hurtListener);
      // Do not read the new world's blocks or even its incomplete inventory in
      // an old operation's finalizer. Preserve the original task ID as well.
      const changed = contextChanged();
      const obsolete = changed || this.stopped || operationEpoch !== this.epoch;
      let effect: string;
      if (obsolete) {
        status = 'interrupted'; verified = false;
        effect = JSON.stringify({ outcome: 'interrupted', contextChanged: changed, interrupted: true,
          sourceWorldId: worldId, sourceDimension: dimension, sourceEpoch: ticket?.epoch ?? null,
          destinationWorldId: this.memory.getWorldId(), destinationDimension: String(this.bot.game?.dimension) });
      } else {
        const after = observation(this.bot, op);
        effect = JSON.stringify({ outcome: status === 'succeeded' ? assessment.outcome : status,
          assessmentReason: status === 'succeeded' ? assessment.reason : detail,
          hp: after.hp - before.hp, hunger: after.hunger - before.hunger,
          inventoryBefore: before.inventory, inventoryAfter: after.inventory,
          blockBefore: before.block, blockAfter: after.block, targetHurtObserved: hurt,
          targetEntityBefore: before.entityIdentity, targetEntityAfter: after.entityIdentity,
          targetMetadataBefore: before.entityMetadata, targetMetadataAfter: after.entityMetadata,
          windowChanged: before.window !== after.window });
      }
      const evidence = this.experience.append({ worldId, version, dimension,
        operation: op, status, verified, detail, effect, origin, blockName, entityName, window: win });
      this.log('operation_evidence', { task_id: taskId, evidence_id: evidence.id,
        experience_session_id: evidence.sessionId, evidence_sequence: evidence.sequence,
        world_id: worldId, minecraft_version: version, dimension, spatial_epoch: ticket?.epoch ?? null,
        operation: op, status, effect_verified: verified, detail, effect });
      // Keep every unconfirmed/timeout/interrupted trace above, but do not
      // contaminate success/failure statistics with missing evidence. Historical
      // records are never rewritten or silently reclassified by this change.
      if (status === 'failed' || (status === 'succeeded' && verified)) this.memory.recordProcedureOutcome({
        key: [version, dimension, op.action, op.item ?? '', blockName ?? '', entityName ?? ''].join('|'),
        label: `${op.action} ${op.item ?? blockName ?? entityName ?? ''}`.trim(),
        success: status === 'succeeded' && verified,
        detail: status === 'succeeded' ? assessment.outcome : 'operation_failed',
        metadata: { action: op.action, item: op.item ?? null, evidenceId: evidence.id, observedEffect: effect.slice(0, 2000) },
      });
    }
  }
  private finish(status: 'succeeded' | 'failed' | 'interrupted', detail: string): void {
    this.current = { ...this.current, status, detail, updatedAt: Date.now() };
    this.log(`task_${status}`, { task_id: this.current.id, task: this.current.task, detail,
      duration_ms: Date.now() - (this.current.startedAt ?? Date.now()) });
    this.shared.pushEvent({ type: `task_${status}`, detail: `${this.current.task}: ${detail}`, importance: status === 'failed' ? 'high' : 'medium' });
  }
  private log(kind: string, payload: Record<string, unknown>): void { console.log(JSON.stringify({ ts: new Date().toISOString(), kind, ...payload })); }
}

function affordanceOperation(a: ExecutiveActionCapability): PrimitiveOperation {
  switch (a.kind) {
    case 'move_to': case 'collect_drop': return parseOperation({ action: 'MOVE', position: a.position });
    case 'break_block': return parseOperation({ action: 'BREAK', position: a.position });
    case 'attack_entity': return parseOperation({ action: 'ATTACK', entityId: Number(a.entityTargetId?.split(':')[1]) });
    case 'use_item': return parseOperation({ action: 'USE', item: a.item });
    case 'place_item': return parseOperation({ action: 'PLACE', item: a.item, position: a.position });
    case 'craft_recipe': return parseOperation({ action: 'CRAFT', item: a.item });
    case 'interact_block': return parseOperation({ action: 'INTERACT_BLOCK', position: a.position });
    case 'wait_condition': return parseOperation({ action: 'WAIT', durationMs: 60000, until: a.specification.condition });
    default: throw new Error('affordance_requires_explicit_open_and_transfer');
  }
}
