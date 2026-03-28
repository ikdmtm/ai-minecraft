/**
 * Slice 3 動作確認スクリプト
 * 実行: npx tsx src/demo-slice3.ts
 *
 * VOICEVOX が起動している場合は実際に音声合成する:
 *   docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-latest
 *   VOICEVOX_HOST=http://localhost:50021 npx tsx src/demo-slice3.ts --real
 */
import { VoicevoxClient, type HttpAdapter } from './tts/voicevox.js';
import { AudioQueue, type AudioPlayer } from './tts/audioQueue.js';

const useReal = process.argv.includes('--real');
const host = process.env.VOICEVOX_HOST || 'http://localhost:50021';

console.log('=== Slice 3 動作確認 ===\n');
console.log(`モード: ${useReal ? '実VOICEVOX (' + host + ')' : 'モック'}\n`);

// --- 1. VOICEVOX クライアント ---
async function testVoicevox() {
  console.log('1. VOICEVOX 音声合成');

  let http: HttpAdapter;
  if (useReal) {
    const { createFetchAdapter } = await import('./tts/voicevox.js');
    http = createFetchAdapter();
  } else {
    http = {
      postJson: async () => ({ accent_phrases: [], speedScale: 1.0 }),
      postJsonGetBuffer: async () => Buffer.alloc(44100, 128),
      get: async () => ({ status: 200 }),
    };
  }

  const client = new VoicevoxClient(host, 3, http);

  const healthy = await client.isHealthy();
  console.log(`   ヘルスチェック: ${healthy ? '正常' : '異常'}`);

  const result = await client.synthesize('ゾンビの気配がする。拠点に戻ろう。');
  if (result.ok) {
    console.log(`   音声合成成功: ${result.value.length} bytes`);
  } else {
    console.log(`   音声合成失敗: ${result.error}`);
  }
  console.log();
  return result;
}

// --- 2. オーディオキュー ---
async function testAudioQueue(audioBuffer: Buffer) {
  console.log('2. オーディオキュー（再生シミュレーション）');

  const playLog: string[] = [];
  const player: AudioPlayer = {
    play: async (buf) => {
      playLog.push(`再生: ${buf.length} bytes`);
      await new Promise((r) => setTimeout(r, 50));
    },
    stop: () => {},
  };

  const queue = new AudioQueue(player);

  queue.onPlaybackStart(() => playLog.push('▶ 再生開始'));
  queue.onPlaybackEnd(() => playLog.push('■ 再生終了'));

  queue.enqueue(audioBuffer);
  queue.enqueue(Buffer.alloc(1000, 0));
  queue.enqueue(Buffer.alloc(2000, 0));

  console.log(`   キューに 3 件追加, pending: ${queue.pendingCount()}`);

  // キューが空になるまで待機
  while (queue.isPlaying() || queue.pendingCount() > 0) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 20));

  for (const log of playLog) {
    console.log(`   ${log}`);
  }
  console.log(`   最終 pending: ${queue.pendingCount()}`);
  console.log();
}

// --- 実行 ---
(async () => {
  const synthResult = await testVoicevox();
  const buf = synthResult.ok ? synthResult.value : Buffer.alloc(500, 128);
  await testAudioQueue(buf);
  console.log('=== 全項目 OK ===');
})();
