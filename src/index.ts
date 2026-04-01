/**
 * AI Minecraft 配信システム - メインエントリーポイント
 *
 * 多層認知アーキテクチャ版:
 *   - System 1 (反射層): 4Hz ティックレートでルールベースの即時行動
 *   - System 2a (戦術層): 3-5秒周期で高速LLMによる状況評価・実況
 *   - System 2b (戦略層): 30-60秒周期で高性能LLMによる長期計画
 *
 * 起動するとダッシュボード（HTTP）のみ立ち上がり IDLE 状態で待機。
 * ダッシュボードから「配信開始」すると:
 *  1. ワールドリセット（新規ハードコア世界を生成）
 *  2. 認知アーキテクチャ+TTS+FFmpeg の配信ループ開始
 *  3. カメラプレイヤーをスペクテイターモードにしボット視点を配信
 *  4. カスタムHUDオーバーレイ（体力/空腹/目標/実況テキスト）を描画
 */
import { config } from 'dotenv';
config();

import { spawn, execSync, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { CognitiveOrchestrator, type CognitiveOrchestratorConfig } from './cognitive/orchestrator.js';
import { VoicevoxClient, createFetchAdapter } from './tts/voicevox.js';
import { AudioQueue, type AudioPlayer } from './tts/audioQueue.js';
import { AvatarState } from './stream/avatar.js';
import { AvatarRenderer, EXPRESSION_FILE } from './stream/avatarRenderer.js';
import { AvatarFrameWriter } from './stream/avatarFrameWriter.js';
import { HudWriter } from './stream/hudWriter.js';
import { buildFFmpegArgs, type FFmpegConfig } from './stream/ffmpeg.js';
import { startDashboard } from './dashboard/server.js';
import type { DashboardDeps } from './dashboard/routes.js';
import type { DeathRecord } from './types/gameState.js';
import { ok, err } from './types/result.js';
import { YouTubeClient } from './youtube/api.js';
import { tryCreateGoogleYouTubeAdapter } from './youtube/googleApiAdapter.js';
import {
  buildStreamTitle,
  buildStreamTitleLive,
  buildStreamDescription,
  buildTags,
  DEFAULT_STREAM_TITLE_TEMPLATE,
  DEFAULT_STREAM_DESCRIPTION_TEMPLATE,
} from './youtube/metadata.js';

const COOLDOWN_MS = 15_000;
const MC_SERVER_DIR = '/home/ubuntu/minecraft-server';
const AVATAR_PIPE = '/tmp/ai-minecraft-avatar.pipe';
const AVATAR_BASE_PATH = process.env.AVATAR_BASE_PATH || '/home/ubuntu/ai-minecraft/assets/avatar';
const AVATAR_WIDTH = 300;
const AVATAR_HEIGHT = 400;
const BOT_USERNAME = 'AI_Rei';
const CAMERA_PLAYER = 'StreamCamera';
const DB_PATH = process.env.DB_PATH || '/home/ubuntu/ai-minecraft/data/ai-minecraft.db';
const HUD_DIR = '/tmp/ai-mc-hud';
const HUD_FONT = process.env.HUD_FONT_PATH || '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
const DEFAULT_TACTICAL_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_STRATEGIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_FAREWELL_MODEL = DEFAULT_TACTICAL_MODEL;
const YOUTUBE_GOLIVE_RETRY_TIMEOUT_MS = 120_000;
const YOUTUBE_GOLIVE_RETRY_INTERVAL_MS = 3_000;

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

// --- Audio ---

function createPaplayAudioPlayer(): AudioPlayer {
  let currentProc: ChildProcess | null = null;
  return {
    async play(buffer: Buffer): Promise<void> {
      const tmpPath = '/tmp/ai-mc-tts-current.wav';
      writeFileSync(tmpPath, buffer);
      return new Promise<void>((resolve, reject) => {
        currentProc = spawn('paplay', ['--device=voicevox_sink', tmpPath]);
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

// --- FFmpeg ---

function startFFmpegWithHud(hudWriter: HudWriter, rtmpUrl: string): ChildProcess {
  const hudPaths = hudWriter.getFilePaths();

  const ffmpegConfig: FFmpegConfig = {
    display: ':99',
    resolution: '1280x720',
    fps: 30,
    videoBitrate: '2500k',
    audioBitrate: '128k',
    rtmpUrl,
    pulseAudioSource: 'combined_sink.monitor',
    avatarBasePath: AVATAR_BASE_PATH,
    avatarPipePath: AVATAR_PIPE,
    avatarWidth: AVATAR_WIDTH,
    avatarHeight: AVATAR_HEIGHT,
    avatarFps: 5,
    hud: {
      enabled: true,
      fontPath: HUD_FONT,
      filePaths: hudPaths,
    },
  };

  const args = buildFFmpegArgs(ffmpegConfig);
  log('[FFmpeg] Starting stream with avatar overlay + HUD drawtext (RTMP 送信開始)...');
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

// --- YouTube Live (配信枠自動管理) ---

type YoutubeSessionCtx = {
  client: YouTubeClient | null;
  broadcastId: string | null;
  streamId: string | null;
};

async function finalizeYoutubeSession(ctx: YoutubeSessionCtx): Promise<void> {
  if (!ctx.client || !ctx.broadcastId) return;
  const r = await ctx.client.endBroadcast(ctx.broadcastId);
  if (!r.ok) log(`[YouTube] 配信終了 API: ${r.error}`);
  else log('[YouTube] 配信枠を Complete に遷移しました');
  ctx.broadcastId = null;
  ctx.streamId = null;
}

async function waitForYoutubeIngestReady(
  client: YouTubeClient,
  streamId: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await client.getStreamStatus(streamId);
    if (res.ok && (res.value === 'active' || res.value === 'ready')) {
      log(`[YouTube] インジェスト準備 OK (${res.value})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  log('[YouTube] インジェスト ready/active 待ちタイムアウト — goLive を試行します');
}

async function goLiveWithRetry(
  client: YouTubeClient,
  broadcastId: string,
  streamId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    const go = await client.goLive(broadcastId);
    if (go.ok) {
      log('[YouTube] 配信を Live 状態にしました');
      return;
    }

    if (!go.error.includes('Stream is inactive')) {
      log(`[YouTube] goLive 失敗: ${go.error}`);
      return;
    }

    const status = await client.getStreamStatus(streamId);
    if (status.ok) {
      log(`[YouTube] goLive 再試行 ${attempt}: stream=${status.value}`);
    } else {
      log(`[YouTube] goLive 再試行 ${attempt}: stream_status_error=${status.error}`);
    }

    await new Promise((r) => setTimeout(r, YOUTUBE_GOLIVE_RETRY_INTERVAL_MS));
  }

  log('[YouTube] goLive タイムアウト: Stream is inactive が継続');
}

// --- Run one generation with cognitive architecture ---

async function runOneGeneration(
  cogOrch: CognitiveOrchestrator,
  tts: VoicevoxClient,
  audioQueue: AudioQueue,
  avatarState: AvatarState,
  hudWriter: HudWriter,
  ytCtx: YoutubeSessionCtx,
  streamTitleTemplate: string,
): Promise<'died' | 'stopped' | 'disconnected'> {
  currentState = 'LIVE_RUNNING';
  survivalStart = Date.now();
  stopRequested = false;
  let died = false;
  let deathCause = 'unknown';

  log(`\n========== 第${generation}世代 開始 (多層認知アーキテクチャ) ==========\n`);
  log(`  System 1: 反射層 (4Hz ルールベース行動)`);
  log(`  System 2a: 戦術層 (Haiku 3-5秒 非同期)`);
  log(`  System 2b: 戦略層 (Sonnet 30-60秒 非同期)`);

  try {
    await cogOrch.start({
      onCommentary: async (text) => {
        log(`  [TTS] "${text}"`);
        hudWriter.update({ commentary: text });
        const result = await tts.synthesize(text);
        if (result.ok) {
          audioQueue.enqueue(result.value);
        }
      },
      onDeath: (cause) => {
        log(`[Bot] 死亡検知: ${cause}`);
        died = true;
        deathCause = cause;
      },
      onGoalChanged: (goal) => {
        log(`  [Goal] ${goal}`);
        hudWriter.update({ currentGoal: goal });
      },
      onReactiveAction: (event) => {
        log(`  [Reflex] ${event.event}: ${event.detail}`);
      },
    });
  } catch (e) {
    log(`[Bot] 接続失敗: ${e instanceof Error ? e.message : e}`);
    await finalizeYoutubeSession(ytCtx);
    return 'disconnected';
  }

  log('[Cognitive] 全層起動完了 — 反射層が常時稼働中');

  let lastYoutubeTitleSurvivalMinute = -1;

  while (!died && !stopRequested) {
    const shared = cogOrch.getShared().get();
    const survMin = Math.floor((Date.now() - survivalStart) / 60_000);

    hudWriter.update({
      generation,
      survivalStartTime: survivalStart,
      bestRecordMinutes,
      currentGoal: shared.currentGoal || '探索中',
      threatLevel: shared.threatLevel,
      reflexState: shared.reflexState,
      emotionLabel: cogOrch.getShared().getEmotionLabel(),
    });

    if (
      ytCtx.client &&
      ytCtx.broadcastId &&
      survMin > 0 &&
      survMin % 5 === 0 &&
      survMin !== lastYoutubeTitleSurvivalMinute
    ) {
      lastYoutubeTitleSurvivalMinute = survMin;
      const liveTitle = buildStreamTitleLive({
        generation,
        survivalMinutes: survMin,
        baseTemplate: streamTitleTemplate,
      });
      const ur = await ytCtx.client.updateTitle(ytCtx.broadcastId, liveTitle);
      if (!ur.ok) log(`[YouTube] タイトル更新失敗: ${ur.error}`);
    }

    if (survMin % 5 === 0 && survMin > 0) {
      log(`  [Status] Gen${generation} 生存${survMin}分 目標:${shared.currentGoal || '探索中'} 状態:${shared.reflexState} 脅威:${shared.threatLevel} 感情:${cogOrch.getShared().getEmotionLabel()}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  const survivalMinutes = Math.round((Date.now() - survivalStart) / 60_000);
  cogOrch.stop();
  audioQueue.clear();

  if (died) {
    currentState = 'DEATH_DETECTED';
    if (survivalMinutes > bestRecordMinutes) bestRecordMinutes = survivalMinutes;

    cogOrch.saveEpisode(deathCause);

    deathHistory.push({
      generation,
      survivalMinutes,
      cause: deathCause,
      lesson: `第${generation}世代: ${deathCause}で${survivalMinutes}分生存`,
    });
    log(`\n[Death] 第${generation}世代 終了 — ${survivalMinutes}分生存、死因: ${deathCause}`);
    log(`[Death] 最高記録: ${bestRecordMinutes}分`);

    const lessons = cogOrch.getShared().get().lessonsThisLife;
    if (lessons.length > 0) {
      log(`[Death] この世代の教訓: ${lessons.join(', ')}`);
    }

    // Death scene: generate farewell via LLM, speak via TTS, then end stream
    hudWriter.update({ commentary: `死亡... ${deathCause}` });
    hudWriter.flush();

    try {
      const farewell = await generateDeathFarewell(
        deathCause, survivalMinutes, generation, lessons,
        process.env.ANTHROPIC_API_KEY!,
        cogOrch.getShared().getEmotionLabel(),
      );
      log(`  [Death TTS] "${farewell}"`);
      hudWriter.update({ commentary: farewell });
      hudWriter.flush();
      const ttsResult = await tts.synthesize(farewell);
      if (ttsResult.ok) {
        audioQueue.enqueue(ttsResult.value);
        // Wait for TTS playback to finish
        await new Promise(r => setTimeout(r, Math.max(5000, farewell.length * 150)));
      }
    } catch (e) {
      log(`[Death] 配信終了あいさつ生成失敗: ${e instanceof Error ? e.message : e}`);
    }

    await finalizeYoutubeSession(ytCtx);
    return 'died';
  }

  if (stopRequested) {
    log(`[Stop] ダッシュボードから停止要求`);
    await finalizeYoutubeSession(ytCtx);
    return 'stopped';
  }

  return 'disconnected';
}

// --- Death farewell ---

async function generateDeathFarewell(
  deathCause: string,
  survivalMinutes: number,
  gen: number,
  lessons: string[],
  apiKey: string,
  emotionLabel: string,
): Promise<string> {
  const systemPrompt = `あなたは「星守レイ」です。Minecraft ハードコアモードをプレイする AI VTuber です。
たった今、死んでしまいました。視聴者に向けて感想・反省・配信終了のあいさつを話してください。

【ルール】
- 3〜5文程度の短いスピーチ
- 死因に触れ、簡単な反省を述べる
- 次回への意気込みを少し入れる
- 視聴者への感謝で締める
- キャラクターとして自然な口調で（落ち着いた、でも少し悔しそうな感じ）`;

  const userMessage = JSON.stringify({
    death_cause: deathCause,
    survival_minutes: survivalMinutes,
    generation: gen,
    lessons_learned: lessons,
    current_emotion: emotionLabel,
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULT_FAREWELL_MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    return `あぁ...${deathCause}でやられちゃった。${survivalMinutes}分の冒険でした。みなさん、見てくれてありがとう。次こそは頑張るよ。`;
  }

  const data = (await res.json()) as any;
  return data.content[0].text;
}

// --- Main ---

async function main() {
  log('=== AI Minecraft 配信システム (多層認知アーキテクチャ版) 起動 ===\n');

  const mcHost = process.env.MINECRAFT_HOST || 'localhost';
  const mcPort = parseInt(process.env.MINECRAFT_PORT || '25565');
  const voicevoxHost = process.env.VOICEVOX_HOST || 'http://localhost:50021';

  const youtubeAdapter = tryCreateGoogleYouTubeAdapter();
  const youtubeClient = youtubeAdapter ? new YouTubeClient(youtubeAdapter) : null;
  const streamKeyFallback = process.env.YOUTUBE_STREAM_KEY?.trim();
  if (!youtubeClient && !streamKeyFallback) {
    console.error(
      'YOUTUBE_STREAM_KEY または YouTube OAuth (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN) のいずれかが必要です',
    );
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY が未設定'); process.exit(1); }

  const cogConfig: CognitiveOrchestratorConfig = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    tacticalModel: process.env.TACTICAL_MODEL || DEFAULT_TACTICAL_MODEL,
    strategicModel: process.env.STRATEGIC_MODEL || DEFAULT_STRATEGIC_MODEL,
    mcHost,
    mcPort,
    botUsername: BOT_USERNAME,
    cameraPlayer: CAMERA_PLAYER,
    voicevoxHost,
    voicevoxSpeakerId: parseInt(process.env.VOICEVOX_SPEAKER_ID || '23'),
    dbPath: DB_PATH,
  };

  const cogOrch = new CognitiveOrchestrator(cogConfig);
  const tts = new VoicevoxClient(voicevoxHost, cogConfig.voicevoxSpeakerId, createFetchAdapter());
  const audioPlayer = createPaplayAudioPlayer();
  const audioQueue = new AudioQueue(audioPlayer);
  const avatarState = new AvatarState();
  const avatarRenderer = new AvatarRenderer(avatarState, AVATAR_BASE_PATH);

  const avatarWriter = new AvatarFrameWriter({
    pipePath: AVATAR_PIPE,
    expressionFile: EXPRESSION_FILE,
    width: AVATAR_WIDTH,
    height: AVATAR_HEIGHT,
    fps: 5,
  });

  mkdirSync(HUD_DIR, { recursive: true });
  const hudWriter = new HudWriter(HUD_DIR);
  hudWriter.update({ generation, survivalStartTime: Date.now(), bestRecordMinutes: 0 });
  hudWriter.flush();

  const ytCtx: YoutubeSessionCtx = {
    client: youtubeClient,
    broadcastId: null,
    streamId: null,
  };

  const streamTitleTemplate =
    process.env.YOUTUBE_TITLE_TEMPLATE?.trim() || DEFAULT_STREAM_TITLE_TEMPLATE;
  const streamDescriptionTemplate =
    process.env.YOUTUBE_DESCRIPTION_TEMPLATE?.trim() || DEFAULT_STREAM_DESCRIPTION_TEMPLATE;

  if (youtubeClient) {
    log('[YouTube] 配信枠自動管理モード（OAuth + Live API）');
  } else {
    log('[YouTube] 固定ストリームキーモード (YOUTUBE_STREAM_KEY)');
  }

  let ffmpegProc: ChildProcess | null = null;

  cogOrch.getShared().onStateChange((field) => {
    if (field === 'emotionalState' || field === 'threatLevel') {
      const threatLevel = cogOrch.getShared().get().threatLevel;
      const isSpeaking = audioQueue.isPlaying?.() ?? false;
      avatarState.update({
        threatLevel: threatLevel === 'critical' ? 'critical' : threatLevel === 'danger' ? 'high' : threatLevel === 'caution' ? 'medium' : 'low',
        isSpeaking,
      });
    }
  });

  const startStreaming = async () => {
    avatarRenderer.start();
    avatarWriter.createPipe();
    hudWriter.start();

    let rtmpUrl: string;
    if (ytCtx.client) {
      const title = buildStreamTitle({ generation, template: streamTitleTemplate });
      const description = buildStreamDescription({
        generation,
        bestRecordMinutes,
        totalDeaths: deathHistory.length,
        descriptionTemplate: streamDescriptionTemplate,
      });
      const created = await ytCtx.client.createLiveBroadcast({
        title,
        description,
        tags: buildTags(),
        categoryId: process.env.YOUTUBE_CATEGORY_ID?.trim() || '20',
      });
      if (!created.ok) {
        throw new Error(created.error);
      }
      ytCtx.broadcastId = created.value.broadcastId;
      ytCtx.streamId = created.value.streamId;
      rtmpUrl = created.value.rtmpUrl;
      log(`[YouTube] 配信枠作成 broadcastId=${ytCtx.broadcastId}`);
    } else {
      ytCtx.broadcastId = null;
      ytCtx.streamId = null;
      rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKeyFallback}`;
    }

    ffmpegProc = startFFmpegWithHud(hudWriter, rtmpUrl);
    await new Promise(r => setTimeout(r, 1000));
    avatarWriter.connectPipe();
    audioQueue.onPlaybackStart(() => avatarState.update({ threatLevel: 'low', isSpeaking: true }));
    audioQueue.onPlaybackEnd(() => avatarState.update({ threatLevel: 'low', isSpeaking: false }));
    await new Promise(r => setTimeout(r, 3000));

    if (ytCtx.client && ytCtx.broadcastId && ytCtx.streamId) {
      await waitForYoutubeIngestReady(ytCtx.client, ytCtx.streamId, 120_000);
      await goLiveWithRetry(
        ytCtx.client,
        ytCtx.broadcastId,
        ytCtx.streamId,
        YOUTUBE_GOLIVE_RETRY_TIMEOUT_MS,
      );
    }

    log('[Stream] 配信パイプライン起動完了 (アバター + HUD drawtext)');
  };

  const stopStreaming = () => {
    audioPlayer.stop();
    avatarRenderer.stop();
    avatarWriter.stop();
    hudWriter.stop();
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
    getConfig: () => ({
      operationMode,
      cooldownSeconds: COOLDOWN_MS / 1000,
      tacticalModel: cogConfig.tacticalModel,
      strategicModel: cogConfig.strategicModel,
    }),
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
    void (async () => {
      await finalizeYoutubeSession(ytCtx);
      cogOrch.destroy();
      stopStreaming();
      avatarState.destroy();
      dashboard.close();
      process.exit(0);
    })();
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
      await new Promise(r => setTimeout(r, 1000));
    }

    currentState = 'STARTING';
    log('[Starting] ワールドリセット + 配信パイプライン起動中...');

    resetWorld();
    await waitForServer(60_000);
    restartClient();
    log('[Starting] MC クライアントのロード待機 (30s)...');
    await new Promise(r => setTimeout(r, 30_000));

    await startStreaming();

    let continueLoop = true;
    while (continueLoop) {
      const result = await runOneGeneration(
        cogOrch, tts, audioQueue, avatarState, hudWriter, ytCtx, streamTitleTemplate,
      );

      if (result === 'died' && operationMode === 'AUTO' && !stopRequested) {
        currentState = 'RESETTING';
        log(`[Auto] ${COOLDOWN_MS / 1000}秒クールダウン後にワールドリセット...`);
        await new Promise(r => setTimeout(r, COOLDOWN_MS));

        if (stopRequested) { continueLoop = false; break; }

        if (ytCtx.client) {
          stopStreaming();
        }

        resetWorld();
        await waitForServer(60_000);
        restartClient();
        log('[Reset] MC クライアントのロード待機 (30s)...');
        await new Promise(r => setTimeout(r, 30_000));
        generation++;
        cogOrch.nextGeneration();

        if (ytCtx.client) {
          await startStreaming();
        }
        continue;
      }
      continueLoop = false;
    }

    stopStreaming();
    log('[System] 配信終了。IDLE に戻ります。\n');
  }
}

main().catch((e) => {
  console.error('起動エラー:', e);
  process.exit(1);
});
