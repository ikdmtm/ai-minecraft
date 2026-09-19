import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { inspectEvaluationProvider, evaluationDuration } from './evaluationPreflight.js';
import { RunRecorder, runRecordedChild, makeRedactor } from './runRecorder.js';

export interface EvaluationOptions { durationMs: number; freshMemory?: boolean }
export interface PreparedEvaluation {
  cwd: string; directory: string; serverDirectory: string;
  env: NodeJS.ProcessEnv; report: Record<string, unknown>; options: EvaluationOptions;
}
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
function writeReport(p: PreparedEvaluation): void {
  const path = join(p.directory, 'evaluation.json');
  fs.writeFileSync(path + '.tmp', JSON.stringify(makeRedactor(p.env)(p.report), null, 2) + '\n', { mode: 0o600, flush: true });
  fs.renameSync(path + '.tmp', path);
}

/** Preparation never starts Java, connects to Minecraft, or calls a model.
 * All destinations are created with a fresh directory; there is no reset/delete,
 * merge-back or resume-existing-directory operation.
 */
export async function prepareIsolatedEvaluation(cwd: string, env: NodeJS.ProcessEnv,
  options: EvaluationOptions): Promise<PreparedEvaluation> {
  const preflight = inspectEvaluationProvider(env);
  if (!preflight.ready) throw new Error('evaluation_preflight_blocked:' + preflight.issues.join(','));
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs < 15000 || options.durationMs > 300000) {
    throw new Error('evaluation_duration_out_of_range');
  }
  const sourceServer = resolve(cwd, env.MC_DEV_DIR?.trim() || '.minecraft-dev', 'server');
  const sourceJar = join(sourceServer, 'server.jar');
  if (!fs.existsSync(sourceJar) || !fs.statSync(sourceJar).isFile()) throw new Error('evaluation_source_server_jar_missing');
  // Reuse an existing acceptance; the evaluator does not accept terms on behalf
  // of an operator who has not already configured this server distribution.
  const eula = join(sourceServer, 'eula.txt');
  if (!fs.existsSync(eula) || !/^\s*eula\s*=\s*true\s*$/im.test(fs.readFileSync(eula, 'utf8'))) {
    throw new Error('evaluation_source_eula_not_accepted');
  }
  const parent = resolve(cwd, 'data/gameplay-evaluations');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(join(parent, 'eval-'));
  fs.chmodSync(directory, 0o700);
  const serverDirectory = join(directory, 'server');
  fs.mkdirSync(join(serverDirectory, 'world'), { recursive: true });
  const worldId = 'evaluation-' + randomUUID();
  const childEnv: NodeJS.ProcessEnv = { ...env,
    MC_DEV_DIR: directory, DB_PATH: join(directory, 'memory.sqlite'),
    GAMEPLAY_RUN_DIR: join(directory, 'runs'), GAMEPLAY_KNOWLEDGE_FILE: join(directory, 'knowledge.json'),
    GAMEPLAY_WORLD_ID: worldId, GAMEPLAY_WORLD_ID_FILE: join(serverDirectory, 'world/.ai-world-id'),
    MINECRAFT_HOST: '127.0.0.1', MINECRAFT_PORT: '0', BOT_USERNAME: 'AI_Rei_Test',
    GAMEPLAY_VIEWER_ENABLED: 'false', GAMEPLAY_VIEWER_AUTO_OPEN: 'false',
    GAMEPLAY_SEED: '7', MC_SEED: '7',
    POLICY_PROVIDER: env.POLICY_PROVIDER?.trim().toLowerCase() || 'auto',
  };
  const p: PreparedEvaluation = { cwd: resolve(cwd), directory, serverDirectory, env: childEnv,
    options: { ...options }, report: { schemaVersion: 1, phase: 'preparing', preflight,
      accepted: false, liveModelInvoked: false, worldId, configuredSeed: '7',
      durationMs: options.durationMs, freshMemoryRequested: options.freshMemory === true,
      memory: { status: 'pending' }, server: { address: '127.0.0.1', port: null, jarSha256: null },
      limitation: 'A completed or time-limited run is not an autonomous gameplay acceptance result.' } };
  writeReport(p);
  try {
    fs.copyFileSync(sourceJar, join(serverDirectory, 'server.jar'), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(join(serverDirectory, 'eula.txt'), 'eula=true\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(childEnv.GAMEPLAY_WORLD_ID_FILE!, worldId + '\n', { flag: 'wx', mode: 0o600 });
    p.report.server = { address: '127.0.0.1', port: null, jarSha256: await fileHash(join(serverDirectory, 'server.jar')) };
    const source = env.DB_PATH?.trim() || './data/gameplay.db';
    if (options.freshMemory) p.report.memory = { status: 'explicit_fresh_comparison', originalUnchanged: true };
    else if (source === ':memory:') p.report.memory = { status: 'source_was_in_memory', originalUnchanged: true };
    else {
      const sourcePath = resolve(cwd, source);
      if (!fs.existsSync(sourcePath)) p.report.memory = { status: 'source_absent', originalUnchanged: true };
      else {
        const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
        try {
          db.prepare('SELECT name FROM sqlite_schema LIMIT 1').all();
          await db.backup(childEnv.DB_PATH!);
        } finally { db.close(); }
        fs.chmodSync(childEnv.DB_PATH!, 0o600);
        p.report.memory = { status: 'copied_committed_sqlite', originalUnchanged: true,
          initialSha256: await fileHash(childEnv.DB_PATH!), automaticMergeBack: false };
      }
    }
    p.report.phase = 'prepared_not_run'; writeReport(p); return p;
  } catch (error) {
    p.report.phase = 'preparation_failed';
    p.report.error = error instanceof Error ? error.message : String(error);
    writeReport(p); throw error;
  }
}

export function evaluationServerProperties(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('evaluation_port_invalid');
  return ['server-ip=127.0.0.1', `server-port=${port}`, 'online-mode=false', 'enable-rcon=false',
    'enable-query=false', 'white-list=false', 'max-players=1', 'level-name=world', 'level-seed=7',
    'gamemode=survival', 'hardcore=true', 'difficulty=hard', 'spawn-protection=0',
    'view-distance=6', 'simulation-distance=6', 'motd=Isolated AI evaluation'].join('\n') + '\n';
}
async function availablePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); fail(new Error('evaluation_port_unavailable')); return; }
      server.close(error => error ? fail(error) : done(address.port));
    });
  });
}
function killOwned(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch { /* Owned process already gone. */ }
}

/** Explicit paid-request opt-in. Uses a freshly owned server, never an operator's
 * configured endpoint. POSIX/WSL only; native Windows group cleanup is unverified.
 */
export async function runIsolatedEvaluation(p: PreparedEvaluation, allowPaidRequests = false): Promise<number> {
  if (!allowPaidRequests) throw new Error('evaluation_explicit_run_required');
  if (process.platform === 'win32') throw new Error('evaluation_requires_posix_or_wsl');
  if (p.report.phase !== 'prepared_not_run' || !inspectEvaluationProvider(p.env).ready) throw new Error('evaluation_not_prepared');
  p.report.phase = 'launching'; writeReport(p);
  let server: ChildProcess | undefined, serverClosed = false, serverFailure = false;
  let serverLog: number | undefined, recorder: RunRecorder | undefined;
  let result = 1;
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const exported = spawnSync('python3', [join(p.cwd, 'scripts/mc-export-knowledge.py'),
      join(p.serverDirectory, 'server.jar'), p.env.GAMEPLAY_KNOWLEDGE_FILE!],
    { cwd: p.cwd, env: p.env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    fs.writeFileSync(join(p.directory, 'knowledge-export.log'), String(makeRedactor(p.env)(
      (exported.stdout || '') + (exported.stderr || ''))), { mode: 0o600 });
    if (exported.error || exported.status !== 0) throw new Error('evaluation_knowledge_export_failed');
    if (cancellation.signal.aborted) throw new Error('evaluation_cancelled');
    const port = await availablePort();
    p.env.MINECRAFT_PORT = String(port);
    p.report.server = { ...(p.report.server as object), port };
    fs.writeFileSync(join(p.serverDirectory, 'server.properties'), evaluationServerProperties(port), { flag: 'wx', mode: 0o600 });
    serverLog = fs.openSync(join(p.directory, 'server.log'), 'wx+', 0o600);
    server = spawn('java', ['-Xms256M', '-Xmx1G', '-jar', 'server.jar', 'nogui'],
      { cwd: p.serverDirectory, env: p.env, detached: true, stdio: ['pipe', serverLog, serverLog] });
    server.stdin?.on('error', () => {});
    server.once('error', () => { serverFailure = true; cancellation.abort(); });
    server.once('close', () => { serverClosed = true; cancellation.abort(); });
    const started = Date.now();
    let offset = 0, tail = '';
    while (!tail.includes('Done (')) {
      if (cancellation.signal.aborted || serverFailure || serverClosed) throw new Error('evaluation_server_start_interrupted');
      if (Date.now() - started > 90000) throw new Error('evaluation_server_start_timeout');
      const buffer = Buffer.alloc(8192);
      const bytes = fs.readSync(serverLog, buffer, 0, buffer.length, offset);
      offset += bytes; tail = (tail + buffer.subarray(0, bytes).toString('utf8')).slice(-16384);
      await delay(100);
    }
    // If Java lost the port race it must not reach Done; never fall back to any
    // already running Minecraft service on that endpoint.
    if (cancellation.signal.aborted) throw new Error('evaluation_cancelled');
    recorder = new RunRecorder(p.cwd, p.env);
    recorder.manifest.evaluation = { directory: p.directory, durationMs: p.options.durationMs,
      providerPreflight: p.report.preflight, isolatedMemory: p.report.memory, accepted: false };
    await recorder.prepare();
    p.report.phase = 'running'; p.report.runId = recorder.runId;
    p.report.liveModelInvoked = 'unknown_until_runtime_log'; writeReport(p);
    const extension = extname(__filename);
    const args = extension === '.ts' ? ['--import', 'tsx', join(__dirname, 'jevMain.ts')] : [join(__dirname, 'jevMain.js')];
    result = await runRecordedChild(recorder, args, process.execPath,
      { maxDurationMs: p.options.durationMs, signal: cancellation.signal });
    p.report.termination = recorder.manifest.termination;
    p.report.phase = 'finished_not_accepted';
  } catch (error) {
    p.report.phase = 'failed'; p.report.error = error instanceof Error ? error.message : String(error);
    recorder?.finish(1, null, 'evaluation_launcher_failed');
  } finally {
    if (server && !serverClosed) {
      // Only this child is stopped. Never read an operational PID file or reset a world.
      try { server.stdin?.end('stop\n'); } catch { /* escalate below */ }
      const end = Date.now() + 10000;
      while (!serverClosed && Date.now() < end) await delay(100);
      if (!serverClosed) {
        p.report.serverForcedStop = true; killOwned(server, 'SIGKILL');
        const forcedEnd = Date.now() + 2000;
        while (!serverClosed && Date.now() < forcedEnd) await delay(50);
      }
    }
    p.report.serverClosed = serverClosed;
    if (server && !serverClosed) { result = 1; p.report.phase = 'cleanup_unconfirmed'; }
    if (serverLog != null) fs.closeSync(serverLog);
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    p.report.exitCode = result; writeReport(p);
  }
  return result;
}

export function parseEvaluationArgs(args: string[]): EvaluationOptions & { run: boolean } {
  let seconds: string | undefined, run = false, freshMemory = false;
  const seen = new Set<string>();
  for (const arg of args) {
    const key = arg.split('=')[0];
    if (seen.has(key)) throw new Error('evaluation_duplicate_argument'); seen.add(key);
    if (arg === '--run') run = true;
    else if (arg === '--prepare') continue;
    else if (arg === '--fresh-memory') freshMemory = true;
    else if (arg.startsWith('--seconds=')) seconds = arg.slice('--seconds='.length);
    else throw new Error('evaluation_unknown_argument');
  }
  if (seen.has('--run') && seen.has('--prepare')) throw new Error('evaluation_conflicting_modes');
  return { run, freshMemory, durationMs: evaluationDuration(seconds) };
}
async function main(): Promise<void> {
  require('dotenv').config({ quiet: true });
  const options = parseEvaluationArgs(process.argv.slice(2));
  const p = await prepareIsolatedEvaluation(process.cwd(), process.env, options);
  process.stdout.write(JSON.stringify({ kind: 'evaluation_prepared', directory: p.directory, runRequested: options.run }) + '\n');
  if (options.run) process.exitCode = await runIsolatedEvaluation(p, true);
}
if (require.main === module) void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(JSON.stringify(makeRedactor(process.env)({ kind: 'evaluation_error', message })) + '\n');
  process.exitCode = 2;
});
