/**
 * AI Minecraft 配信システム - メインエントリーポイント
 *
 * 起動するとダッシュボード（HTTP）のみ立ち上がり IDLE 状態で待機。
 * ダッシュボードから「配信開始」すると:
 *  1. ワールドリセット（新規ハードコア世界を生成）
 *  2. Bot+LLM+TTS+FFmpeg の配信ループ開始
 *  3. AI_Rei をスペクテイターモードにし Bot 視点を配信
 *
 * MANUAL モード: 死亡で配信停止（IDLE に戻る）
 * AUTO   モード: 死亡→ワールドリセット→自動的に次世代開始
 */
import { config } from 'dotenv';
config();

import { spawn, execSync, execFileSync, type ChildProcess } from 'child_process';
import { writeFileSync, readFileSync, existsSync, createWriteStream } from 'fs';
import type { WriteStream } from 'fs';
import { BotClient } from './bot/client.js';
import { LLMClient, type LLMApiAdapter } from './llm/client.js';
import { VoicevoxClient, createFetchAdapter } from './tts/voicevox.js';
import { AudioQueue, type AudioPlayer } from './tts/audioQueue.js';
import { CycleRunner, type CycleDeps } from './orchestrator/cycle.js';
import { AvatarState } from './stream/avatar.js';
import { AvatarRenderer } from './stream/avatarRenderer.js';
import { EXPRESSION_FILE } from './stream/avatarRenderer.js';
import { mapSteps } from './bot/actionMapper.js';
import { startDashboard } from './dashboard/server.js';
import type { DashboardDeps } from './dashboard/routes.js';
import type { GameState, DeathRecord } from './types/gameState.js';
import { ok, err } from './types/result.js';

const CYCLE_INTERVAL_MS = 20_000;
const COOLDOWN_MS = 15_000;
const MC_SERVER_DIR = '/home/ubuntu/minecraft-server';
const AVATAR_PIPE = '/tmp/ai-minecraft-avatar.pipe';
const AVATAR_BASE_PATH = process.env.AVATAR_BASE_PATH || '/home/ubuntu/ai-minecraft/assets/avatar';
const AVATAR_WIDTH = 300;
const AVATAR_HEIGHT = 400;
const AVATAR_FRAME_BYTES = AVATAR_WIDTH * AVATAR_HEIGHT * 4;
const CLIENT_PLAYER = 'AI_Rei';

// --- Shared mutable state ---
let generation = 1;
let bestRecordMinutes = 0;
let survivalStart = Date.now();
let operationMode: 'MANUAL' | 'AUTO' = 'MANUAL';
let currentState: 'IDLE' | 'STARTING' | 'LIVE_RUNNING' | 'DEATH_DETECTED' | 'RESETTING' = 'IDLE';
let stopRequested = false;
let startRequested = false;
const deathHistory: DeathRecord[] = [];
const actionLogs: Array<{ timestamp: string; type: string; content: string }> = [];

function log(msg: string) {
  const entry = { timestamp: new Date().toISOString(), type: 'info', content: msg };
  actionLogs.push(entry);
  if (actionLogs.length > 500) actionLogs.shift();
  console.log(msg);
}

// --- Factory functions ---

function createAnthropicAdapter(): LLMApiAdapter {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
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
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${body}`);
      }
      const data = (await res.json()) as any;
      return data.content[0].text;
    },
  };
}

function createPaplayAudioPlayer(): AudioPlayer {
  let currentProc: ChildProcess | null = null;
  return {
    async play(buffer: Buffer): Promise<void> {
      const tmpPath = '/tmp/ai-mc-tts-current.wav';
      writeFileSync(tmpPath, buffer);
      return new Promise<void>((resolve, reject) => {
        currentProc = spawn('paplay', ['--device=combined_sink', tmpPath]);
        currentProc.on('close', (code) => {
          currentProc = null;
          code === 0 ? resolve() : reject(new Error(`paplay exit ${code}`));
        });
        currentProc.on('error', (err) => {
          currentProc = null;
          reject(err);
        });
      });
    },
    stop() {
      currentProc?.kill();
      currentProc = null;
    },
  };
}

// --- Avatar frame writer (Node.js-based, replaces avatar-writer.sh) ---

class AvatarFrameWriter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pipeStream: WriteStream | null = null;
  private lastImagePath = '';
  private cachedFrame: Buffer = Buffer.alloc(AVATAR_FRAME_BYTES);

  start(): void {
    execSync(`rm -f ${AVATAR_PIPE}`, { timeout: 2000 });
    execSync(`mkfifo ${AVATAR_PIPE}`, { timeout: 2000 });
    log('[AvatarWriter] Named pipe created, waiting for FFmpeg...');
  }

  connectPipe(): void {
    this.pipeStream = createWriteStream(AVATAR_PIPE, { highWaterMark: AVATAR_FRAME_BYTES * 2 });
    this.pipeStream.on('error', (e) => console.error(`[AvatarWriter] pipe error: ${e.message}`));

    this.timer = setInterval(() => this.writeFrame(), 200);
    log('[AvatarWriter] Frame writing started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.pipeStream) { this.pipeStream.destroy(); this.pipeStream = null; }
    try { execSync(`rm -f ${AVATAR_PIPE}`, { timeout: 2000 }); } catch { /* ignore */ }
  }

  private writeFrame(): void {
    if (!this.pipeStream || this.pipeStream.destroyed) return;

    try {
      const imgPath = existsSync(EXPRESSION_FILE) ? readFileSync(EXPRESSION_FILE, 'utf-8').trim() : '';

      if (imgPath && existsSync(imgPath) && imgPath !== this.lastImagePath) {
        const raw = execFileSync('convert', [
          imgPath, '-resize', `${AVATAR_WIDTH}x${AVATAR_HEIGHT}!`, '-depth', '8', 'RGBA:-',
        ], { maxBuffer: AVATAR_FRAME_BYTES + 1024, timeout: 3000 });

        if (raw.length === AVATAR_FRAME_BYTES) {
          this.cachedFrame = raw;
          this.lastImagePath = imgPath;
        }
      }

      this.pipeStream.write(this.cachedFrame);
    } catch {
      try { this.pipeStream?.write(Buffer.alloc(AVATAR_FRAME_BYTES)); } catch { /* pipe broken */ }
    }
  }
}

// --- FFmpeg ---

function startFFmpeg(): ChildProcess {
  const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${process.env.YOUTUBE_STREAM_KEY}`;
  const args = [
    '-f', 'x11grab', '-framerate', '30', '-video_size', '1280x720', '-i', ':99',
    '-f', 'pulse', '-i', 'combined_sink.monitor',
    '-thread_queue_size', '512',
    '-f', 'rawvideo', '-pixel_format', 'rgba',
    '-video_size', `${AVATAR_WIDTH}x${AVATAR_HEIGHT}`, '-framerate', '5',
    '-i', AVATAR_PIPE,
    '-filter_complex', '[0:v][2:v]overlay=W-w-20:H-h-20:format=auto[out]',
    '-map', '[out]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k', '-g', '60',
    '-r', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-f', 'flv', rtmpUrl,
  ];
  log('[FFmpeg] Starting stream with avatar overlay...');
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line.includes('frame=') && line.includes('fps=')) return;
    if (line) console.log(`[FFmpeg] ${line}`);
  });
  proc.on('exit', (code) => log(`[FFmpeg] Exited with code ${code}`));
  return proc;
}

// --- World management ---

function resetWorld(): void {
  log('[Reset] MC サーバー停止 + ワールド削除...');
  try {
    execSync('sudo systemctl stop minecraft-client', { timeout: 15_000 });
    execSync('sudo systemctl stop minecraft-server', { timeout: 15_000 });
    execSync(`rm -rf ${MC_SERVER_DIR}/world`, { timeout: 5_000 });
    log('[Reset] ワールド削除完了。MC サーバー再起動...');
    execSync('sudo systemctl start minecraft-server', { timeout: 15_000 });
  } catch (e) {
    log(`[Reset] エラー: ${e instanceof Error ? e.message : e}`);
  }
}

function waitForServer(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      try {
        const out = execSync(
          'sudo journalctl -u minecraft-server --no-pager -n 10 --since "60 sec ago"',
          { encoding: 'utf-8', timeout: 5000 },
        );
        if (out.includes('Done')) { resolve(); return; }
      } catch { /* retry */ }
      if (Date.now() - start > timeoutMs) { log('[Reset] サーバー起動タイムアウト'); resolve(); return; }
      setTimeout(check, 3000);
    };
    check();
  });
}

function restartClient(): void {
  log('[Reset] MC クライアント再起動...');
  try {
    execSync('sudo systemctl restart minecraft-client', { timeout: 15_000 });
  } catch (e) {
    log(`[Reset] クライアント再起動エラー: ${e instanceof Error ? e.message : e}`);
  }
}

// --- Run one generation ---

async function runOneGeneration(deps: {
  mcHost: string;
  mcPort: number;
  llmClient: LLMClient;
  tts: VoicevoxClient;
  audioQueue: AudioQueue;
  audioPlayer: AudioPlayer;
  avatarState: AvatarState;
}): Promise<'died' | 'stopped' | 'disconnected'> {
  const { mcHost, mcPort, llmClient, tts, audioQueue, avatarState } = deps;

  currentState = 'LIVE_RUNNING';
  survivalStart = Date.now();
  stopRequested = false;
  let died = false;
  let deathCause = 'unknown';
  const recentEvents: Array<{ time: string; event: string; detail: string }> = [];

  log(`\n========== 第${generation}世代 開始 ==========\n`);

  const bot = new BotClient();
  try {
    await bot.connect(
      { host: mcHost, port: mcPort, username: 'MineflayerBot' },
      {
        onDeath: (cause) => {
          log(`[Bot] 死亡検知: ${cause}`);
          died = true;
          deathCause = cause;
        },
        onReactiveAction: (event) => {
          recentEvents.push(event);
          if (recentEvents.length > 10) recentEvents.shift();
        },
      },
    );
  } catch (e) {
    log(`[Bot] 接続失敗: ${e instanceof Error ? e.message : e}`);
    return 'disconnected';
  }
  log('[Bot] 接続成功');

  bot.setupSpectator(CLIENT_PLAYER);

  const getFullGameState = (): GameState => {
    const partial = bot.getPartialGameState();
    const survivalMinutes = Math.floor((Date.now() - survivalStart) / 60_000);
    return {
      ...partial,
      pacing: {
        currentActionCategory: 'exploring',
        categoryDurationMinutes: 0,
        survivalTimeMinutes: survivalMinutes,
        progressPhase: survivalMinutes < 10 ? 'early' : survivalMinutes < 30 ? 'stable' : 'advanced',
        bestRecordMinutes,
      },
      previousPlan: null,
      recentEvents: [...recentEvents],
      stagnationWarning: false,
      memory: { totalDeaths: deathHistory.length, bestRecordMinutes, recentDeaths: deathHistory.slice(-5) },
    };
  };

  const cycleDeps: CycleDeps = {
    getGameState: getFullGameState,
    callLLM: (state) => llmClient.call(state),
    executeSteps: async (steps) => {
      const mapped = mapSteps(steps);
      for (const action of mapped) {
        if (died || stopRequested) break;
        log(`  [Action] ${action.originalStep} → ${action.type}`);
        try {
          await bot.executeAction(action);
        } catch (e) {
          console.error(`  [Action] 実行失敗: ${e instanceof Error ? e.message : e}`);
        }
      }
    },
    speakCommentary: async (text) => {
      log(`  [TTS] "${text}"`);
      const result = await tts.synthesize(text);
      if (result.ok) {
        audioQueue.enqueue(result.value);
      }
    },
    updateOverlay: () => {},
    updateAvatar: (threatLevel, isSpeaking) => {
      avatarState.update({ threatLevel, isSpeaking });
    },
    triggerAvatarSpecial: (expression) => {
      avatarState.triggerSpecial(expression as any);
    },
    logAction: (entry) => {
      actionLogs.push(entry);
      if (actionLogs.length > 500) actionLogs.shift();
    },
  };

  const cycleRunner = new CycleRunner(cycleDeps);
  let cycleCount = 0;

  while (!died && !stopRequested && bot.isConnected()) {
    cycleCount++;
    const survMin = Math.floor((Date.now() - survivalStart) / 60_000);
    log(`\n--- サイクル #${cycleCount} (Gen ${generation}, 生存: ${survMin}分) ---`);

    const result = await cycleRunner.runOneCycle();
    if (result.ok) {
      log(`  → 目標: ${result.value.action.goal}`);
      log(`  → 脅威: ${result.value.threatLevel}`);
    } else {
      console.error(`  → サイクル失敗: ${result.error}`);
    }

    await new Promise((r) => setTimeout(r, CYCLE_INTERVAL_MS));
  }

  const survivalMinutes = Math.floor((Date.now() - survivalStart) / 60_000);
  bot.disconnect();
  audioQueue.clear();

  if (died) {
    currentState = 'DEATH_DETECTED';
    if (survivalMinutes > bestRecordMinutes) bestRecordMinutes = survivalMinutes;
    deathHistory.push({
      generation,
      survivalMinutes,
      cause: deathCause,
      lesson: `第${generation}世代: ${deathCause}で${survivalMinutes}分生存`,
    });
    log(`\n[Death] 第${generation}世代 終了 — ${survivalMinutes}分生存、死因: ${deathCause}`);
    log(`[Death] 最高記録: ${bestRecordMinutes}分\n`);
    return 'died';
  }

  if (stopRequested) {
    log(`[Stop] ダッシュボードから停止要求`);
    return 'stopped';
  }

  return 'disconnected';
}

// --- Main ---

async function main() {
  log('=== AI Minecraft 配信システム起動 ===\n');

  const mcHost = process.env.MINECRAFT_HOST || 'localhost';
  const mcPort = parseInt(process.env.MINECRAFT_PORT || '25565');
  const voicevoxHost = process.env.VOICEVOX_HOST || 'http://localhost:50021';

  if (!process.env.YOUTUBE_STREAM_KEY) { console.error('YOUTUBE_STREAM_KEY が未設定'); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY が未設定'); process.exit(1); }

  const llmClient = new LLMClient(createAnthropicAdapter());
  const tts = new VoicevoxClient(voicevoxHost, 14, createFetchAdapter());
  const audioPlayer = createPaplayAudioPlayer();
  const audioQueue = new AudioQueue(audioPlayer);
  const avatarState = new AvatarState();
  const avatarRenderer = new AvatarRenderer(avatarState, AVATAR_BASE_PATH);
  const avatarWriter = new AvatarFrameWriter();

  let ffmpegProc: ChildProcess | null = null;

  const startStreaming = async () => {
    avatarRenderer.start();
    avatarWriter.start();

    ffmpegProc = startFFmpeg();
    await new Promise((r) => setTimeout(r, 1000));

    avatarWriter.connectPipe();
    audioQueue.onPlaybackStart(() => avatarState.update({ threatLevel: 'low', isSpeaking: true }));
    audioQueue.onPlaybackEnd(() => avatarState.update({ threatLevel: 'low', isSpeaking: false }));
    await new Promise((r) => setTimeout(r, 3000));
    log('[Stream] 配信パイプライン起動完了');
  };

  const stopStreaming = () => {
    audioPlayer.stop();
    avatarRenderer.stop();
    avatarWriter.stop();
    avatarState.destroy();
    if (ffmpegProc) { ffmpegProc.kill('SIGTERM'); ffmpegProc = null; }
    log('[Stream] 配信パイプライン停止');
  };

  // --- Dashboard ---
  const dashDeps: DashboardDeps = {
    getStatus: () => ({
      state: currentState,
      generation,
      survivalMinutes: currentState === 'LIVE_RUNNING'
        ? Math.floor((Date.now() - survivalStart) / 60_000)
        : 0,
      bestRecordMinutes,
      operationMode,
      dailyStreamCount: generation,
      healthStatuses: [],
    }),
    triggerStart: () => {
      if (currentState !== 'IDLE') return err('現在 IDLE ではありません');
      startRequested = true;
      return ok(undefined);
    },
    triggerStop: () => {
      if (currentState === 'IDLE') return err('既に停止しています');
      stopRequested = true;
      return ok(undefined);
    },
    getLogs: () => actionLogs.slice(-50) as any,
    getConfig: () => ({ operationMode, cooldownSeconds: COOLDOWN_MS / 1000 }),
    updateConfig: (partial) => {
      if (partial.operationMode === 'MANUAL' || partial.operationMode === 'AUTO') {
        operationMode = partial.operationMode;
        log(`[Config] モード変更: ${operationMode}`);
      }
      return ok(undefined);
    },
    getDeathHistory: () => deathHistory,
  };

  const dashboard = startDashboard(
    parseInt(process.env.DASHBOARD_PORT || '8080'),
    dashDeps,
  );
  log(`[Dashboard] ポート ${process.env.DASHBOARD_PORT || '8080'} で起動`);
  log(`[Mode] 現在のモード: ${operationMode}`);
  log('[System] IDLE — ダッシュボードから「配信開始」を押してください\n');

  // --- Graceful shutdown ---
  const shutdown = () => {
    log('\n[Shutdown] プロセス終了...');
    stopRequested = true;
    stopStreaming();
    dashboard.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // --- Main event loop ---
  while (true) {
    currentState = 'IDLE';
    startRequested = false;
    stopRequested = false;

    log('[IDLE] 配信開始待機中...');
    while (!startRequested) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    // --- New stream: reset world + start ---
    currentState = 'STARTING';
    log('[Starting] ワールドリセット + 配信パイプライン起動中...');

    resetWorld();
    await waitForServer(60_000);
    restartClient();
    log('[Starting] MC クライアントのロード待機 (30s)...');
    await new Promise((r) => setTimeout(r, 30_000));

    await startStreaming();

    let continueLoop = true;
    while (continueLoop) {
      const result = await runOneGeneration({
        mcHost, mcPort, llmClient, tts, audioQueue, audioPlayer, avatarState,
      });

      if (result === 'died' && operationMode === 'AUTO' && !stopRequested) {
        currentState = 'RESETTING';
        log(`[Auto] ${COOLDOWN_MS / 1000}秒クールダウン後にワールドリセット...`);
        await new Promise((r) => setTimeout(r, COOLDOWN_MS));

        if (stopRequested) { continueLoop = false; break; }

        resetWorld();
        await waitForServer(60_000);
        restartClient();
        log('[Reset] MC クライアントのロード待機 (30s)...');
        await new Promise((r) => setTimeout(r, 30_000));
        generation++;
      } else {
        continueLoop = false;
      }
    }

    stopStreaming();
    log('[System] 配信終了。IDLE に戻ります。\n');
  }
}

main().catch((e) => {
  console.error('起動エラー:', e);
  process.exit(1);
});
