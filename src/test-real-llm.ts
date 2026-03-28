/**
 * LLM API 実機テスト
 * 実行: npx tsx src/test-real-llm.ts
 */
import { config } from 'dotenv';
config();

import { LLMClient, type LLMApiAdapter } from './llm/client.js';
import { parseResponse } from './llm/responseParser.js';
import { mapSteps } from './bot/actionMapper.js';
import type { GameState } from './types/gameState.js';

const provider = process.env.LLM_PROVIDER || 'anthropic';
const apiKey = provider === 'anthropic'
  ? process.env.ANTHROPIC_API_KEY
  : process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error('API キーが設定されていません。.env を確認してください。');
  process.exit(1);
}

console.log(`=== LLM 実機テスト (${provider}) ===\n`);

function createRealAdapter(): LLMApiAdapter {
  if (provider === 'anthropic') {
    return {
      async call(systemPrompt: string, userMessage: string): Promise<string> {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey!,
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

        const data = await res.json() as any;
        return data.content[0].text;
      },
    };
  }

  throw new Error(`未対応プロバイダ: ${provider}`);
}

const gameState: GameState = {
  player: {
    hp: 16, maxHp: 20, hunger: 18,
    position: { x: 120, y: 64, z: -45 }, biome: 'forest',
    equipment: { hand: 'iron_sword', helmet: null, chestplate: 'iron_chestplate', leggings: null, boots: null },
    inventorySummary: ['cobblestone x64', 'iron_ingot x3', 'bread x8', 'coal x15'],
  },
  world: {
    timeOfDay: 'night', minecraftTime: 18200, weather: 'clear', lightLevel: 4,
    nearbyEntities: [{ type: 'zombie', distance: 12, direction: 'north' }],
    nearbyBlocksOfInterest: [{ type: 'iron_ore', distance: 6, direction: 'below' }],
  },
  base: { known: true, position: { x: 115, y: 64, z: -40 }, distance: 7, hasBed: true, hasFurnace: true, hasCraftingTable: true },
  pacing: { currentActionCategory: 'mining', categoryDurationMinutes: 12, survivalTimeMinutes: 87, progressPhase: 'stable', bestRecordMinutes: 240 },
  previousPlan: { goal: '鉄鉱石を採掘して鉄装備を完成させる', status: 'in_progress', progress: '鉄インゴット3個取得' },
  recentEvents: [{ time: '2min_ago', event: 'reactive_flee', detail: 'クリーパー接近により一時退避' }],
  stagnationWarning: false,
  memory: {
    totalDeaths: 5, bestRecordMinutes: 240,
    recentDeaths: [
      { generation: 5, survivalMinutes: 45, cause: 'クリーパー爆発', lesson: '夜は拠点に戻る' },
      { generation: 4, survivalMinutes: 240, cause: 'スケルトンの弓', lesson: '洞窟では盾を持つ' },
    ],
  },
};

(async () => {
  try {
    // テスト1: LLMClient 経由で GameState → LLMOutput
    console.log('--- テスト1: ゲーム状況を渡して行動を決定 ---');
    const adapter = createRealAdapter();
    const client = new LLMClient(adapter);

    const t0 = Date.now();
    const result = await client.call(gameState);
    const elapsed = Date.now() - t0;

    if (!result.ok) {
      console.error(`  失敗: ${result.error}`);
      process.exit(1);
    }

    const output = result.value;
    console.log(`  応答時間: ${elapsed}ms`);
    console.log(`  目標:  ${output.action.goal}`);
    console.log(`  理由:  ${output.action.reason}`);
    console.log(`  ステップ: ${output.action.steps.join(' → ')}`);
    console.log(`  実況:  ${output.commentary}`);
    console.log(`  脅威:  ${output.threatLevel}`);

    // ステップをアクションにマッピング
    const mapped = mapSteps(output.action.steps);
    console.log('\n  アクションマッピング:');
    for (const a of mapped) {
      console.log(`    ${a.originalStep} → ${a.type} ${JSON.stringify(a.params)}`);
    }

    // テスト2: 死亡教訓生成
    console.log('\n--- テスト2: 死亡教訓の生成 ---');
    const t1 = Date.now();
    const lessonResult = await client.generateDeathLesson({
      position: { x: 120, y: 30, z: -45 },
      cause: '溶岩に落ちた',
      recentActions: [
        { time: '30s_ago', event: 'mining', detail: 'Y=30付近でダイヤモンド鉱石を探していた' },
        { time: '10s_ago', event: 'block_break', detail: '足元のブロックを壊した' },
      ],
      survivalMinutes: 120,
    });
    const elapsed2 = Date.now() - t1;

    if (lessonResult.ok) {
      console.log(`  応答時間: ${elapsed2}ms`);
      console.log(`  教訓:  ${lessonResult.value}`);
    } else {
      console.error(`  失敗: ${lessonResult.error}`);
    }

    console.log('\n=== LLM 実機テスト完了 ===');
  } catch (e) {
    console.error('予期せぬエラー:', e);
    process.exit(1);
  }
})();
