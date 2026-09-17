import { config as loadEnv } from 'dotenv';
loadEnv();

import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { CognitiveOrchestrator } from './jevOrchestrator.js';
import { GameplayProgressMonitor } from './progressMonitor.js';

const DEFAULT_STATUS_INTERVAL_MS = 2_000;
const DEFAULT_STALL_THRESHOLD_MS = 20_000;
const DEFAULT_STALL_ALERT_COOLDOWN_MS = 15_000;
const DEFAULT_VIEWER_PORT = 3007;
const DEFAULT_STRATEGIC_MODEL = 'gpt-5.6-terra';

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

const dbPath = process.env.DB_PATH?.trim() || './data/gameplay.db';
mkdirSync(dirname(resolve(dbPath)), { recursive: true });

const orchestrator = new CognitiveOrchestrator({
  llmProvider: 'openai',
  openaiApiKey: requiredEnv('OPENAI_API_KEY'),
  tacticalModel: 'jev',
  strategicModel: process.env.STRATEGIC_MODEL?.trim() || DEFAULT_STRATEGIC_MODEL,
  mcHost: process.env.MINECRAFT_HOST?.trim() || 'localhost',
  mcPort: parsePositiveInt(process.env.MINECRAFT_PORT, 25565),
  botUsername: process.env.BOT_USERNAME?.trim() || 'AI_Rei',
  cameraPlayer: '',
  voicevoxHost: '',
  voicevoxSpeakerId: 0,
  dbPath,
});

const progressMonitor = new GameplayProgressMonitor({
  stallThresholdMs: parsePositiveInt(process.env.GAMEPLAY_STALL_THRESHOLD_MS, DEFAULT_STALL_THRESHOLD_MS),
  alertCooldownMs: parsePositiveInt(
    process.env.GAMEPLAY_STALL_ALERT_COOLDOWN_MS,
    DEFAULT_STALL_ALERT_COOLDOWN_MS,
  ),
});

let statusTimer: ReturnType<typeof setInterval> | null = null;
let viewerClose: (() => void) | null = null;
let unsubscribeSharedEvents: (() => void) | null = null;
let detachDiagnostics: (() => void) | null = null;
let previousInventory: Record<string, number> | null = null;
let shuttingDown = false;

function logEvent(kind: string, payload: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), kind, ...payload }));
}

function shutdown(reason: string, exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  unsubscribeSharedEvents?.();
  unsubscribeSharedEvents = null;
  detachDiagnostics?.();
  detachDiagnostics = null;
  try { viewerClose?.(); } catch { /* best effort */ }
  viewerClose = null;
  logEvent('shutdown', { reason });
  try { orchestrator.destroy(); } catch (error) {
    logEvent('shutdown_error', { message: error instanceof Error ? error.message : String(error) });
  }
  process.exitCode = exitCode;
}

function startSharedEventLogging(): void {
  unsubscribeSharedEvents = orchestrator.getShared().onStateChange((field, value) => {
    if (field === 'recentEvents' && value && typeof value === 'object') {
      const event = value as any;
      logEvent('game_event', {
        event_ts: event.timestamp ?? null,
        event_type: event.type ?? 'unknown',
        detail: event.detail ?? '',
        importance: event.importance ?? null,
      });
    } else if (field === 'subGoals' && Array.isArray(value)) {
      logEvent('sub_goals_changed', { sub_goals: value });
    }
  });
}

function attachDiagnostics(): void {
  const bot = orchestrator.getBotForDebug() as any;
  const removers: Array<() => void> = [];
  const add = (emitter: any, event: string, handler: (...args: any[]) => void) => {
    if (!emitter?.on) return;
    emitter.on(event, handler);
    removers.push(() => emitter.removeListener?.(event, handler));
  };

  add(bot, 'kicked', (reason: unknown) => logEvent('bot_kicked', { reason: stringify(reason) }));
  add(bot, 'error', (error: unknown) => logEvent('bot_error', { message: stringify(error) }));
  add(bot, 'end', (reason: unknown) => logEvent('bot_connection_end', { reason: stringify(reason) }));
  add(bot, 'health', () => logEvent('health_changed', { hp: bot.health, hunger: bot.food }));
  add(bot.pathfinder, 'goal_reached', () => logEvent('path_goal_reached', {
    position: positionOf(bot),
    skill: orchestrator.getJevWorldState()?.currentSkill ?? null,
  }));
  add(bot.pathfinder, 'path_reset', (reason: unknown) => logEvent('path_reset', {
    reason: stringify(reason),
    position: positionOf(bot),
    skill: orchestrator.getJevWorldState()?.currentSkill ?? null,
  }));
  add(bot.pathfinder, 'path_update', (result: any) => logEvent('path_update', {
    status: result?.status ?? null,
    path_length: Array.isArray(result?.path) ? result.path.length : null,
    visited_nodes: result?.visitedNodes ?? null,
    generated_nodes: result?.generatedNodes ?? null,
  }));

  detachDiagnostics = () => {
    for (const remove of removers.splice(0)) {
      try { remove(); } catch { /* best effort */ }
    }
  };
}

function startViewer(): void {
  if (!envEnabled('GAMEPLAY_VIEWER_ENABLED', true)) return;
  const port = parsePositiveInt(process.env.GAMEPLAY_VIEWER_PORT, DEFAULT_VIEWER_PORT);
  const url = `http://localhost:${port}`;
  try {
    const viewerModule = require('prismarine-viewer') as {
      mineflayer: (bot: unknown, options: Record<string, unknown>) => void;
    };
    const bot = orchestrator.getBotForDebug() as any;
    viewerModule.mineflayer(bot, { port, firstPerson: true, viewDistance: 6 });
    if (bot.viewer?.close) viewerClose = () => bot.viewer.close();
    logEvent('viewer_ready', { url, first_person: true });
    if (envEnabled('GAMEPLAY_VIEWER_AUTO_OPEN', true)) {
      setTimeout(() => {
        try {
          const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], {
            detached: true,
            stdio: 'ignore',
          });
          child.on('error', () => {});
          child.unref();
        } catch { /* optional */ }
      }, 750);
    }
  } catch (error) {
    logEvent('viewer_unavailable', { url, message: error instanceof Error ? error.message : String(error) });
  }
}

function startStatusLogging(): void {
  const shared = orchestrator.getShared();
  const interval = parsePositiveInt(process.env.GAMEPLAY_STATUS_INTERVAL_MS, DEFAULT_STATUS_INTERVAL_MS);
  progressMonitor.reset();
  previousInventory = null;

  statusTimer = setInterval(() => {
    const state = shared.get();
    const runtime = orchestrator.getGameplaySnapshot();
    const jevState = orchestrator.getJevWorldState();

    if (runtime) {
      const alert = progressMonitor.observe(runtime);
      if (alert) {
        shared.pushEvent({ type: 'gameplay_no_progress', detail: alert.detail, importance: 'high' });
        logEvent('gameplay_no_progress', {
          stagnant_seconds: Math.round(alert.stagnantForMs / 1000),
          goal: alert.goal || null,
          reflex_state: alert.reflexState,
          position: runtime.position,
          inventory: runtime.inventory,
          current_skill: jevState?.currentSkill ?? null,
        });
      }
      if (previousInventory) {
        const delta = diffInventory(previousInventory, runtime.inventory);
        if (Object.keys(delta).length > 0) logEvent('inventory_changed', { delta, inventory: runtime.inventory });
      }
      previousInventory = { ...runtime.inventory };
    }

    logEvent('state', {
      generation: orchestrator.getGeneration(),
      survival_seconds: Math.round(shared.getSurvivalMinutes() * 60),
      strategy_goal: state.currentGoal || null,
      sub_goals: state.subGoals,
      skill: jevState?.currentSkill ?? null,
      threat_level: state.threatLevel,
      hp: runtime?.hp ?? null,
      hunger: runtime?.hunger ?? null,
      position: runtime?.position ?? null,
      inventory: runtime?.inventory ?? null,
      world: jevState?.world ?? null,
      block_candidates: jevState?.blockCandidates.slice(0, 8) ?? [],
      entity_candidates: jevState?.entityCandidates.slice(0, 8) ?? [],
    });
  }, interval);
}

async function main(): Promise<void> {
  logEvent('startup', {
    mode: 'gameplay-jev',
    run_log: process.env.AI_MC_RUN_LOG ?? null,
    minecraft_host: process.env.MINECRAFT_HOST?.trim() || 'localhost',
    minecraft_port: parsePositiveInt(process.env.MINECRAFT_PORT, 25565),
    bot_username: process.env.BOT_USERNAME?.trim() || 'AI_Rei',
    jev_model: process.env.JEV_MODEL?.trim() || 'jev-latest',
    jev_interval_ms: parsePositiveInt(process.env.JEV_INTERVAL_MS, 400),
    strategic_model: process.env.STRATEGIC_MODEL?.trim() || DEFAULT_STRATEGIC_MODEL,
  });

  startSharedEventLogging();
  await orchestrator.start({
    onCommentary: text => logEvent('commentary_candidate', { text }),
    onDeath: cause => {
      logEvent('death', { cause, survival_seconds: Math.round(orchestrator.getShared().getSurvivalMinutes() * 60) });
      try { orchestrator.saveEpisode(cause); } catch { /* best effort */ }
      shutdown('death');
    },
    onGoalChanged: goal => logEvent('goal_changed', { goal }),
    onReactiveAction: event => logEvent('reactive_action', { event: event.event, detail: event.detail }),
  });

  attachDiagnostics();
  startViewer();
  startStatusLogging();
  logEvent('ready', { message: 'Jev policy runtime active. Safety is deterministic; normal action selection is Jev.' });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch(error => {
  logEvent('fatal', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  shutdown('startup_failure', 1);
});

function diffInventory(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const value = (after[name] ?? 0) - (before[name] ?? 0);
    if (value !== 0) delta[name] = value;
  }
  return delta;
}

function positionOf(bot: any): Record<string, number> | null {
  const p = bot?.entity?.position;
  if (!p) return null;
  return { x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)), z: Number(p.z.toFixed(2)) };
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
