import Database from 'better-sqlite3';
import { SharedStateBus } from './sharedState.js';
import { ReflexLayer, type ReflexLayerEvents } from './reflexLayer.js';
import { TacticalLayer, type TacticalLayerEvents } from './tacticalLayer.js';
import { StrategicLayer, type StrategicLayerDeps } from './strategicLayer.js';
import { SkillLibrary } from './skillLibrary.js';
import { EpisodicMemory } from './memory.js';
import type { LLMApiAdapter } from '../llm/client.js';
import type { RecentEvent } from '../types/gameState.js';

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
  private shared: SharedStateBus;
  private reflexLayer: ReflexLayer;
  private tacticalLayer: TacticalLayer | null = null;
  private strategicLayer: StrategicLayer | null = null;
  private skillLibrary: SkillLibrary;
  private memory: EpisodicMemory;
  private config: CognitiveOrchestratorConfig;
  private db: Database.Database;
  private running = false;
  private generation = 1;

  constructor(config: CognitiveOrchestratorConfig) {
    this.config = config;
    this.shared = new SharedStateBus();
    this.db = new Database(config.dbPath);
    this.skillLibrary = new SkillLibrary(this.db);
    this.memory = new EpisodicMemory(this.db);
    this.reflexLayer = new ReflexLayer(this.shared);
  }

  getShared(): SharedStateBus {
    return this.shared;
  }

  getMemory(): EpisodicMemory {
    return this.memory;
  }

  getSkillLibrary(): SkillLibrary {
    return this.skillLibrary;
  }

  getBotForDebug() {
    return this.reflexLayer.getBot();
  }

  isRunning(): boolean {
    return this.running;
  }

  getGeneration(): number {
    return this.generation;
  }

  getGameplaySnapshot(): GameplayRuntimeSnapshot | null {
    try {
      const state = this.shared.get();
      const partial = this.reflexLayer.getPartialGameState();
      const bot = this.reflexLayer.getBot();
      const inventory: Record<string, number> = {};

      for (const item of bot.inventory.items()) {
        inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
      }

      return {
        timestamp: Date.now(),
        goal: state.currentGoal,
        reflexState: state.reflexState,
        threatLevel: state.threatLevel,
        hp: partial.player.hp,
        hunger: partial.player.hunger,
        position: { ...partial.player.position },
        inventory,
      };
    } catch {
      return null;
    }
  }

  async start(events: CognitiveEvents): Promise<void> {
    if (this.running) return;
    this.running = true;

    const reflexEvents: ReflexLayerEvents = {
      onDeath: (cause) => {
        this.shared.pushEvent({ type: 'death', detail: cause, importance: 'critical' });
        events.onDeath(cause);
      },
      onReactiveAction: (event) => {
        events.onReactiveAction(event);
      },
      onStateChange: (from, to) => {
        this.shared.pushEvent({
          type: 'reflex_state_change',
          detail: `${from} → ${to}`,
          importance: 'low',
        });
      },
    };

    await this.reflexLayer.connect(
      { host: this.config.mcHost, port: this.config.mcPort, username: this.config.botUsername },
      reflexEvents,
    );

    if (this.config.cameraPlayer) {
      this.reflexLayer.setupSpectator(this.config.cameraPlayer);
    }

    const tacticalAdapter = this.createAdapter(this.config.tacticalModel, 512);
    const tacticalEvents: TacticalLayerEvents = {
      onCommentary: (text) => events.onCommentary(text),
      onGoalAdjusted: (goal) => events.onGoalChanged(goal),
    };
    this.tacticalLayer = new TacticalLayer(
      tacticalAdapter, this.shared, this.reflexLayer, tacticalEvents,
    );
    this.tacticalLayer.start();

    const strategicAdapter = this.createAdapter(this.config.strategicModel, 1024);
    const strategicDeps: StrategicLayerDeps = {
      adapter: strategicAdapter,
      shared: this.shared,
      getSensors: () => this.reflexLayer.getSensors(),
      getInventorySummary: () => {
        try {
          const bot = this.reflexLayer.getBot();
          return bot.inventory.items().map(i => `${i.name} x${i.count}`);
        } catch { return []; }
      },
      getDeathHistory: () => this.memory.getRecentEpisodes(5).map(ep => ({
        generation: ep.generation,
        survivalMinutes: ep.survivalMinutes,
        cause: ep.deathCause,
        lesson: ep.lessons.join('; '),
      })),
      getSkillSummaries: () => this.skillLibrary.getSummaries(),
      onGoalSet: (goal) => events.onGoalChanged(goal),
      onSubGoalsSet: () => {},
    };
    this.strategicLayer = new StrategicLayer(strategicDeps);
    this.strategicLayer.start();
  }

  stop(): void {
    this.running = false;
    this.tacticalLayer?.stop();
    this.tacticalLayer = null;
    this.strategicLayer?.stop();
    this.strategicLayer = null;
    this.reflexLayer.disconnect();
  }

  nextGeneration(): void {
    this.generation++;
    this.shared.reset(this.generation);
  }

  saveEpisode(deathCause: string): void {
    const state = this.shared.get();
    this.memory.saveEpisode({
      generation: this.generation,
      survivalMinutes: this.shared.getSurvivalMinutes(),
      deathCause,
      lessons: state.lessonsThisLife,
      achievements: [],
      emotionalSummary: this.shared.getEmotionLabel(),
    });
  }

  destroy(): void {
    this.stop();
    this.db.close();
  }

  private createAdapter(model: string, maxTokens: number): LLMApiAdapter {
    const provider = this.config.llmProvider ?? 'anthropic';
    if (provider === 'openai') {
      return createOpenAIAdapter(this.config.openaiApiKey, model, maxTokens);
    }
    return createAnthropicAdapter(this.config.anthropicApiKey, model, maxTokens);
  }
}

function createAnthropicAdapter(
  apiKey: string | undefined,
  model: string,
  maxTokens: number,
): LLMApiAdapter {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic');

  return {
    async call(systemPrompt: string, userMessage: string): Promise<string> {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${body}`);
      }
      const data = (await res.json()) as any;
      return data.content?.[0]?.text ?? '';
    },
  };
}

function createOpenAIAdapter(
  apiKey: string | undefined,
  model: string,
  maxTokens: number,
): LLMApiAdapter {
  if (!apiKey) throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai');

  return {
    async call(systemPrompt: string, userMessage: string): Promise<string> {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          instructions: systemPrompt,
          input: userMessage,
          max_output_tokens: maxTokens,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI API ${res.status}: ${body}`);
      }

      const data = (await res.json()) as any;
      const direct = typeof data.output_text === 'string' ? data.output_text.trim() : '';
      if (direct) return direct;

      const parts: string[] = [];
      for (const item of Array.isArray(data.output) ? data.output : []) {
        for (const content of Array.isArray(item?.content) ? item.content : []) {
          if (content?.type === 'output_text' && typeof content.text === 'string') {
            parts.push(content.text);
          }
        }
      }
      return parts.join('\n').trim();
    },
  };
}
