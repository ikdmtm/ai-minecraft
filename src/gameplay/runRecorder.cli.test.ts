import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** Tests the same entrypoint as npm run start:gameplay, without credentials or a Minecraft connection. */
function launch(root: string, db: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', resolve('src/gameplay/runRecorder.ts')], {
    cwd: process.cwd(), timeout: 15000, encoding: 'utf8',
    env: { ...process.env, OPENAI_API_KEY: '', TYPESAFE_API_KEY: '',
      DB_PATH: db, GAMEPLAY_RUN_DIR: join(root, 'runs'),
      GAMEPLAY_KNOWLEDGE_FILE: join(root, 'missing-knowledge.json'), GAMEPLAY_VIEWER_ENABLED: 'false' },
  });
}
function readRun(root: string) {
  const names = readdirSync(join(root, 'runs'));
  expect(names).toHaveLength(1);
  const dir = join(root, 'runs', names[0]);
  return { manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
    events: readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

test('normal CLI captures missing-credential failure with no game initialization', () => {
  const root = mkdtempSync(join(tmpdir(), 'gameplay-cli-test-'));
  try {
    const result = launch(root, join(root, 'not-created.db'));
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    const run = readRun(root);
    expect(run.manifest).toMatchObject({ phase: 'finished', runtime: {}, termination: { exit_code: 1, clean_shutdown: false } });
    expect(run.events.some(row => String(row.message).includes('OPENAI_API_KEY is required'))).toBe(true);
    expect(run.events.some(row => row.kind === 'run_context')).toBe(false);
    expect(new Set(run.events.map(row => row.run_id))).toEqual(new Set([run.manifest.run_id]));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);

test('normal CLI refuses a corrupt memory DB before spawning gameplay', () => {
  const root = mkdtempSync(join(tmpdir(), 'gameplay-cli-test-'));
  try {
    const path = join(root, 'broken.db'); writeFileSync(path, 'not a database');
    const result = launch(root, path);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    const run = readRun(root);
    expect(run.manifest).toMatchObject({ phase: 'finished', termination: { reason: 'preparation_failed', clean_shutdown: false } });
    expect(run.events.some(row => String(row.message).startsWith('memory_snapshot_failed:'))).toBe(true);
    expect(run.events.some(row => row.kind === 'run_started')).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('not a database');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);
