import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Evidence, LearnedProcedure } from './experienceMemory.js';
import type { WorldMemoryRecord } from './worldMemory.js';
import type { TaskExecutionResult } from './executiveTypes.js';

interface Snapshot {
  sessionId: string; worldId: string; sourceWorldId: string; generation: number;
  lateResult: TaskExecutionResult | null;
  global: WorldMemoryRecord[]; currentSpatial: WorldMemoryRecord[]; history: WorldMemoryRecord[];
  procedures: LearnedProcedure[]; sourceEvidence: Evidence[]; recent: Evidence[];
  evidenceRows: Array<{ sequence: number; id: string; payload: string }>;
  procedureRows: Array<{ id: string; payload: string }>;
  integrity: string;
}

/** Every call loads the actual source in a separate Node process, not Jest's module cache. */
function launch(directory: string, mode: string, options: {
  world?: string; history?: string; terminate?: NodeJS.Signals;
} = {}): Promise<Snapshot> {
  return new Promise((resolveSnapshot, reject) => {
    // Do not forward developer credentials, NODE_OPTIONS, or gameplay settings.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP, TMP: process.env.TMP, SystemRoot: process.env.SystemRoot,
      GAMEPLAY_MEMORY_FIXTURE: '1', NODE_ENV: 'test', NO_COLOR: '1',
    };
    const child = fork(resolve('scripts/fixtures/gameplay-memory-lifecycle.ts'),
      [mode, join(directory, 'memory.sqlite'), options.world ?? 'world-A', ...(options.history ? [options.history] : [])], {
        cwd: process.cwd(), execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env,
      });
    let snapshot: Snapshot | undefined;
    let failure: Error | undefined;
    let output = '';
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error);
      else if (snapshot) resolveSnapshot(snapshot);
      else reject(new Error(`fixture_no_snapshot:${mode}\n${output}`));
    };
    const timer = setTimeout(() => {
      failure = new Error(`fixture_timeout:${mode}\n${output}`);
      child.kill('SIGKILL');
    }, 20000);
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => {
      output = (output + data.toString()).slice(-24000);
    });
    child.on('error', error => finish(error));
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || (message as { kind?: string }).kind !== 'snapshot') {
        failure = new Error('unexpected_fixture_message'); child.kill('SIGKILL'); return;
      }
      if (snapshot) { failure = new Error('duplicate_fixture_snapshot'); child.kill('SIGKILL'); return; }
      snapshot = (message as { snapshot: Snapshot }).snapshot;
      if (options.terminate && !child.kill(options.terminate)) failure = new Error('fixture_signal_not_sent');
    });
    child.once('exit', (code, signal) => {
      if (failure) { finish(failure); return; }
      if (options.terminate ? signal !== options.terminate : code !== 0 || signal != null) {
        finish(new Error(`fixture_exit:${mode}:code=${code}:signal=${signal}\n${output}`)); return;
      }
      finish();
    });
  });
}
function preserved(before: Snapshot, after: Snapshot): void {
  expect(after.integrity).toBe('ok');
  expect(after.global).toEqual(before.global);
  expect(after.procedures).toEqual(before.procedures);
  expect(after.sourceEvidence).toEqual(before.sourceEvidence);
  // Compare serialized database payloads too: retention must not rewrite original evidence.
  expect(after.evidenceRows).toEqual(before.evidenceRows);
  expect(after.procedureRows).toEqual(before.procedureRows);
  expect(after.history).toEqual(before.history);
}
function summary(snapshot: Snapshot): WorldMemoryRecord {
  const result = snapshot.global.find(record => record.kind === 'procedure');
  if (!result) throw new Error('fixture_summary_missing');
  return result;
}

describe('T04b cross-process memory lifecycle (real SQLite; no Minecraft or model requests)', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'memory-lifecycle-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  test('graceful process exit/restart retains procedures, counters, immutable evidence and global memories', async () => {
    const original = await launch(directory, 'seed');
    const reopened = await launch(directory, 'read');
    preserved(original, reopened);
    expect(reopened.worldId).toBe(original.worldId);
    expect(reopened.sessionId).not.toBe(original.sessionId);
    expect(reopened.currentSpatial).toEqual(original.currentSpatial);
    expect(reopened.procedures.find(p => p.name === 'fixture candidate')).toMatchObject({ status: 'candidate', successes: 0, failures: 0 });
    expect(reopened.procedures.find(p => p.name === 'fixture verified')).toMatchObject({ status: 'verified', successes: 2, failures: 0 });
    expect(reopened.procedures.find(p => p.name === 'fixture with failed replay')).toMatchObject({ status: 'candidate', successes: 1, failures: 1 });
    expect(reopened.sourceEvidence.every(e => e.worldId === original.worldId && e.sessionId === original.sessionId)).toBe(true);
    expect(summary(reopened).metadata).toMatchObject({ successes: 1, failures: 1, attempts: 2 });
    expect(reopened.recent.some(e => e.status === 'failed' && !e.verified)).toBe(true);
    expect(reopened.recent.some(e => e.status === 'interrupted' && !e.verified)).toBe(true);
    expect(reopened.recent.some(e => e.status === 'succeeded' && !e.verified)).toBe(true);
  }, 45000);

  test('new sessions append after old sequences and accumulate counters without overwriting old traces', async () => {
    const original = await launch(directory, 'seed');
    const next = await launch(directory, 'append');
    expect(next.evidenceRows.slice(0, original.evidenceRows.length)).toEqual(original.evidenceRows);
    expect(next.evidenceRows).toHaveLength(original.evidenceRows.length + 1);
    const added = next.recent[next.recent.length - 1];
    expect(added.sequence).toBe(original.recent[original.recent.length - 1].sequence + 1);
    expect(added.sessionId).toBe(next.sessionId);
    expect(added.sessionId).not.toBe(original.sessionId);
    expect(next.sourceEvidence).toEqual(original.sourceEvidence);
    expect(next.procedureRows).toEqual(original.procedureRows);
    expect(summary(next).metadata).toMatchObject({ successes: 2, failures: 1, attempts: 3 });
    const reopened = await launch(directory, 'read');
    preserved(next, reopened);
  }, 65000);

  test('saving the same evidence again after restart does not reset learned status or counts', async () => {
    const original = await launch(directory, 'seed');
    preserved(original, await launch(directory, 'resave'));
  }, 45000);

  test('actual nextGeneration retains global data and source history, not old live coordinates', async () => {
    const original = await launch(directory, 'seed');
    const rotated = await launch(directory, 'rotate', { history: original.worldId });
    preserved(original, rotated);
    expect(rotated.worldId).not.toBe(original.worldId);
    expect(rotated.generation).toBe(2);
    expect(rotated.currentSpatial).toEqual([]);
    const restarted = await launch(directory, 'read', { world: 'world-B', history: original.worldId });
    preserved(original, restarted);
    expect(restarted.worldId).toBe(rotated.worldId);
    expect(restarted.currentSpatial).toEqual([]);
  }, 65000);

  test('a fresh runtime for another world preserves experience and allows returning to the original map', async () => {
    const original = await launch(directory, 'seed');
    const other = await launch(directory, 'read', { world: 'world-B', history: original.worldId });
    preserved(original, other); expect(other.currentSpatial).toEqual([]);
    const returned = await launch(directory, 'read');
    preserved(original, returned);
    expect(returned.currentSpatial).toEqual(original.currentSpatial);
    expect(returned.worldId).toBe(original.worldId);
  }, 65000);

  test.each(['SIGTERM', 'SIGKILL'] as const)('committed writes survive %s without close/shutdown hooks', async signal => {
    const acknowledged = await launch(directory, 'hold', { terminate: signal });
    const reopened = await launch(directory, 'read');
    preserved(acknowledged, reopened);
    expect(reopened.currentSpatial).toEqual(acknowledged.currentSpatial);
    expect(reopened.sessionId).not.toBe(acknowledged.sessionId);
  }, 45000);

  test('killing a process inside an uncommitted transaction preserves committed evidence and procedure payloads', async () => {
    const committed = await launch(directory, 'rollback', { terminate: 'SIGKILL' });
    const reopened = await launch(directory, 'read');
    preserved(committed, reopened);
    expect(reopened.evidenceRows.some(row => row.id === 'uncommitted-evidence')).toBe(false);
    expect(reopened.procedures.some(p => p.name === 'UNCOMMITTED REPLACEMENT')).toBe(false);
  }, 45000);

  test('bounded recent recall does not delete older procedure source evidence', async () => {
    const original = await launch(directory, 'seed');
    const busy = await launch(directory, 'flood');
    expect(busy.recent).toHaveLength(64);
    expect(busy.recent.some(e => e.id === original.sourceEvidence[0].id)).toBe(false);
    expect(busy.sourceEvidence).toEqual(original.sourceEvidence);
    expect(busy.evidenceRows).toHaveLength(original.evidenceRows.length + 80);
    expect(busy.evidenceRows.slice(0, original.evidenceRows.length)).toEqual(original.evidenceRows);
    preserved(busy, await launch(directory, 'read'));
  }, 65000);

  test.each(['late-stop', 'late-rotate'])('%s retains a delayed task finalizer with its original world and no negative lesson', async mode => {
    const original = await launch(directory, 'seed');
    const completed = await launch(directory, mode, { history: original.worldId });
    expect(completed.lateResult?.status).toBe('interrupted');
    expect(completed.global).toEqual(original.global);
    expect(completed.procedureRows).toEqual(original.procedureRows);
    expect(completed.evidenceRows.slice(0, original.evidenceRows.length)).toEqual(original.evidenceRows);
    const last = completed.recent[completed.recent.length - 1];
    expect(last).toMatchObject({ worldId: original.worldId, dimension: 'overworld', status: 'interrupted', verified: false });
    expect(JSON.parse(last.effect).interrupted).toBe(true);
    expect(completed.history).toEqual(original.history);
    if (mode === 'late-rotate') expect(completed.currentSpatial).toEqual([]);
    const reopened = await launch(directory, 'read', { world: mode === 'late-rotate' ? 'world-B' : 'world-A', history: original.worldId });
    preserved(completed, reopened);
  }, 65000);
});
