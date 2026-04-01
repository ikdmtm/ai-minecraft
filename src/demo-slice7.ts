/**
 * Slice 7 デモ: 記憶・学習 + オーケストレーター統合
 *
 * 実行: npx tsx src/demo-slice7.ts
 */
import { DeathHandler, type DeathHandlerDeps } from './orchestrator/deathHandler.js';
import { buildMemory, type MemorySource } from './orchestrator/memoryBuilder.js';
import { Orchestrator, type OrchestratorDeps } from './orchestrator/orchestrator.js';
import { ok } from './types/result.js';
import type { DeathRecord } from './types/gameState.js';

function sep(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// ────── 1. 死亡ハンドラー ──────
sep('死亡ハンドラー デモ');

const deathRecords: DeathRecord[] = [];

const deathDeps: DeathHandlerDeps = {
  generateLesson: async (ctx) => {
    console.log(`  [LLM] 教訓生成中... (原因: ${ctx.cause}, ${ctx.survivalMinutes}分生存)`);
    return ok(`${ctx.cause}に注意し、${ctx.survivalMinutes > 30 ? '夜間行動を避ける' : '初期装備を急ぐ'}こと`);
  },
  addDeathRecord: (record) => {
    deathRecords.push(record);
    console.log(`  [DB] 死亡記録保存: Gen#${record.generation} ${record.survivalMinutes}分 "${record.lesson}"`);
  },
  getState: () => ({
    currentGeneration: deathRecords.length + 1,
    bestRecordMinutes: Math.max(0, ...deathRecords.map(d => d.survivalMinutes)),
    survivalStartTime: new Date(Date.now() - 45 * 60_000).toISOString(),
  }),
  saveState: (partial) => console.log(`  [DB] 状態更新:`, JSON.stringify(partial).slice(0, 100)),
  getBestRecord: () => Math.max(0, ...deathRecords.map(d => d.survivalMinutes)),
  logAction: (entry) => console.log(`  [LOG] ${entry.type}: ${entry.content.slice(0, 80)}`),
};

(async () => {
  const handler = new DeathHandler(deathDeps);

  // 3回死亡シミュレーション
  const deaths = [
    { cause: 'クリーパー爆発', pos: { x: 100, y: 64, z: -50 } },
    { cause: 'スケルトンの弓', pos: { x: -30, y: 30, z: 80 } },
    { cause: '溶岩ダイブ', pos: { x: 50, y: 11, z: 20 } },
  ];

  for (const d of deaths) {
    console.log(`\n  --- Gen#${deathRecords.length + 1} 死亡: ${d.cause} ---`);
    const result = await handler.handleDeath(d.cause, {
      position: d.pos,
      recentActions: [{ time: 'now', event: 'playing', detail: '通常プレイ中' }],
    });
    if (result.ok) {
      console.log(`  結果: ${result.value.survivalMinutes}分生存, 新記録: ${result.value.isNewRecord ? 'YES' : 'no'}`);
    }
  }

  // ────── 2. 記憶構築 ──────
  sep('LLM Memory 構築デモ');

  const memorySource: MemorySource = {
    getRecentDeaths: (limit) => deathRecords.slice(-limit),
    getBestRecord: () => Math.max(0, ...deathRecords.map(d => d.survivalMinutes)),
    getTotalDeaths: () => deathRecords.length,
  };

  const memory = buildMemory(memorySource);
  console.log(`  totalDeaths: ${memory.totalDeaths}`);
  console.log(`  bestRecordMinutes: ${memory.bestRecordMinutes}`);
  console.log(`  recentDeaths (${memory.recentDeaths.length}件):`);
  for (const d of memory.recentDeaths) {
    console.log(`    Gen#${d.generation}: ${d.survivalMinutes}分 - ${d.cause} → ${d.lesson}`);
  }

  // ────── 3. オーケストレーター統合（MANUAL → AUTO） ──────
  sep('オーケストレーター MANUAL モード');

  const orchDeps: OrchestratorDeps = {
    bootServices: async () => { console.log('  [boot] サービス起動'); return ok(undefined); },
    prepareStream: async () => {
      console.log('  [stream] 配信枠作成');
      return ok({ broadcastId: 'bc-1', streamId: 'st-1', streamKey: 'key-1', rtmpUrl: 'rtmp://test' });
    },
    runOneCycle: async () => ok({}),
    handleDeath: async (cause) => {
      console.log(`  [death] 死亡処理: ${cause}`);
      return ok({ generation: 1, survivalMinutes: 30, cause, lesson: '教訓', isNewRecord: false });
    },
    endStream: async () => { console.log('  [stream] 配信終了'); return ok(undefined); },
    isPlayerDead: () => false,
    saveState: () => {},
    getConfig: () => ({ cooldownMinutes: 0, maxDailyStreams: 20 }),
    getDailyStreamCount: () => 0,
    incrementDailyStreamCount: () => {},
    startCycleTimer: () => console.log('  [cycle] サイクルタイマー開始'),
    stopCycleTimer: () => console.log('  [cycle] サイクルタイマー停止'),
    log: (msg) => console.log(`  [orch] ${msg}`),
  };

  const manual = new Orchestrator(orchDeps, 'MANUAL');
  console.log(`  初期状態: ${manual.getState()}, モード: ${manual.getMode()}`);

  await manual.start();
  console.log(`  配信開始後: ${manual.getState()}`);

  await manual.onDeath('クリーパー');
  console.log(`  死亡後: ${manual.getState()} (MANUAL → IDLEで停止)`);

  sep('オーケストレーター AUTO モード');

  let autoStreamCount = 0;
  const autoDeps: OrchestratorDeps = {
    ...orchDeps,
    getDailyStreamCount: () => autoStreamCount,
    incrementDailyStreamCount: () => { autoStreamCount++; },
    log: (msg) => console.log(`  [orch] ${msg}`),
  };

  const auto = new Orchestrator(autoDeps, 'AUTO');
  await auto.start();
  console.log(`  配信開始: ${auto.getState()}, 日次配信数: ${autoStreamCount}`);

  await auto.onDeath('スケルトン');
  console.log(`  死亡→自動再開: ${auto.getState()}, 日次配信数: ${autoStreamCount}`);

  // 手動停止
  await auto.stop();
  console.log(`  手動停止: ${auto.getState()}`);

  sep('Slice 7 デモ完了 - 全スライス実装完了！');
})();
