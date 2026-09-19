import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunRecorder, runRecordedChild } from './runRecorder.js';

let root: string;
const recorders: RunRecorder[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'evaluation-limits-')); });
afterEach(() => {
  for (const recorder of recorders.splice(0)) recorder.finish(0, null, 'test_cleanup');
  rmSync(root, { recursive: true, force: true });
});
function create(output: (line: string) => void = () => {}) {
  const r = new RunRecorder(root, {}, output); recorders.push(r); return r;
}
function manifest(r: RunRecorder) { return JSON.parse(readFileSync(join(r.directory, 'manifest.json'), 'utf8')); }
const cooperative = 'const t=setInterval(()=>{},1000); process.on("SIGTERM",()=>{console.log(JSON.stringify({kind:"shutdown",reason:"SIGTERM"}));clearInterval(t);}); console.log(JSON.stringify({kind:"fixture_ready"}));';

test('time limit stops a real child and is never labeled gameplay success', async () => {
  const recorder = create(); await recorder.prepare();
  const before = process.listenerCount('SIGTERM');
  const code = await runRecordedChild(recorder, ['-e', cooperative], process.execPath, { maxDurationMs: 1000, shutdownGraceMs: 1000 });
  expect(code).toBe(124);
  expect(manifest(recorder)).toMatchObject({ phase: 'finished', termination: { reason: 'duration_limit', clean_shutdown: false } });
  expect(readFileSync(join(recorder.directory, 'events.jsonl'), 'utf8')).toContain('run_limit_reached');
  expect(process.listenerCount('SIGTERM')).toBe(before);
}, 10000);

test('uncooperative child is force-stopped and the forced outcome is explicit', async () => {
  const recorder = create(); await recorder.prepare();
  const code = await runRecordedChild(recorder, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'],
    process.execPath, { maxDurationMs: 1000, shutdownGraceMs: 100 });
  expect(code).toBe(1);
  expect(manifest(recorder).termination).toMatchObject({ reason: 'duration_limit_forced', clean_shutdown: false });
}, 10000);

test('aborted evaluation cannot start a child', async () => {
  const recorder = create(); await recorder.prepare();
  const abort = new AbortController(); abort.abort();
  const code = await runRecordedChild(recorder, ['-e', 'throw new Error("must-not-launch");'], process.execPath, { signal: abort.signal });
  expect(code).toBe(130);
  expect(manifest(recorder).termination.reason).toBe('cancelled_before_spawn');
  expect(manifest(recorder).counters.events_by_kind.run_started).toBeUndefined();
});

test('external cancellation stops a running child and does not poison the following run', async () => {
  const abort = new AbortController();
  const recorder = create(line => { if (JSON.parse(line).kind === 'fixture_ready') abort.abort(); });
  await recorder.prepare();
  expect(await runRecordedChild(recorder, ['-e', cooperative], process.execPath, { signal: abort.signal, maxDurationMs: 3000 })).toBe(130);
  expect(manifest(recorder).termination.reason).toBe('evaluation_cancelled');
  const next = create(); await next.prepare();
  expect(await runRecordedChild(next, ['-e', 'console.log(JSON.stringify({kind:"shutdown",reason:"fixture_complete"}));'],
    process.execPath, { maxDurationMs: 3000 })).toBe(0);
  expect(manifest(next).termination).toMatchObject({ reason: 'fixture_complete', clean_shutdown: true });
}, 10000);

test.each([{ maxDurationMs: 0 }, { maxDurationMs: -1 }, { maxDurationMs: 300001 },
  { maxDurationMs: NaN }, { shutdownGraceMs: 0 }, { shutdownGraceMs: 10001 }])('invalid limits are rejected before launch %j', async limits => {
  const recorder = create(); await recorder.prepare();
  await expect(runRecordedChild(recorder, ['-e', 'process.exit(0);'], process.execPath, limits)).rejects.toThrow('invalid_recorded_child_limits');
  expect(manifest(recorder).phase).toBe('preparing');
});
