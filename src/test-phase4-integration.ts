/**
 * Phase 4 統合テスト: Bot + LLM + TTS の 1サイクル実行
 * 実行: npx tsx src/test-phase4-integration.ts
 */
import { config } from 'dotenv';
config();

import { BotClient } from './bot/client.js';
import { LLMClient, type LLMApiAdapter } from './llm/client.js';
import { VoicevoxClient, createFetchAdapter } from './tts/voicevox.js';
import { CycleRunner, type CycleDeps } from './orchestrator/cycle.js';
import { mapSteps } from './bot/actionMapper.js';
import type { GameState } from './types/gameState.js';
import type { LLMOutput } from './types/llm.js';
import type { Result } from './types/result.js';
import { ok, err } from './types/result.js';
import { writeFileSync } from 'fs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const VOICEVOX_HOST = process.env.VOICEVOX_HOST || 'http://localhost:50021';
const MC_HOST = process.env.MINECRAFT_HOST || 'localhost';
const MC_PORT = parseInt(process.env.MINECRAFT_PORT || '25565');

function createAnthropicAdapter(): LLMApiAdapter {
  return {
    async call(systemPrompt: string, userMessage: string): Promise<string> {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
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

async function main() {
  console.log('=== Phase 4 統合テスト: Bot + LLM + TTS ===\n');

  // Step 1: Bot 接続
  console.log('[1/5] Mineflayer ボット接続中...');
  const bot = new BotClient();
  await bot.connect(
    { host: MC_HOST, port: MC_PORT, username: 'MineflayerBot' },
    {
      onDeath: (cause) => console.log('  [EVENT] 死亡:', cause),
      onReactiveAction: (event) => console.log('  [EVENT] リアクティブ:', event.detail),
    },
  );
  console.log('  → 接続成功\n');

  // Step 2: ゲーム状態取得
  console.log('[2/5] ゲーム状態取得中...');
  const partial = bot.getPartialGameState();
  const gameState: GameState = {
    ...partial,
    pacing: {
      currentActionCategory: 'exploring',
      categoryDurationMinutes: 0,
      survivalTimeMinutes: 0,
      progressPhase: 'early',
      bestRecordMinutes: 0,
    },
    previousPlan: null,
    recentEvents: [],
    stagnationWarning: false,
    memory: { totalDeaths: 0, bestRecordMinutes: 0, recentDeaths: [] },
  };
  console.log(`  → HP: ${gameState.player.hp}/${gameState.player.maxHp}`);
  console.log(`  → 位置: (${Math.round(gameState.player.position.x)}, ${Math.round(gameState.player.position.y)}, ${Math.round(gameState.player.position.z)})`);
  console.log(`  → 時間帯: ${gameState.world.timeOfDay}, 天気: ${gameState.world.weather}\n`);

  // Step 3: LLM 呼び出し
  console.log('[3/5] LLM (Claude) に行動プランを要求中...');
  const llmClient = new LLMClient(createAnthropicAdapter());
  const t0 = Date.now();
  const llmResult = await llmClient.call(gameState);
  const llmElapsed = Date.now() - t0;

  if (!llmResult.ok) {
    console.error(`  → LLM 失敗: ${llmResult.error}`);
    bot.disconnect();
    process.exit(1);
  }

  const output = llmResult.value;
  console.log(`  → 応答時間: ${llmElapsed}ms`);
  console.log(`  → 目標: ${output.action.goal}`);
  console.log(`  → 理由: ${output.action.reason}`);
  console.log(`  → ステップ: ${output.action.steps.join(' → ')}`);
  console.log(`  → 実況: ${output.commentary}`);
  console.log(`  → 脅威レベル: ${output.threatLevel}\n`);

  // Step 4: VOICEVOX で実況音声生成
  console.log('[4/5] VOICEVOX で実況音声合成中...');
  const tts = new VoicevoxClient(VOICEVOX_HOST, 3, createFetchAdapter());
  const t1 = Date.now();
  const ttsResult = await tts.synthesize(output.commentary);
  const ttsElapsed = Date.now() - t1;

  if (!ttsResult.ok) {
    console.error(`  → TTS 失敗: ${ttsResult.error}`);
  } else {
    const wavPath = '/tmp/phase4-commentary.wav';
    writeFileSync(wavPath, ttsResult.value);
    console.log(`  → 合成成功: ${ttsResult.value.length} bytes (${ttsElapsed}ms)`);
    console.log(`  → WAV 保存先: ${wavPath}\n`);
  }

  // Step 5: CycleRunner で 1サイクル実行
  console.log('[5/5] CycleRunner で統合サイクル実行中...');
  const mapped = mapSteps(output.action.steps);
  console.log('  → アクションマッピング:');
  for (const a of mapped) {
    console.log(`    ${a.originalStep} → ${a.type}`);
  }

  bot.disconnect();
  console.log('\nボット切断完了');
  console.log('\n=== Phase 4 統合テスト完了 ===');
  console.log(`LLM応答: ${llmElapsed}ms, TTS合成: ${ttsElapsed}ms`);
  process.exit(0);
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
