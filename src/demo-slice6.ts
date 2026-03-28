/**
 * Slice 6 デモ: ヘルスチェック + ダッシュボード
 *
 * 実行: npx tsx src/demo-slice6.ts
 * ブラウザ: http://localhost:8080
 */
import { HealthChecker, type HealthCheckTarget } from './health/checker.js';
import { RecoveryDispatcher, type RecoveryAction, type CommandExecutor } from './health/recovery.js';
import { startDashboard } from './dashboard/server.js';
import type { DashboardDeps } from './dashboard/routes.js';
import { ok, err } from './types/result.js';

function sep(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// ────── 1. ヘルスチェック ──────
sep('ヘルスチェック デモ');

let voicevoxUp = true;

const targets: HealthCheckTarget[] = [
  { name: 'minecraft-server', check: async () => true, failureThreshold: 3 },
  { name: 'voicevox', check: async () => voicevoxUp, failureThreshold: 2 },
  { name: 'llm-api', check: async () => true, failureThreshold: 5 },
];

const checker = new HealthChecker(targets, {
  onUnhealthy: (name, status) => {
    console.log(`  [ALERT] ${name} が異常です (失敗${status.consecutiveFailures}回)`);
  },
  onRecovered: (name) => {
    console.log(`  [RECOVERED] ${name} が復旧しました`);
  },
});

(async () => {
  await checker.runChecks();
  console.log('  初回チェック:', checker.isAllHealthy() ? '全て正常' : '異常あり');
  for (const s of checker.getStatuses()) {
    console.log(`    ${s.name}: ${s.healthy ? '● 正常' : '✕ 異常'}`);
  }

  // VOICEVOX を落とすシミュレーション
  console.log('\n  [シミュレーション] VOICEVOX ダウン...');
  voicevoxUp = false;
  await checker.runChecks(); // 1回目
  await checker.runChecks(); // 2回目 → 閾値到達

  console.log(`  全体: ${checker.isAllHealthy() ? '正常' : '異常あり'}`);

  // VOICEVOX 復旧
  console.log('\n  [シミュレーション] VOICEVOX 復旧...');
  voicevoxUp = true;
  await checker.runChecks();
  console.log(`  全体: ${checker.isAllHealthy() ? '全て正常' : '異常あり'}`);

  // ────── 2. 復旧ディスパッチ ──────
  sep('復旧アクション デモ');

  const actions: RecoveryAction[] = [
    { targetName: 'minecraft-server', command: 'systemctl restart minecraft-server' },
    { targetName: 'voicevox', command: 'docker restart voicevox' },
  ];

  const mockExecutor: CommandExecutor = {
    exec: async (cmd) => {
      console.log(`  [mock exec] ${cmd}`);
      return { success: true, output: 'ok' };
    },
  };

  const dispatcher = new RecoveryDispatcher(actions, mockExecutor, {
    cooldownMs: 100,
    onRecoveryAttempt: (name, cmd, success) => {
      console.log(`  [recovery] ${name}: ${cmd} → ${success ? '成功' : '失敗'}`);
    },
  });

  await dispatcher.recover('voicevox');
  const cooldownResult = await dispatcher.recover('voicevox');
  console.log(`  クールダウン中の再試行: ${cooldownResult.ok ? '許可' : cooldownResult.error}`);

  // ────── 3. ダッシュボード ──────
  sep('ダッシュボード起動');

  const dashDeps: DashboardDeps = {
    getStatus: () => ({
      state: 'LIVE_RUNNING',
      generation: 13,
      survivalMinutes: 83,
      bestRecordMinutes: 240,
      operationMode: 'MANUAL',
      dailyStreamCount: 2,
      healthStatuses: checker.getStatuses(),
    }),
    triggerStart: () => ok(undefined),
    triggerStop: () => ok(undefined),
    getLogs: () => [
      { timestamp: new Date().toISOString(), type: 'llm_response' as const, content: '鉄の剣が完成した。少し安心。' },
      { timestamp: new Date().toISOString(), type: 'llm_response' as const, content: 'あと鉄インゴット2個...' },
    ],
    getConfig: () => ({
      operationMode: 'MANUAL',
      cooldownMinutes: 10,
      maxDailyStreams: 20,
      streamTitleTemplate: '【AI Minecraft】星守レイのハードコア生存実験 #Gen{世代番号}',
    }),
    updateConfig: () => ok(undefined),
    getDeathHistory: () => [
      { generation: 12, survivalMinutes: 45, cause: 'クリーパー爆発', lesson: '夜は拠点に戻る', timestamp: '' },
      { generation: 11, survivalMinutes: 240, cause: 'スケルトン（洞窟）', lesson: '洞窟では盾を持つ', timestamp: '' },
    ],
  };

  const dashboard = startDashboard(8080, dashDeps);
  console.log('  ダッシュボード起動: http://localhost:8080');
  console.log('  5秒後に自動停止します...');

  setTimeout(() => {
    dashboard.close();
    console.log('  ダッシュボード停止');
    sep('Slice 6 デモ完了');
  }, 5000);
})();
