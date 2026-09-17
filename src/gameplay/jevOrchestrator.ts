import mineflayer from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { SharedStateBus } from '../cognitive/sharedState.js';
import type { RecentEvent } from '../types/gameState.js';
import { WorldSensor } from './worldSensor.js';
import { SkillExecutor } from './skillExecutor.js';
import { SafetyKernel } from './safetyKernel.js';
import { JevPolicy } from './jevPolicy.js';
import { StrategicPlanner } from './strategicPlanner.js';
import type { JevWorldState } from './typedActions.js';

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
  private bot: mineflayer.Bot | null = null;
  private sensor: WorldSensor | null = null;
  private executor: SkillExecutor | null = null;
  private safety: SafetyKernel | null = null;
  private policy: JevPolicy | null = null;
  private planner: StrategicPlanner | null = null;
  private policyLoopPromise: Promise<void> | null = null;
  private running = false;
  private generation = 1;

  constructor(private readonly config: CognitiveOrchestratorConfig) {}

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
    if (!this.sensor || !this.executor) return null;
    return this.sensor.capture(this.executor.snapshot());
  }

  async start(events: CognitiveEvents): Promise<void> {
    if (this.running) return;
    this.running = true;

    const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!typesafeApiKey) throw new Error('TYPESAFE_API_KEY is required for Jev gameplay mode');
    if (!this.config.openaiApiKey) throw new Error('OPENAI_API_KEY is required for strategic planning');

    this.bot = mineflayer.createBot({
      host: this.config.mcHost,
      port: this.config.mcPort,
      username: this.config.botUsername,
      hideErrors: false,
    });
    this.bot.loadPlugin(pathfinder);

    await waitForSpawn(this.bot);

    this.executor = new SkillExecutor(this.bot, this.shared);
    this.sensor = new WorldSensor(this.bot, this.shared);
    this.safety = new SafetyKernel(this.bot, this.shared, this.executor);
    this.policy = new JevPolicy({
      apiKey: typesafeApiKey,
      model: process.env.JEV_MODEL?.trim() || 'jev-latest',
      baseUrl: process.env.TYPESAFE_BASE_URL?.trim() || undefined,
      confidenceFloor: parseNumber(process.env.JEV_CONFIDENCE_FLOOR, 0.2),
      timeoutMs: parsePositiveInt(process.env.JEV_TIMEOUT_MS, 3_000),
    });
    this.planner = new StrategicPlanner(
      this.shared,
      this.config.openaiApiKey,
      this.config.strategicModel,
      () => this.sensor!.capture(this.executor!.snapshot()),
      goal => events.onGoalChanged(goal),
    );

    this.setupBotEvents(events);
    this.safety.start();
    this.planner.start();
    this.policyLoopPromise = this.runPolicyLoop();

    this.shared.pushEvent({
      type: 'jev_runtime_started',
      detail: `model=${process.env.JEV_MODEL?.trim() || 'jev-latest'} interval_ms=${parsePositiveInt(process.env.JEV_INTERVAL_MS, 400)}`,
      importance: 'medium',
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.safety?.stop();
    this.planner?.stop();
    this.executor?.stop();
    try { this.bot?.pathfinder.stop(); } catch { /* best effort */ }
    try { this.bot?.quit(); } catch { /* best effort */ }
    this.bot = null;
    this.sensor = null;
    this.executor = null;
    this.safety = null;
    this.policy = null;
    this.planner = null;
    this.policyLoopPromise = null;
  }

  destroy(): void {
    this.stop();
  }

  nextGeneration(): void {
    this.generation++;
    this.shared.reset(this.generation);
  }

  saveEpisode(deathCause: string): void {
    this.shared.pushEvent({
      type: 'episode_ended',
      detail: `generation=${this.generation} cause=${deathCause} survival_minutes=${this.shared.getSurvivalMinutes().toFixed(1)}`,
      importance: 'high',
    });
  }

  private async runPolicyLoop(): Promise<void> {
    const intervalMs = parsePositiveInt(process.env.JEV_INTERVAL_MS, 400);
    while (this.running) {
      const started = Date.now();
      try {
        if (!this.sensor || !this.executor || !this.policy) break;
        const state = this.sensor.capture(this.executor.snapshot());
        const decision = await this.policy.decide(state);
        if (!this.running) break;
        this.shared.markTacticalUpdate();
        this.executor.dispatch(decision, state, 'normal');
      } catch (error) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'jev_loop_error',
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      const elapsed = Date.now() - started;
      await delay(Math.max(25, intervalMs - elapsed));
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

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
