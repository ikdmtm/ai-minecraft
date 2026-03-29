/**
 * Slice 2 動作確認スクリプト
 * 実行: npx tsx src/demo-slice2.ts
 *
 * LLM API キーがなくてもモックで動作確認できる。
 * 実 API で試す場合: ANTHROPIC_API_KEY=sk-ant-xxx npx tsx src/demo-slice2.ts --real
 */
import { buildSystemPrompt, buildUserMessage } from './llm/promptBuilder.js';
import { parseResponse } from './llm/responseParser.js';
import { LLMClient, type LLMApiAdapter } from './llm/client.js';
import { CycleRunner, type CycleDeps } from './orchestrator/cycle.js';
import { mapSteps } from './bot/actionMapper.js';
import type { GameState } from './types/gameState.js';

console.log('=== Slice 2 動作確認 ===\n');

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

// --- 1. システムプロンプト ---
console.log('1. システムプロンプト（先頭200文字）');
const sysPrompt = buildSystemPrompt();
console.log('   ', sysPrompt.substring(0, 200) + '...');
console.log('   文字数:', sysPrompt.length);
console.log();

// --- 2. ユーザーメッセージ ---
console.log('2. ユーザーメッセージ（LLM入力JSON）');
const userMsg = buildUserMessage(gameState);
const parsed = JSON.parse(userMsg);
console.log('   player.hp:', parsed.player.hp);
console.log('   world.time_of_day:', parsed.world.time_of_day);
console.log('   pacing.survival_time_minutes:', parsed.pacing.survival_time_minutes);
console.log('   memory.total_deaths:', parsed.memory.total_deaths);
console.log('   JSON 長さ:', userMsg.length, '文字');
console.log();

// --- 3. レスポンスパース ---
console.log('3. レスポンスパース（モック応答）');
const mockLLMResponse = JSON.stringify({
  action: {
    goal: '拠点に戻って就寝する',
    reason: '夜になりゾンビが近くにいる。安全を確保する',
    steps: ['拠点へ帰還する', 'ベッドで寝る', '朝になったら採掘を再開する'],
  },
  commentary: '...ゾンビの気配がする。夜の洞窟は危険だし、一度拠点に戻ろう。鉄はあと少しだけど、死んだら全部終わりだから。',
  current_goal_update: null,
  threat_level: 'medium',
});

const parseResult = parseResponse(mockLLMResponse);
if (parseResult.ok) {
  console.log('   パース成功');
  console.log('   goal:', parseResult.value.action.goal);
  console.log('   steps:', parseResult.value.action.steps);
  console.log('   commentary:', parseResult.value.commentary);
  console.log('   threatLevel:', parseResult.value.threatLevel);
} else {
  console.log('   パース失敗:', parseResult.error);
}
console.log();

// --- 4. アクションマッピング ---
console.log('4. steps → アクションマッピング');
if (parseResult.ok) {
  const mapped = mapSteps(parseResult.value.action.steps);
  for (const action of mapped) {
    console.log(`   ${action.originalStep} → ${action.type}`, JSON.stringify(action.params));
  }
}
console.log();

// --- 5. 1サイクル実行（全モック） ---
console.log('5. 1サイクル実行（CycleRunner, 全モック）');
const mockAdapter: LLMApiAdapter = {
  call: async () => mockLLMResponse,
};
const client = new LLMClient(mockAdapter);

const deps: CycleDeps = {
  getGameState: () => gameState,
  callLLM: (state) => client.call(state),
  executeSteps: async (steps) => console.log('   [実行]', steps.join(' → ')),
  speakCommentary: async (text) => console.log('   [発話]', text),
  updateOverlay: (update) => console.log('   [UI更新]', JSON.stringify(update)),
  updateAvatar: (threat, speaking) => console.log(`   [アバター] 脅威=${threat} 発話=${speaking}`),
  triggerAvatarSpecial: (expr) => console.log(`   [アバター特殊] ${expr}`),
  logAction: (entry) => console.log('   [ログ]', entry.type, entry.content.substring(0, 80)),
};

const runner = new CycleRunner(deps);
runner.runOneCycle().then((result) => {
  if (result.ok) {
    console.log('\n   サイクル完了 ✓');
    console.log('   previousPlan:', JSON.stringify(runner.getPreviousPlan()));
  } else {
    console.log('\n   サイクル失敗:', result.error);
  }
  console.log('\n=== 全項目 OK ===');
});
