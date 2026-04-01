/**
 * Slice 5 デモ: YouTube 配信 + 状態機械
 *
 * 実行: npx tsx src/demo-slice5.ts
 */
import { buildStreamTitle, buildStreamDescription, buildTags, buildThumbnailCommand } from './youtube/metadata.js';
import { YouTubeClient, type YouTubeApiAdapter, type BroadcastCreateResult } from './youtube/api.js';
import { StateMachine } from './orchestrator/stateMachine.js';

function sep(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// ────── 1. メタデータ生成 ──────
sep('YouTube メタデータ生成');

const title = buildStreamTitle({
  generation: 7,
  template: '【AI Minecraft】星守レイのハードコア生存実験 #Gen{世代番号}',
});
console.log(`  タイトル: ${title}`);

const description = buildStreamDescription({
  generation: 7,
  bestRecordMinutes: 240,
  totalDeaths: 6,
  descriptionTemplate: `🎮 AI VTuber「星守レイ」が Minecraft ハードコアモードに挑戦中！
現在: 第{世代番号}世代 ｜ 最高記録: {最高記録}
累計死亡: {累計死亡}回`,
});
console.log(`  概要欄:\n${description.split('\n').map(l => `    ${l}`).join('\n')}`);

const tags = buildTags();
console.log(`  タグ: ${tags.join(', ')}`);

// ────── 2. サムネイルコマンド ──────
sep('サムネイル生成コマンド（ImageMagick）');

const thumbCmd = buildThumbnailCommand({
  backgroundPath: 'assets/thumbnail/bg.png',
  avatarPath: 'assets/thumbnail/rei.png',
  outputPath: '/tmp/thumbnail_gen7.png',
  generation: 7,
  isNewRecord: true,
  fontPath: 'assets/fonts/NotoSansJP-Bold.ttf',
});
console.log(`  ${thumbCmd.command} \\\n    ${thumbCmd.args.join(' \\\n    ')}`);

// ────── 3. YouTube API クライアント（モック） ──────
sep('YouTube API クライアント（モック）');

const mockAdapter: YouTubeApiAdapter = {
  async createBroadcast(params) {
    console.log(`  [mock] 配信枠作成: "${params.title}"`);
    return {
      broadcastId: 'bc-abc123',
      streamId: 'st-xyz789',
      streamKey: 'a1b2-c3d4-e5f6-g7h8',
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
    };
  },
  async transitionBroadcast(id, status) {
    console.log(`  [mock] 配信遷移: ${id} → ${status}`);
  },
  async updateBroadcast(id, update) {
    console.log(`  [mock] 配信更新: ${id}`, update);
  },
  async endBroadcast(id) {
    console.log(`  [mock] 配信終了: ${id}`);
  },
  async uploadThumbnail(id, path) {
    console.log(`  [mock] サムネアップロード: ${id} ← ${path}`);
  },
  async getStreamStatus() {
    return 'active';
  },
  async getBroadcastStatus() {
    return 'testing';
  },
};

(async () => {
  const yt = new YouTubeClient(mockAdapter);

  const createResult = await yt.createLiveBroadcast({
    title,
    description,
    tags,
    categoryId: '20',
  });
  if (createResult.ok) {
    console.log(`  broadcastId: ${createResult.value.broadcastId}`);
    console.log(`  streamKey:   ${createResult.value.streamKey}`);

    await yt.uploadThumbnail(createResult.value.broadcastId, '/tmp/thumbnail_gen7.png');
    await yt.goLive(createResult.value.broadcastId);

    const healthy = await yt.isHealthy(createResult.value.streamId);
    console.log(`  ストリーム状態: ${healthy ? '正常' : '異常'}`);

    await yt.updateTitle(createResult.value.broadcastId, title + ' 🔥記録更新中！');
    await yt.endBroadcast(createResult.value.broadcastId);
  }

  // ────── 4. 状態機械デモ ──────
  sep('オーケストレーター状態機械');

  console.log('\n  --- MANUAL モード: 配信→死亡→IDLE ---');
  const manual = new StateMachine('IDLE', 'MANUAL');
  manual.onTransition((from, to, event) => {
    console.log(`    ${from} → ${to}  (${event.type})`);
  });

  manual.transition({ type: 'START_TRIGGERED' });
  manual.transition({ type: 'BOOT_COMPLETE' });
  manual.transition({ type: 'STREAM_READY' });
  manual.transition({ type: 'DEATH_DETECTED', cause: 'クリーパー爆発' });
  manual.transition({ type: 'STREAM_ENDED' });
  manual.transition({ type: 'COOLDOWN_EXPIRED' });
  console.log(`    最終状態: ${manual.getState()}`);

  console.log('\n  --- AUTO モード: 配信→死亡→クールダウン→次の配信 ---');
  const auto = new StateMachine('IDLE', 'AUTO');
  auto.onTransition((from, to, event) => {
    console.log(`    ${from} → ${to}  (${event.type})`);
  });

  auto.transition({ type: 'START_TRIGGERED' });
  auto.transition({ type: 'BOOT_COMPLETE' });
  auto.transition({ type: 'STREAM_READY' });
  auto.transition({ type: 'DEATH_DETECTED', cause: 'ゾンビ' });
  auto.transition({ type: 'STREAM_ENDED' });
  auto.transition({ type: 'COOLDOWN_EXPIRED' });
  auto.transition({ type: 'NEXT_STREAM_CREATED' });
  auto.transition({ type: 'START_TRIGGERED' });
  console.log(`    最終状態: ${auto.getState()}`);

  console.log('\n  --- AUTO モード: 日次上限到達 ---');
  const autoLimit = new StateMachine('COOL_DOWN', 'AUTO');
  autoLimit.onTransition((from, to, event) => {
    console.log(`    ${from} → ${to}  (${event.type})`);
  });
  autoLimit.transition({ type: 'DAILY_LIMIT_REACHED' });
  console.log(`    最終状態: ${autoLimit.getState()}`);

  console.log('\n  --- STOP シグナル ---');
  const stopTest = new StateMachine('IDLE', 'MANUAL');
  stopTest.onTransition((from, to, event) => {
    console.log(`    ${from} → ${to}  (${event.type})`);
  });
  stopTest.transition({ type: 'START_TRIGGERED' });
  stopTest.transition({ type: 'BOOT_COMPLETE' });
  stopTest.transition({ type: 'STREAM_READY' });
  stopTest.transition({ type: 'STOP_TRIGGERED' });
  console.log(`    最終状態: ${stopTest.getState()}`);

  sep('Slice 5 デモ完了');
})();
