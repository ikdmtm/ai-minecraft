import { ExperienceMemory } from './experienceMemory.js';
import { resolveGameplayWorldIdentity, advanceGameplayWorldIdentity, type GameplayWorldIdentity } from './worldIdentity.js';
import mineflayer from 'mineflayer';
import { attachClientReadiness } from './clientReadiness.js';
import { SpatialRuntimeContext } from './spatialRuntimeContext.js';
import { pathfinder } from 'mineflayer-pathfinder';
import { SharedStateBus } from '../cognitive/sharedState.js';
import type { RecentEvent } from '../types/gameState.js';
import { WorldSensor } from './worldSensor.js';
import { SkillExecutor } from './skillExecutor.js';
import { SafetyKernel } from './safetyKernel.js';
import { StrategicPlanner } from './strategicPlanner.js';
import { SemanticWorldModel } from './semanticWorldModel.js';
import { ExecutivePolicy } from './executivePolicy.js';
import { TaskExecutor } from './taskExecutor.js';
import type { JevWorldState } from './typedActions.js';
import type { ExecutiveWorldState } from './executiveTypes.js';
import { WorldProvenance } from './worldProvenance.js';
import { WorldMemory } from './worldMemory.js';

export type LLMProvider = 'anthropic' | 'openai';

export interface CognitiveOrchestratorConfig {
  llmProvider?: LLMProvider;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  tacticalModel: string;
  strategicModel: string;
  mcHost: string;
  mcPort: number;
  botUsername: string;
  cameraPlayer: string;
  voicevoxHost: string;
  voicevoxSpeakerId: number;
  dbPath: string;
}

export interface CognitiveEvents {
  onCommentary: (text: string) => void;
  onDeath: (cause: string) => void;
  onGoalChanged: (goal: string) => void;
  onReactiveAction: (event: RecentEvent) => void;
}

export interface GameplayRuntimeSnapshot {
  timestamp: number;
  goal: string;
  reflexState: string;
  threatLevel: string;
  hp: number;
  hunger: number;
  position: { x: number; y: number; z: number };
  inventory: Record<string, number>;
}

export class CognitiveOrchestrator {
  private readonly shared = new SharedStateBus();
  private readonly provenance = new WorldProvenance();
  private readonly memory: WorldMemory;
  private readonly experience: ExperienceMemory;
  private worldIdentity: GameplayWorldIdentity;
  private bot: mineflayer.Bot | null = null;
  private sensor: WorldSensor | null = null;
  private primitive: SkillExecutor | null = null;
  private semantic: SemanticWorldModel | null = null;
  private taskExecutor: TaskExecutor | null = null;
  private safety: SafetyKernel | null = null;
  private executivePolicy: ExecutivePolicy | null = null;
  private planner: StrategicPlanner | null = null;
  private spatial: SpatialRuntimeContext | null = null;
  private detachReadiness: (() => void) | null = null;
  private executiveLoopPromise: Promise<void> | null = null;
  private running = false;
  private generation = 1;

  constructor(private readonly config: CognitiveOrchestratorConfig) {
    this.worldIdentity = resolveGameplayWorldIdentity(config);
    this.memory = new WorldMemory(config.dbPath, this.worldIdentity.memoryWorldId);
    this.experience = new ExperienceMemory(config.dbPath);
  }

  private refreshWorldIdentity(): void {
    const selected = resolveGameplayWorldIdentity(this.config);
    if (selected.memoryWorldId !== this.memory.getWorldId()) this.provenance.clear();
    this.memory.setWorldId(selected.memoryWorldId);
    this.worldIdentity = selected;
    console.log(JSON.stringify({
      ts: new Date().toISOString(), kind: 'world_identity_resolved',
      world_id: selected.memoryWorldId, server_id: selected.serverId,
      source: selected.source,
      spatial_restart_reusable: selected.source !== 'session_unconfirmed',
    }));
  }

  getShared(): SharedStateBus { return this.shared; }
  getGeneration(): number { return this.generation; }
  isRunning(): boolean { return this.running; }

  getBotForDebug(): mineflayer.Bot {
    if (!this.bot) throw new Error('Bot is not connected');
    return this.bot;
  }

  getGameplaySnapshot(): GameplayRuntimeSnapshot | null {
    if (!this.bot || !this.spatial?.isReady()) return null;
    const inventory: Record<string, number> = {};
    for (const item of this.bot.inventory.items()) inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
    const state = this.shared.get();
    return {
      timestamp: Date.now(), goal: state.currentGoal, reflexState: state.reflexState,
      threatLevel: state.threatLevel, hp: this.bot.health, hunger: this.bot.food,
      position: { x: this.bot.entity.position.x, y: this.bot.entity.position.y, z: this.bot.entity.position.z },
      inventory,
    };
  }

  getJevWorldState(): JevWorldState | null {
    if (!this.sensor || !this.primitive || !this.spatial?.isReady()) return null;
    return this.sensor.capture(this.primitive.snapshot());
  }

  getExecutiveWorldState(): ExecutiveWorldState | null {
    if (!this.semantic || !this.taskExecutor || !this.spatial?.isReady()) return null;
    return this.semantic.capture(this.taskExecutor.snapshot());
  }

  private attachSpatialContext(bot: mineflayer.Bot): SpatialRuntimeContext {
    const spatial = new SpatialRuntimeContext(bot, () => this.memory.getWorldId(), {
      invalidate: reason => {
        if (this.spatial !== spatial) return;
        this.safety?.stop();
        this.planner?.stop();
        this.taskExecutor?.interruptSpatialTransition(reason);
        this.primitive?.stop();
        this.provenance.clear();
        // Spatial plans are transient; persistent experiences/procedures are not cleared.
        this.shared.setGoal('');
        this.shared.setSubGoals([]);
        try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch { /* old UI only */ }
        console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'spatial_transition',
          reason, spatial_epoch: spatial.getEpoch(), world_id: this.memory.getWorldId() }));
      },
      ready: () => {
        if (!this.running || this.spatial !== spatial || this.bot !== bot) return;
        this.safety?.start();
        this.planner?.start();
        console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'spatial_ready',
          spatial_epoch: spatial.getEpoch(), dimension: String(bot.game.dimension), world_id: this.memory.getWorldId() }));
      },
    });
    this.spatial = spatial;
    return spatial;
  }

  async start(events: CognitiveEvents): Promise<void> {
    if (this.running) return;
    if (!this.config.openaiApiKey) throw new Error('OPENAI_API_KEY is required for executive policy and strategic planning');
    this.refreshWorldIdentity();
    this.running = true;
    let ownedBot: mineflayer.Bot | null = null;
    try {
      const bot = mineflayer.createBot({
        host: this.config.mcHost, port: this.config.mcPort,
        username: this.config.botUsername, hideErrors: false,
      });
      ownedBot = bot;
      this.bot = bot;
      const spatial = this.attachSpatialContext(bot);
      this.detachReadiness = attachClientReadiness(bot);
      bot.loadPlugin(pathfinder);
      await spatial.waitUntilReady();
      if (!this.running || this.bot !== bot || this.spatial !== spatial) throw new Error('spatial_start_cancelled');

      const primitive = new SkillExecutor(bot, this.shared, this.provenance);
      const sensor = new WorldSensor(bot, this.shared, this.provenance);
      const semantic = new SemanticWorldModel(bot, this.shared, this.provenance, this.memory, this.experience);
      const task = new TaskExecutor(bot, this.shared, primitive, sensor, semantic, this.memory, this.experience, spatial);
      this.primitive = primitive;
      this.sensor = sensor;
      this.semantic = semantic;
      this.taskExecutor = task;
      this.safety = new SafetyKernel(bot, this.shared, primitive);
      this.executivePolicy = new ExecutivePolicy({
        typesafeApiKey: process.env.TYPESAFE_API_KEY?.trim(), openaiApiKey: this.config.openaiApiKey,
        provider: parsePolicyProvider(process.env.POLICY_PROVIDER),
        jevModel: process.env.JEV_MODEL?.trim() || 'jev-latest',
        openaiModel: process.env.OPENAI_POLICY_MODEL?.trim() || 'gpt-5.6-luna',
        typesafeBaseUrl: process.env.TYPESAFE_BASE_URL?.trim() || undefined,
        timeoutMs: parsePositiveInt(process.env.OPENAI_POLICY_TIMEOUT_MS, 8_000),
      });
      this.planner = new StrategicPlanner(this.shared, this.config.openaiApiKey, this.config.strategicModel,
        () => {
          spatial.ticket();
          return semantic.capture(task.snapshot());
        }, goal => events.onGoalChanged(goal), spatial);
      this.setupBotEvents(events);
      this.safety.start();
      this.planner.start();
      this.executiveLoopPromise = this.runExecutiveLoop();
      this.shared.pushEvent({ type: 'executive_runtime_started',
        detail: `provider=${this.executivePolicy.getProvider()} model=${this.executivePolicy.getModel()} mode=event_driven`,
        importance: 'medium' });
    } catch (error) {
      // An abandoned start must not tear down a newer connection.
      if (this.bot === ownedBot) this.stop();
      throw error;
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.spatial?.dispose();
    this.detachReadiness?.();
    this.detachReadiness = null;
    this.safety?.stop();
    this.planner?.stop();
    this.taskExecutor?.stop();
    this.primitive?.stop();
    try { this.bot?.pathfinder.stop(); } catch { /* best effort */ }
    try { this.bot?.quit(); } catch { /* best effort */ }
    this.bot = null;
    this.sensor = null;
    this.primitive = null;
    this.semantic = null;
    this.taskExecutor = null;
    this.safety = null;
    this.executivePolicy = null;
    this.planner = null;
    this.spatial = null;
    this.executiveLoopPromise = null;
  }

  destroy(): void {
    this.stop();
    // Connections stay available to in-flight operation finalizers until the process exits.
  }

  nextGeneration(): void {
    if (this.running) throw new Error('stop_runtime_before_changing_world');
    const selected = advanceGameplayWorldIdentity(this.config, this.worldIdentity);
    this.memory.setWorldId(selected.memoryWorldId);
    this.worldIdentity = selected;
    this.generation++;
    this.shared.reset(this.generation);
    this.provenance.clear();
    this.shared.pushEvent({ type: 'memory_world_rotated',
      detail: `generation=${this.generation} world_id=${selected.memoryWorldId} global_memory=preserved`, importance: 'medium' });
  }

  saveEpisode(deathCause: string): void {
    this.shared.pushEvent({ type: 'episode_ended',
      detail: `generation=${this.generation} cause=${deathCause} survival_minutes=${this.shared.getSurvivalMinutes().toFixed(1)}`,
      importance: 'high' });
  }

  private async runExecutiveLoop(): Promise<void> {
    // Capture ownership once. An old pending policy response can never use the
    // new connection's task executor even if running becomes true again.
    const semantic = this.semantic, task = this.taskExecutor, policy = this.executivePolicy, spatial = this.spatial;
    if (!semantic || !task || !policy || !spatial) return;
    const owner = () => this.running && this.spatial === spatial;
    while (owner()) {
      try {
        if (!spatial.isReady()) { await delay(100); continue; }
        const ticket = spatial.ticket();
        const before = semantic.capture(task.snapshot());
        const decision = await policy.decide(before);
        if (!owner()) break;
        if (!spatial.matches(ticket)) {
          console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'executive_stale_decision',
            reason: 'spatial_transition', spatial_epoch: ticket.epoch, current_epoch: spatial.getEpoch() }));
          continue;
        }
        const afterThink = semantic.capture(task.snapshot());
        if (decision.basedOnRevision !== afterThink.revision) {
          console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'executive_stale_decision',
            based_on_revision: decision.basedOnRevision, current_revision: afterThink.revision,
            task: decision.task, target_id: decision.targetId ?? null }));
          await delay(50); continue;
        }
        this.shared.markTacticalUpdate();
        const result = await task.execute(decision);
        console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'executive_task_result',
          task: decision.task, target_id: decision.targetId ?? null, status: result.status, detail: result.detail }));
      } catch (error) {
        if (owner()) console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'executive_loop_error',
          message: error instanceof Error ? error.message : String(error) }));
      }
      await delay(100);
    }
  }

  private setupBotEvents(events: CognitiveEvents): void {
    const bot = this.bot!;
    const sourceWorldId = this.memory.getWorldId();
    const current = () => this.running && this.bot === bot;
    bot.on('death', () => {
      if (!current()) return;
      this.memory.observe({ kind: 'life_event', key: `death:${sourceWorldId}`,
        label: 'A previous life ended', scope: 'global', retention: 'stable', confidence: 1,
        metadata: { sourceWorldId, cause: 'unknown', recentOperation: this.taskExecutor?.snapshot().detail ?? '' } });
      this.shared.pushEvent({ type: 'death', detail: 'mineflayer death event', importance: 'critical' });
      events.onDeath('mineflayer death event');
    });
    bot.on('entityHurt', entity => {
      if (!current() || !this.spatial?.isReady() || entity !== bot.entity) return;
      this.shared.pushEvent({ type: 'took_damage', detail: `hp=${bot.health}`,
        importance: bot.health <= 8 ? 'critical' : 'high' });
    });
    bot.on('playerCollect', (collector, collected) => {
      if (!current() || !this.spatial?.isReady() || collector !== bot.entity) return;
      this.shared.pushEvent({ type: 'collected_item', detail: collected?.name ?? 'item', importance: 'low' });
    });
    bot.on('end', () => { if (current()) this.stop(); });
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function parsePolicyProvider(raw: string | undefined): 'auto' | 'jev' | 'openai' {
  const value = raw?.trim().toLowerCase();
  if (value === 'jev' || value === 'openai') return value;
  return 'auto';
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
