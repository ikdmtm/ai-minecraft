/**
 * Slice 0 動作確認スクリプト
 * 実行: npx tsx src/demo-slice0.ts
 */
import { openInMemoryDatabase } from './db/database.js';
import { runMigrations } from './db/schema.js';
import { Repository } from './db/repository.js';
import { loadEnvConfig } from './config/loader.js';

console.log('=== Slice 0 動作確認 ===\n');

// --- DB ---
console.log('1. SQLite DB を作成');
const db = openInMemoryDatabase();
runMigrations(db);
const repo = new Repository(db);
console.log('   → OK\n');

console.log('2. 初期状態の読み取り');
const state = repo.getState();
console.log('   state:', JSON.stringify(state, null, 2));
console.log();

console.log('3. 状態を更新');
repo.saveState({ currentGeneration: 1, currentState: 'LIVE_RUNNING', survivalStartTime: new Date().toISOString() });
const updated = repo.getState();
console.log('   updated:', JSON.stringify(updated, null, 2));
console.log();

console.log('4. 死亡記録を追加');
repo.addDeathRecord({ generation: 1, survivalMinutes: 45, cause: 'クリーパー爆発', lesson: '夜は拠点に戻る' });
repo.addDeathRecord({ generation: 2, survivalMinutes: 120, cause: 'スケルトンの弓', lesson: '洞窟では盾を持つ' });
const deaths = repo.getRecentDeaths(5);
console.log('   deaths:', JSON.stringify(deaths, null, 2));
console.log('   best record:', repo.getBestRecord(), '分');
console.log();

console.log('5. 設定の読み書き');
const defaultConfig = repo.getConfig();
console.log('   default config:', JSON.stringify(defaultConfig, null, 2));
repo.updateConfig({ cooldownMinutes: 15, llmModel: 'claude-opus' });
const updatedConfig = repo.getConfig();
console.log('   updated config:', JSON.stringify(updatedConfig, null, 2));
console.log();

// --- Config Loader ---
console.log('6. 環境変数バリデーション（正常系）');
const good = loadEnvConfig({
  LLM_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  MINECRAFT_HOST: 'localhost',
  MINECRAFT_PORT: '25565',
  VOICEVOX_HOST: 'http://localhost:50021',
  DB_PATH: './data/state.db',
  DASHBOARD_PORT: '8080',
});
console.log('   result:', good.ok ? 'OK' : 'NG');
if (good.ok) console.log('   value:', JSON.stringify(good.value, null, 2));
console.log();

console.log('7. 環境変数バリデーション（異常系：ポートが文字列）');
const bad = loadEnvConfig({
  LLM_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  MINECRAFT_HOST: 'localhost',
  MINECRAFT_PORT: 'abc',
  VOICEVOX_HOST: 'http://localhost:50021',
  DB_PATH: './data/state.db',
  DASHBOARD_PORT: '8080',
});
console.log('   result:', bad.ok ? 'OK' : 'NG');
if (!bad.ok) console.log('   error:', bad.error);
console.log();

db.close();
console.log('=== 全項目 OK ===');
