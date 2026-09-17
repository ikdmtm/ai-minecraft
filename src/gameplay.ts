import { config as loadEnv } from 'dotenv';
loadEnv();

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

function shutdown(reason: string, exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopStatusTimer();
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

function startStatusLogging(): void {
  const shared = orchestrator.getShared();
  progressMonitor.reset();

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
      emotion: shared.getEmotionLabel(),
      lessons_this_life: state.lessonsThisLife,
    });
  }, statusIntervalMs);
}

async function main(): Promise<void> {
  logEvent('startup', {
    mode: 'gameplay-only',
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
