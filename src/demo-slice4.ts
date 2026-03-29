/**
 * Slice 4 デモ: 映像配信パイプライン（アバター・オーバーレイ・FFmpeg）
 *
 * 実行: npx tsx src/demo-slice4.ts
 */
import { AvatarState } from './stream/avatar.js';
import { buildOverlayData, type OverlayInput } from './stream/overlay.js';
import { FFmpegManager, buildFFmpegArgs, type FFmpegConfig, type ProcessSpawner } from './stream/ffmpeg.js';

function sep(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// ────── 1. アバター表情デモ ──────
sep('アバター表情デモ');

const avatar = new AvatarState();
const threatLevels = ['low', 'medium', 'high', 'critical'] as const;

for (const t of threatLevels) {
  avatar.update({ threatLevel: t, isSpeaking: false });
  console.log(`  脅威: ${t.padEnd(8)} → 表情: ${avatar.getExpression().padEnd(8)} | 画像: ${avatar.getImagePath('assets/avatar')}`);
}

console.log('\n  [リップシンク]');
avatar.update({ threatLevel: 'medium', isSpeaking: true });
for (let i = 0; i < 6; i++) {
  avatar.tick();
  console.log(`    tick ${i + 1}: mouth=${avatar.isMouthOpen() ? 'OPEN ' : 'CLOSE'} → ${avatar.getImagePath('assets/avatar')}`);
}

console.log('\n  [特殊表情: happy (1秒)]');
avatar.triggerSpecial('happy', 1000);
console.log(`    現在: ${avatar.getExpression()}`);

avatar.destroy();

// ────── 2. オーバーレイデモ ──────
sep('オーバーレイ描画データ生成');

const scenarios: OverlayInput[] = [
  {
    survivalTimeMinutes: 0,
    bestRecordMinutes: 0,
    currentGoal: '木を集めて最初の拠点を作る',
    threatLevel: 'low',
    commentary: 'さて、新しい世界だ。まずは木を切ろう。',
    generation: 1,
  },
  {
    survivalTimeMinutes: 87,
    bestRecordMinutes: 240,
    currentGoal: 'ダイヤモンド装備を完成させる',
    threatLevel: 'high',
    commentary: 'クリーパーの音が聞こえる…。慎重に行かないと。',
    generation: 5,
  },
  {
    survivalTimeMinutes: 1440,
    bestRecordMinutes: 1440,
    currentGoal: 'エンダードラゴン討伐準備',
    threatLevel: 'critical',
    commentary: 'あ'.repeat(200), // 長文切り詰めテスト
    generation: 12,
  },
];

for (const [i, scenario] of scenarios.entries()) {
  const data = buildOverlayData(scenario);
  console.log(`\n  シナリオ ${i + 1}:`);
  console.log(`    ${data.generation} | 生存: ${data.survivalTime} | 最高: ${data.bestRecord}`);
  console.log(`    目標: ${data.currentGoal}`);
  console.log(`    脅威: ${data.threatLabel} (${data.threatColor})`);
  console.log(`    字幕: ${data.commentary.slice(0, 50)}${data.commentary.length > 50 ? '…' : ''}`);
}

// ────── 3. FFmpeg コマンド引数デモ ──────
sep('FFmpeg コマンド引数生成');

const ffmpegConfig: FFmpegConfig = {
  display: ':99',
  resolution: '1280x720',
  fps: 24,
  videoBitrate: '3000k',
  audioBitrate: '128k',
  rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2/xxxx-xxxx-xxxx',
  pulseAudioSource: 'combined_sink.monitor',
  avatarBasePath: 'assets/avatar',
  avatarPipePath: '/tmp/ai-minecraft-avatar.pipe',
  avatarWidth: 300,
  avatarHeight: 400,
  avatarFps: 5,
};

const args = buildFFmpegArgs(ffmpegConfig);
console.log(`  ffmpeg ${args.join(' \\\n    ')}`);

// ────── 4. FFmpeg プロセス管理デモ（モック） ──────
sep('FFmpeg プロセス管理（モック）');

const mockSpawner: ProcessSpawner = {
  spawn: (_cmd, _args) => {
    console.log('  [mock] FFmpeg プロセス起動');
    return {
      pid: 99999,
      kill: (sig?: string) => {
        console.log(`  [mock] kill(${sig})`);
        return true;
      },
      on: (event: string, cb: (...args: any[]) => void) => {
        if (event === 'exit') {
          setTimeout(() => {
            console.log('  [mock] プロセス exit(0)');
            cb(0);
          }, 500);
        }
      },
      stderr: { on: () => {} },
    };
  },
};

const manager = new FFmpegManager(ffmpegConfig, mockSpawner, {
  onExit: (code) => console.log(`  [callback] onExit(${code})`),
});

console.log(`  running: ${manager.isRunning()}`);
manager.start();
console.log(`  running: ${manager.isRunning()} | pid: ${manager.getPid()}`);

manager.updateOverlayText('ゾンビの気配がする');
manager.updateAvatarImage('assets/avatar/sad_open.png');
console.log(`  overlay: ${manager.getCurrentOverlay()}`);
console.log(`  avatar:  ${manager.getCurrentAvatar()}`);

setTimeout(() => {
  console.log(`\n  (500ms後) running: ${manager.isRunning()}`);
  sep('Slice 4 デモ完了');
}, 600);
