import { config as loadEnv } from 'dotenv';
loadEnv();

import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { CognitiveOrchestrator, type LLMProvider } from './cognitive/orchestrator.js';
import { GameplayProgressMonitor } from './gameplay/progressMonitor.js';

const DEFAULT_PROVIDER: LLMProvider = 'openai';
const DEFAULT_OPENAI_TACTICAL_MODEL = 'gpt-5.6-luna';
const DEFAULT_OPENAI_STRATEGIC_MODEL = 'gpt-5.6-terra';
const DEFAULT_ANTHROPIC_TACTICAL_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_ANTHROPIC_STRATEGIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_STATUS_INTERVAL_MS = 2_000;
const DEFAULT_STALL_THRESHOLD_MS = 20_000;
const DEFAULT_STALL_ALERT_COOLDOWN_MS = 15_000;
const DEFAULT_VIEWER_PORT = 3007;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in gameplay mode`);
  return value;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envEnabled(name: string, fallback = true): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function resolveProvider(): LLMProvider {
  const raw = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (!raw) return DEFAULT_PROVIDER;
  if (raw === 'openai' || raw === 'anthropic') return raw;
  throw new Error(`Unsupported LLM_PROVIDER: ${raw}`);
}

const llmProvider = resolveProvider();
const defaultTacticalModel = llmProvider === 'openai'
  ? DEFAULT_OPENAI_TACTICAL_MODEL
  : DEFAULT_ANTHROPIC_TACTICAL_MODEL;
const defaultStrategicModel = llmProvider === 'openai'
  ? DEFAULT_OPENAI_STRATEGIC_MODEL
  : DEFAULT_ANTHROPIC_STRATEGIC_MODEL;

const dbPath = process.env.DB_PATH?.trim() || './data/gameplay.db';
mkdirSync(dirname(resolve(dbPath)), { recursive: true });

const orchestrator = new CognitiveOrchestrator({
  llmProvider,
  openaiApiKey: llmProvider === 'openai' ? requiredEnv('OPENAI_API_KEY') : undefined,
  anthropicApiKey: llmProvider === 'anthropic' ? requiredEnv('ANTHROPIC_API_KEY') : undefined,
  tacticalModel: process.env.TACTICAL_MODEL?.trim() || defaultTacticalModel,
  strategicModel: process.env.STRATEGIC_MODEL?.trim() || defaultStrategicModel,
  mcHost: process.env.MINECRAFT_HOST?.trim() || 'localhost',
  mcPort: parsePositiveInt(process.env.MINECRAFT_PORT, 25565),
  botUsername: process.env.BOT_USERNAME?.trim() || 'AI_Rei',
  cameraPlayer: '',
  voicevoxHost: '',
  voicevoxSpeakerId: 0,
  dbPath,
});

const statusIntervalMs = parsePositiveInt(
  process.env.GAMEPLAY_STATUS_INTERVAL_MS,
  DEFAULT_STATUS_INTERVAL_MS,
);

const progressMonitor = new GameplayProgressMonitor({
  stallThresholdMs: parsePositiveInt(
    process.env.GAMEPLAY_STALL_THRESHOLD_MS,
    DEFAULT_STALL_THRESHOLD_MS,
  ),
  alertCooldownMs: parsePositiveInt(
    process.env.GAMEPLAY_STALL_ALERT_COOLDOWN_MS,
    DEFAULT_STALL_ALERT_COOLDOWN_MS,
  ),
});

let statusTimer: ReturnType<typeof setInterval> | null = null;
let viewerClose: (() => void) | null = null;
let unsubscribeSharedEvents: (() => void) | null = null;
let detachBotDiagnostics: (() => void) | null = null;
let previousInventory: Record<string, number> | null = null;
let shuttingDown = false;

function logEvent(kind: string, payload: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    kind,
    ...payload,
  }));
}

function stopStatusTimer(): void {
  if (!statusTimer) return;
  clearInterval(statusTimer);
  statusTimer = null;
}

function stopViewer(): void {
  if (!viewerClose) return;
  try {
    viewerClose();
  } catch {
    // best effort
  }
  viewerClose = null;
}

function stopDiagnostics(): void {
  unsubscribeSharedEvents?.();
  unsubscribeSharedEvents = null;
  detachBotDiagnostics?.();
  detachBotDiagnostics = null;
}

function shutdown(reason: string, exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopStatusTimer();
  stopDiagnostics();
  stopViewer();
  logEvent('shutdown', { reason });

  try {
    orchestrator.destroy();
  } catch (error) {
    logEvent('shutdown_error', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  process.exitCode = exitCode;
}

function startSharedEventLogging(): void {
  const shared = orchestrator.getShared();
  unsubscribeSharedEvents = shared.onStateChange((field, value) => {
    if (field === 'recentEvents' && value && typeof value === 'object') {
      const event = value as {
        timestamp?: number;
        type?: string;
        detail?: string;
        importance?: string;
      };
      logEvent('game_event', {
        event_ts: event.timestamp ?? null,
        event_type: event.type ?? 'unknown',
        detail: event.detail ?? '',
        importance: event.importance ?? null,
      });
      return;
    }

    if (field === 'subGoals' && Array.isArray(value)) {
      logEvent('sub_goals_changed', { sub_goals: value });
      return;
    }

    if (field === 'worldModel.basePosition') {
      logEvent('base_position_changed', { position: value });
    }
  });
}

function attachRuntimeDiagnostics(): void {
  const bot = orchestrator.getBotForDebug() as any;
  const removers: Array<() => void> = [];

  const add = (emitter: any, event: string, handler: (...args: any[]) => void) => {
    if (!emitter || typeof emitter.on !== 'function') return;
    emitter.on(event, handler);
    removers.push(() => emitter.removeListener?.(event, handler));
  };

  add(bot, 'kicked', (reason: unknown) => {
    logEvent('bot_kicked', { reason: stringifyReason(reason) });
  });
  add(bot, 'error', (error: unknown) => {
    logEvent('bot_error', { message: stringifyReason(error) });
  });
  add(bot, 'end', (reason: unknown) => {
    logEvent('bot_connection_end', { reason: stringifyReason(reason) });
  });
  add(bot, 'health', () => {
    logEvent('health_changed', { hp: bot.health, hunger: bot.food });
  });

  const pathfinder = bot.pathfinder;
  add(pathfinder, 'goal_reached', () => {
    logEvent('path_goal_reached', {
      goal: orchestrator.getShared().get().currentGoal || null,
      reflex_state: orchestrator.getShared().get().reflexState,
      position: positionOf(bot),
    });
  });
  add(pathfinder, 'path_reset', (reason: unknown) => {
    logEvent('path_reset', {
      reason: stringifyReason(reason),
      goal: orchestrator.getShared().get().currentGoal || null,
      reflex_state: orchestrator.getShared().get().reflexState,
      position: positionOf(bot),
    });
  });
  add(pathfinder, 'path_update', (result: any) => {
    logEvent('path_update', {
      status: result?.status ?? null,
      path_length: Array.isArray(result?.path) ? result.path.length : null,
      visited_nodes: result?.visitedNodes ?? null,
      generated_nodes: result?.generatedNodes ?? null,
      goal: orchestrator.getShared().get().currentGoal || null,
      reflex_state: orchestrator.getShared().get().reflexState,
    });
  });

  detachBotDiagnostics = () => {
    for (const remove of removers.splice(0)) {
      try { remove(); } catch { /* best effort */ }
    }
  };
}

function startViewer(): void {
  if (!envEnabled('GAMEPLAY_VIEWER_ENABLED', true)) {
    logEvent('viewer_disabled');
    return;
  }

  const port = parsePositiveInt(process.env.GAMEPLAY_VIEWER_PORT, DEFAULT_VIEWER_PORT);
  const url = `http://localhost:${port}`;

  try {
    const viewerModule = require('prismarine-viewer') as {
      mineflayer: (bot: unknown, options: Record<string, unknown>) => void;
    };
    const bot = orchestrator.getBotForDebug() as any;

    viewerModule.mineflayer(bot, {
      port,
      firstPerson: true,
      viewDistance: 6,
    });

    if (bot.viewer && typeof bot.viewer.close === 'function') {
      viewerClose = () => bot.viewer.close();
    }

    logEvent('viewer_ready', { url, first_person: true });

    if (envEnabled('GAMEPLAY_VIEWER_AUTO_OPEN', true)) {
      setTimeout(() => {
        try {
          const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-Command', `Start-Process '${url}'`],
            { detached: true, stdio: 'ignore' },
          );
          child.on('error', () => {});
          child.unref();
        } catch {
          // Auto-open is optional. The viewer URL is always logged.
        }
      }, 750);
    }
  } catch (error) {
    logEvent('viewer_unavailable', {
      url,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function startStatusLogging(): void {
  const shared = orchestrator.getShared();
  progressMonitor.reset();
  previousInventory = null;

  statusTimer = setInterval(() => {
    const state = shared.get();
    const runtime = orchestrator.getGameplaySnapshot();

    if (runtime) {
      const alert = progressMonitor.observe(runtime);
      if (alert) {
        shared.pushEvent({
          type: 'gameplay_no_progress',
          detail: alert.detail,
          importance: 'high',
        });
        logEvent('gameplay_no_progress', {
          stagnant_seconds: Math.round(alert.stagnantForMs / 1000),
          goal: alert.goal || null,
          reflex_state: alert.reflexState,
          position: runtime.position,
          inventory: runtime.inventory,
        });
      }

      if (previousInventory) {
        const delta = diffInventory(previousInventory, runtime.inventory);
        if (Object.keys(delta).length > 0) {
          logEvent('inventory_changed', {
            delta,
            inventory: runtime.inventory,
            goal: state.currentGoal || null,
            reflex_state: state.reflexState,
          });
        }
      }
      previousInventory = { ...runtime.inventory };
    }

    logEvent('state', {
      generation: orchestrator.getGeneration(),
      survival_seconds: Math.round(shared.getSurvivalMinutes() * 60),
      goal: state.currentGoal || null,
      sub_goals: state.subGoals,
      reflex_state: state.reflexState,
      threat_level: state.threatLevel,
      hp: runtime?.hp ?? null,
      hunger: runtime?.hunger ?? null,
      position: runtime?.position ?? null,
      inventory: runtime?.inventory ?? null,
      world: getWorldDebugSnapshot(),
      emotion: shared.getEmotionLabel(),
      lessons_this_life: state.lessonsThisLife,
    });
  }, statusIntervalMs);
}

function getWorldDebugSnapshot(): Record<string, unknown> | null {
  try {
    const bot = orchestrator.getBotForDebug() as any;
    const entities = Object.values(bot.entities ?? {})
      .filter((entity: any) => entity && entity !== bot.entity && entity.name && entity.position)
      .map((entity: any) => ({
        type: entity.name,
        distance: Number(bot.entity.position.distanceTo(entity.position).toFixed(1)),
        position: {
          x: Number(entity.position.x.toFixed(1)),
          y: Number(entity.position.y.toFixed(1)),
          z: Number(entity.position.z.toFixed(1)),
        },
      }))
      .filter((entity: any) => entity.distance <= 24)
      .sort((a: any, b: any) => a.distance - b.distance)
      .slice(0, 12);

    const currentBlock = bot.blockAt?.(bot.entity.position);
    return {
      minecraft_time: bot.time?.timeOfDay ?? null,
      day: bot.time?.day ?? null,
      is_raining: bot.isRaining ?? null,
      biome: currentBlock?.biome?.name ?? null,
      held_item: bot.heldItem?.name ?? null,
      on_ground: bot.entity?.onGround ?? null,
      yaw: bot.entity?.yaw ?? null,
      pitch: bot.entity?.pitch ?? null,
      nearby_entities: entities,
    };
  } catch {
    return null;
  }
}

function diffInventory(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    const delta = (after[name] ?? 0) - (before[name] ?? 0);
    if (delta !== 0) result[name] = delta;
  }
  return result;
}

function positionOf(bot: any): Record<string, number> | null {
  const p = bot?.entity?.position;
  if (!p) return null;
  return {
    x: Number(p.x.toFixed(2)),
    y: Number(p.y.toFixed(2)),
    z: Number(p.z.toFixed(2)),
  };
}

function stringifyReason(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

async function main(): Promise<void> {
  logEvent('startup', {
    mode: 'gameplay-only',
    run_log: process.env.AI_MC_RUN_LOG ?? null,
    llm_provider: llmProvider,
    minecraft_host: process.env.MINECRAFT_HOST?.trim() || 'localhost',
    minecraft_port: parsePositiveInt(process.env.MINECRAFT_PORT, 25565),
    bot_username: process.env.BOT_USERNAME?.trim() || 'AI_Rei',
    tactical_model: process.env.TACTICAL_MODEL?.trim() || defaultTacticalModel,
    strategic_model: process.env.STRATEGIC_MODEL?.trim() || defaultStrategicModel,
    db_path: dbPath,
    stall_threshold_ms: parsePositiveInt(
      process.env.GAMEPLAY_STALL_THRESHOLD_MS,
      DEFAULT_STALL_THRESHOLD_MS,
    ),
  });

  startSharedEventLogging();

  await orchestrator.start({
    onCommentary: (text) => {
      logEvent('commentary_candidate', { text });
    },
    onDeath: (cause) => {
      logEvent('death', {
        cause,
        generation: orchestrator.getGeneration(),
        survival_seconds: Math.round(orchestrator.getShared().getSurvivalMinutes() * 60),
      });
      try {
        orchestrator.saveEpisode(cause);
      } catch (error) {
        logEvent('episode_save_error', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      shutdown('death');
    },
    onGoalChanged: (goal) => {
      logEvent('goal_changed', { goal });
    },
    onReactiveAction: (event) => {
      logEvent('reactive_action', {
        event: event.event,
        detail: event.detail,
      });
    },
  });

  attachRuntimeDiagnostics();
  startViewer();
  startStatusLogging();
  logEvent('ready', {
    message: 'Gameplay-only runtime is active. Streaming/TTS/FFmpeg/YouTube are not started.',
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  logEvent('fatal', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  shutdown('startup_failure', 1);
});
