import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import mineflayer from 'mineflayer';
import { attachClientReadiness } from '../src/gameplay/clientReadiness.js';
import { prepareIsolatedEvaluation, runIsolatedEvaluation } from '../src/gameplay/evaluationRunner.js';

/** No policy/planner is instantiated by the child. This checks launcher wiring,
 * a real Minecraft connection, isolated DB writes and cleanup, NOT autonomous play.
 */
function fixtureChild(): void {
  const bot = mineflayer.createBot({ host: process.env.MINECRAFT_HOST!,
    port: Number(process.env.MINECRAFT_PORT), username: process.env.BOT_USERNAME!, version: '1.21.4' });
  const detach = attachClientReadiness(bot);
  let spawned = false;
  const timer = setTimeout(() => { process.exitCode = 1; bot.quit(); }, 20000);
  bot.on('error', () => { process.exitCode = 1; bot.quit(); });
  bot.once('spawn', () => {
    const db = new Database(process.env.DB_PATH!);
    try {
      assert.deepEqual(db.prepare('SELECT value FROM isolated_sentinel').all(), [{ value: 'preserved' }]);
      db.prepare('INSERT INTO isolated_sentinel VALUES (?)').run('test-only');
      spawned = true;
      console.log(JSON.stringify({ kind: 'evaluation_fixture_spawned', fixture: true,
        dimension: bot.game.dimension, world_label: process.env.GAMEPLAY_WORLD_ID }));
    } catch (error) { process.exitCode = 1; console.error(error); }
    finally { db.close(); clearTimeout(timer); bot.quit(); }
  });
  bot.once('end', () => {
    clearTimeout(timer); detach();
    if (!spawned) process.exitCode = 1;
    console.log(JSON.stringify({ kind: 'shutdown', reason: spawned ? 'repository_fixture_complete' : 'repository_fixture_failed' }));
  });
}
async function smoke(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-smoke-source-'));
  const sourcePath = join(root, 'memory.sqlite');
  const source = new Database(sourcePath);
  source.exec('CREATE TABLE isolated_sentinel(value TEXT)');
  source.prepare('INSERT INTO isolated_sentinel VALUES (?)').run('preserved');
  let directory: string | undefined;
  try {
    const p = await prepareIsolatedEvaluation(process.cwd(), { ...process.env,
      POLICY_PROVIDER: 'openai', OPENAI_API_KEY: 'fixture-not-a-real-key', TYPESAFE_API_KEY: '',
      DB_PATH: sourcePath, MINECRAFT_HOST: 'must-not-connect.invalid', MINECRAFT_PORT: '25565',
    }, { durationMs: 30000 });
    directory = p.directory;
    const result = await runIsolatedEvaluation(p, false, { label: 'real-server-connect-and-isolated-db',
      args: ['--import', 'tsx', resolve('scripts/evaluation-smoke.ts'), '--fixture-child'] });
    assert.equal(result, 0, JSON.stringify(p.report));
    assert.equal(p.report.accepted, false);
    assert.equal(p.report.liveModelInvoked, false);
    assert.equal(p.report.serverClosed, true);
    assert.equal(p.report.executionMode, 'repository_process_fixture');
    assert.deepEqual(source.prepare('SELECT value FROM isolated_sentinel').all(), [{ value: 'preserved' }]);
    const copy = new Database(p.env.DB_PATH!, { readonly: true });
    try { assert.equal((copy.prepare('SELECT count(*) AS n FROM isolated_sentinel').get() as { n: number }).n, 2); }
    finally { copy.close(); }
    const manifest = JSON.parse(readFileSync(join(p.env.GAMEPLAY_RUN_DIR!, String(p.report.runId), 'manifest.json'), 'utf8'));
    assert.equal(manifest.termination.reported_shutdown, 'repository_fixture_complete');
    const journal = readFileSync(join(p.env.GAMEPLAY_RUN_DIR!, String(p.report.runId), 'events.jsonl'), 'utf8');
    assert.ok(journal.includes('evaluation_fixture_spawned'));
    assert.ok(!journal.includes('fixture-not-a-real-key'));
    console.log('ISOLATED_EVALUATION_LAUNCHER_PASSED: real-server connection, copied memory, recorded child, owned server cleanup; no LLM');
    writeFileSync('data/evaluation-launcher-smoke.json', JSON.stringify({ ...p.report,
      proof: 'launcher_fixture_only', originalSourceRetained: true }, null, 2));
  } catch (error) {
    if (directory) console.error('EVALUATION_DIAGNOSTICS_DIRECTORY=' + directory);
    throw error;
  } finally { source.close(); rmSync(root, { recursive: true, force: true }); }
}
if (process.argv.includes('--fixture-child')) fixtureChild();
else void smoke().catch(error => { console.error(error); process.exitCode = 1; });
