import mineflayer from 'mineflayer';
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
  private bot: mineflayer.Bot | null = null;
  private sensor: WorldSensor | null = null;
  private primitive: SkillExecutor | null = null;
  private semantic: SemanticWorldModel | null = null;
  private taskExecutor: TaskExecutor | null = null;
  private safety: SafetyKernel | null = null;
  private executivePolicy: ExecutivePolicy | null = null;
  private planner: StrategicPlanner | null = null;
  private executiveLoopPromise: Promise<void> | null = null;
  private running = false;
  private generation = 1;

  constructor(private readonly config: CognitiveOrchestratorConfig) {
    this.memory = new WorldMemory(config.dbPath);
  }

  getShared(): SharedStateBus {
    return this.shared;
  }

  getGeneration(): number {
    return this.generation;
  }

  isRunning(): boolean {
    return this.running;
  }

  getBotForDebug(): mineflayer.Bot {
    if (!this.bot) throw new Error('Bot is not connected');
    return this.bot;
  }

  getGameplaySnapshot(): GameplayRuntimeSnapshot | null {
    if (!this.bot) return null;
    const inventory: Record<string, number> = {};
    for (const item of this.bot.inventory.items()) {
      inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
    }
    const state = this.shared.get();
    return {
      timestamp: Date.now(),
      goal: state.currentGoal,
      reflexState: state.reflexState,
      threatLevel: state.threatLevel,
      hp: this.bot.health,
      hunger: this.bot.food,
      position: {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
      },
      inventory,
    };
  }

  getJevWorldState(): JevWorldState | null {
    if (!this.sensor || !this.primitive) return null;
    return this.sensor.capture(this.primitive.snapshot());
  }

  getExecutiveWorldState(): ExecutiveWorldState | null {
    if (!this.semantic || !this.taskExecutor) return null;
    return this.semantic.capture(this.taskExecutor.snapshot());
  }

  async start(events: CognitiveEvents): Promise<void> {
    if (this.running) return;
    this.running = true;

    const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!this.config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is required for executive policy and strategic planning');
    }

    this.bot = mineflayer.createBot({
      host: this.config.mcHost,
      port: this.config.mcPort,
      username: this.config.botUsername,
      hideErrors: false,
    });
    this.bot.loadPlugin(pathfinder);
    await waitForSpawn(this.bot);

    this.primitive = new SkillExecutor(this.bot, this.shared, this.provenance);
    this.sensor = new WorldSensor(this.bot, this.shared, this.provenance);
    this.semantic = new SemanticWorldModel(this.bot, this.shared, this.provenance, this.memory);
    this.taskExecutor = new TaskExecutor(
      this.bot,
      this.shared,
      this.primitive,
      this.sensor,
      this.semantic,
    );
    this.safety = new SafetyKernel(this.bot, this.shared, this.primitive);
    this.executivePolicy = new ExecutivePolicy({
      typesafeApiKey,
      openaiApiKey: this.config.openaiApiKey,
      provider: parsePolicyProvider(process.env.POLICY_PROVIDER),
      jevModel: process.env.JEV_MODEL?.trim() || 'jev-latest',
      openaiModel: process.env.OPENAI_POLICY_MODEL?.trim() || 'gpt-5.6-luna',
      typesafeBaseUrl: process.env.TYPESAFE_BASE_URL?.trim() || undefined,
      timeoutMs: parsePositiveInt(process.env.OPENAI_POLICY_TIMEOUT_MS, 8_000),
    });
    this.planner = new StrategicPlanner(
      this.shared,
      this.config.openaiApiKey,
      this.config.strategicModel,
      () => this.semantic!.capture(this.taskExecutor!.snapshot()),
      goal => events.onGoalChanged(goal),
    );

    this.setupBotEvents(events);
    this.safety.start();
    this.planner.start();
    this.executiveLoopPromise = this.runExecutiveLoop();

    this.shared.pushEvent({
      type: 'executive_runtime_started',
      detail: `provider=${this.executivePolicy.getProvider()} model=${this.executivePolicy.getModel()} mode=event_driven`,
      importance: 'medium',
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
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
    this.executiveLoopPromise = null;
  }

  destroy(): void {
    this.stop();
  }

  nextGeneration(): void {
    this.generation++;
    this.shared.reset(this.generation);
    const worldId = this.memory.startNewWorld();
    this.shared.pushEvent({
      type: 'memory_world_rotated',
      detail: `generation=${this.generation} world_id=${worldId} global_memory=preserved`,
      importance: 'medium',
    });
  }

  saveEpisode(deathCause: string): void {
    this.shared.pushEvent({
      type: 'episode_ended',
      detail: `generation=${this.generation} cause=${deathCause} survival_minutes=${this.shared.getSurvivalMinutes().toFixed(1)}`,
      importance: 'high',
    });
  }

  private async runExecutiveLoop(): Promise<void> {
    while (this.running) {
      try {
        if (!this.semantic || !this.taskExecutor || !this.executivePolicy) break;

        // Policy is invoked only at task boundaries. This is intentionally
        // event-driven: no 400ms micromanagement while a task is in flight.
        const before = this.semantic.capture(this.taskExecutor.snapshot());
        const decision = await this.executivePolicy.decide(before);
        if (!this.running) break;

        // Re-capture meaningful state before executing. If inventory, safety
        // context, strategy, or task state changed while the model was thinking,
        // discard the stale answer instead of acting on an old world.
        const afterThink = this.semantic.capture(this.taskExecutor.snapshot());
        if (decision.basedOnRevision !== afterThink.revision) {
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            kind: 'executive_stale_decision',
            based_on_revision: decision.basedOnRevision,
            current_revision: afterThink.revision,
            task: decision.task,
            target_id: decision.targetId ?? null,
          }));
          await delay(50);
          continue;
        }

        this.shared.markTacticalUpdate();
        const result = await this.taskExecutor.execute(decision);
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'executive_task_result',
          task: decision.task,
          target_id: decision.targetId ?? null,
          status: result.status,
          detail: result.detail,
        }));
      } catch (error) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'executive_loop_error',
          message: error instanceof Error ? error.message : String(error),
        }));
      }

      await delay(100);
    }
  }

  private setupBotEvents(events: CognitiveEvents): void {
    const bot = this.bot!;
    bot.on('death', () => {
      this.shared.pushEvent({ type: 'death', detail: 'mineflayer death event', importance: 'critical' });
      events.onDeath('mineflayer death event');
    });
    bot.on('entityHurt', entity => {
      if (entity !== bot.entity) return;
      this.shared.pushEvent({
        type: 'took_damage',
        detail: `hp=${bot.health}`,
        importance: bot.health <= 8 ? 'critical' : 'high',
      });
    });
    bot.on('playerCollect', (collector, collected) => {
      if (collector !== bot.entity) return;
      this.shared.pushEvent({
        type: 'collected_item',
        detail: collected?.name ?? 'item',
        importance: 'low',
      });
    });
  }
}

function waitForSpawn(bot: mineflayer.Bot): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      bot.removeListener('spawn', onSpawn);
      bot.removeListener('error', onError);
    };
    bot.once('spawn', onSpawn);
    bot.once('error', onError);
  });
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
