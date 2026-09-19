import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunRecorder, makeRedactor, runRecordedChild } from './runRecorder.js';

let root: string;
const recorders: RunRecorder[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gameplay-journal-test-')); });
afterEach(() => {
  for (const recorder of recorders.splice(0)) recorder.finish(0, null, 'test_cleanup');
  rmSync(root, { recursive: true, force: true });
});
function create(env: NodeJS.ProcessEnv = {}, output: (line: string) => void = () => {}) {
  const recorder = new RunRecorder(root, env, output); recorders.push(recorder); return recorder;
}
function manifest(recorder: RunRecorder) { return JSON.parse(readFileSync(join(recorder.directory, 'manifest.json'), 'utf8')); }
function events(recorder: RunRecorder) {
  return readFileSync(join(recorder.directory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('keeps independent run IDs and never calls an unfinished run a success', async () => {
  const first = create(), second = create();
  await first.prepare(); first.running(123);
  expect(first.runId).not.toBe(second.runId);
  expect(manifest(first)).toMatchObject({ phase: 'running', termination: null, code: { commit: null, exact_checkout: false } });
  expect(manifest(second)).toMatchObject({ phase: 'preparing', termination: null });
});

test('missing DB stays missing, and missing knowledge/seed are explicitly unknown', async () => {
  const recorder = create(); await recorder.prepare();
  expect(existsSync(join(root, 'data/gameplay.db'))).toBe(false);
  expect(manifest(recorder)).toMatchObject({ memory: { status: 'absent_at_start', snapshot: null },
    knowledge: { status: 'unavailable', version: null }, seed: { value: null, verified: false } });
});

test('backs up committed WAL records without resetting the live DB', async () => {
  const source = join(root, 'live.db');
  const live = new Database(source);
  try {
    live.pragma('journal_mode = WAL'); live.pragma('wal_autocheckpoint = 0');
    live.exec('CREATE TABLE evidence (value TEXT)'); live.prepare('INSERT INTO evidence VALUES (?)').run('retained experience');
    const recorder = create({ DB_PATH: source }); await recorder.prepare();
    expect(manifest(recorder).memory).toMatchObject({ status: 'snapshotted', snapshot: 'memory-start.sqlite' });
    expect(manifest(recorder).memory.sha256).toMatch(/^[a-f0-9]{64}$/);
    const backup = new Database(join(recorder.directory, 'memory-start.sqlite'), { readonly: true });
    try {
      expect(backup.prepare('SELECT * FROM evidence').all()).toEqual([{ value: 'retained experience' }]);
      live.prepare('INSERT INTO evidence VALUES (?)').run('later experience');
      expect(live.prepare('SELECT * FROM evidence').all()).toHaveLength(2);
      expect(backup.prepare('SELECT * FROM evidence').all()).toHaveLength(1);
    } finally { backup.close(); }
  } finally { live.close(); }
});

test('refuses to launch from an unreadable memory snapshot instead of pretending it is empty', async () => {
  writeFileSync(join(root, 'broken.db'), 'not a SQLite database');
  const recorder = create({ DB_PATH: 'broken.db' });
  await expect(recorder.prepare()).rejects.toThrow();
  expect(manifest(recorder).phase).toBe('preparing');
});

test('records the exact knowledge export and labels configured seed as unverified', async () => {
  mkdirSync(join(root, '.minecraft-dev/server'), { recursive: true });
  writeFileSync(join(root, '.minecraft-dev/server/server.properties'), 'server-port=25565\nlevel-seed=8675309\n');
  writeFileSync(join(root, 'facts.json'), JSON.stringify({ version: '1.21.4', recipes: { example: {} } }));
  const recorder = create({ GAMEPLAY_KNOWLEDGE_FILE: 'facts.json' }); await recorder.prepare();
  expect(manifest(recorder)).toMatchObject({ knowledge: { status: 'captured', version: '1.21.4' },
    seed: { value: '8675309', source: 'local_server_properties', verified: false } });
  expect(readFileSync(join(recorder.directory, 'knowledge-start.json'), 'utf8')).toBe(readFileSync(join(root, 'facts.json'), 'utf8'));
  const remote = create({ MINECRAFT_HOST: 'example.invalid' });
  expect(manifest(remote).seed.value).toBeNull();
});

test('redacts configured secrets, nested credential fields and bearer strings', async () => {
  const secret = 'test-private-value+/';
  const output: string[] = [];
  const recorder = create({ OPENAI_API_KEY: secret, SOMETHING_PRIVATE: 'not allowlisted' }, line => output.push(line));
  await recorder.prepare();
  recorder.record({ kind: 'error', details: { api_key: 'unknown-secret', authorization: 'other-secret' },
    message: `${secret} ${encodeURIComponent(secret)} Bearer mystery-token` });
  recorder.finish(1, null);
  const text = output.join('') + readFileSync(join(recorder.directory, 'manifest.json'), 'utf8');
  expect(text).not.toContain(secret); expect(text).not.toContain(encodeURIComponent(secret));
  expect(text).not.toContain('unknown-secret'); expect(text).not.toContain('mystery-token');
  expect(text).not.toContain('not allowlisted'); expect(text).toContain('[REDACTED]');
  expect(makeRedactor({ TOKEN: secret })(['safe', { password: secret }])).toEqual(['safe', { password: '[REDACTED]' }]);
});

test('correlates task, evidence and lookup events and separates intentional waits from stalls', async () => {
  const recorder = create(); await recorder.prepare();
  recorder.acceptLine(JSON.stringify({ kind: 'run_context', context: { world_id: 'w1', minecraft_version: '1.21.4', experience_session_id: 's1' } }), 'stdout');
  recorder.acceptLine(JSON.stringify({ kind: 'task_started', task_id: 7, task: 'LOOKUP_KNOWLEDGE', knowledge_query: 'furnace' }), 'stdout');
  recorder.acceptLine(JSON.stringify({ kind: 'operation_evidence', task_id: 8, evidence_id: 'e1', status: 'interrupted', effect_verified: false, run_id: 'spoof' }), 'stdout');
  recorder.acceptLine(JSON.stringify({ kind: 'state', task: { status: 'running', detail: 'waiting_for_condition' } }), 'stdout');
  recorder.acceptLine(JSON.stringify({ kind: 'gameplay_no_progress' }), 'stdout');
  recorder.acceptLine(JSON.stringify({ kind: 'game_event', event_type: 'executive_runtime_started', detail: 'provider=openai model=fixture-model mode=event_driven' }), 'stdout');
  recorder.acceptLine(JSON.stringify({ kind: 'shutdown', reason: 'death' }), 'stdout'); recorder.finish(0, null);
  const rows = events(recorder);
  expect(new Set(rows.map(row => row.run_id))).toEqual(new Set([recorder.runId]));
  expect(rows.map(row => row.sequence)).toEqual(rows.map((_, i) => i + 1));
  expect(rows.find(row => row.kind === 'operation_evidence')).toMatchObject({ evidence_id: 'e1', task_id: 8, effect_verified: false });
  expect(manifest(recorder)).toMatchObject({ runtime: { world_id: 'w1' }, effective_policy: { provider: 'openai', model: 'fixture-model' },
    counters: { intentional_wait_samples: 1, no_progress_events: 1 }, termination: { reason: 'death', clean_shutdown: true } });
});

test('records abrupt child exit and stderr without claiming a clean shutdown', async () => {
  const recorder = create(); await recorder.prepare();
  expect(await runRecordedChild(recorder, ['-e', 'console.log(JSON.stringify({kind:"fixture"})); console.error("fixture crash"); process.exitCode=23;'])).toBe(23);
  expect(manifest(recorder)).toMatchObject({ phase: 'finished', termination: { exit_code: 23, reason: 'exit_without_shutdown', clean_shutdown: false } });
  expect(events(recorder).find(row => row.message === 'fixture crash').stream).toBe('stderr');
});

test('handles split UTF-8/JSON lines and a trailing line without newline', async () => {
  const recorder = create(); await recorder.prepare();
  const program = 'const b=Buffer.from(JSON.stringify({kind:"fixture",text:"鶏を発見"})); process.stdout.write(b.subarray(0,32)); setTimeout(()=>process.stdout.write(b.subarray(32)),5);';
  expect(await runRecordedChild(recorder, ['-e', program])).toBe(0);
  expect(events(recorder).find(row => row.kind === 'fixture').text).toBe('鶏を発見');
  expect(manifest(recorder).termination.clean_shutdown).toBe(false);
});

test('records spawn failure with a finalized error result', async () => {
  const recorder = create(); await recorder.prepare();
  expect(await runRecordedChild(recorder, [], join(root, 'does-not-exist'))).toBe(1);
  expect(manifest(recorder).termination).toMatchObject({ reason: 'spawn_failed', clean_shutdown: false });
});

test('forwards stop signals, lets the child finalize, and removes signal listeners', async () => {
  const before = process.listenerCount('SIGTERM');
  let signalled = false;
  const recorder = create({}, line => {
    if (!signalled && JSON.parse(line).kind === 'fixture_ready') { signalled = true; process.emit('SIGTERM'); }
  });
  await recorder.prepare();
  const program = 'const timer=setInterval(()=>{},1000); process.on("SIGTERM",()=>{console.log(JSON.stringify({kind:"shutdown",reason:"SIGTERM"}));clearInterval(timer);}); console.log(JSON.stringify({kind:"fixture_ready"}));';
  expect(await runRecordedChild(recorder, ['-e', program])).toBe(0);
  expect(manifest(recorder).termination).toMatchObject({ reason: 'SIGTERM', clean_shutdown: true });
  expect(process.listenerCount('SIGTERM')).toBe(before);
}, 15000);

test('terminal callback failure does not lose the on-disk log', () => {
  const recorder = create({}, () => { throw new Error('broken output'); });
  recorder.record({ kind: 'fixture' }); recorder.finish(0, null);
  expect(events(recorder).some(row => row.kind === 'fixture')).toBe(true);
  expect(manifest(recorder).counters.console_output_errors).toBeGreaterThan(0);
});
