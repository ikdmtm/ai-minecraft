import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

type Fields = Record<string, unknown>;
const SECRET_KEY = /(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|credential)/i;
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

/** Only allowlisted configuration is recorded. Known secrets are also removed from error text. */
export function makeRedactor(env: NodeJS.ProcessEnv): (value: unknown) => unknown {
  const secrets = Object.entries(env).filter(([key, value]) => SECRET_KEY.test(key) && value && value.length >= 4)
    .map(([, value]) => value!).sort((a, b) => b.length - a.length);
  function redact(value: unknown, depth = 0): unknown {
    if (depth > 24) return '[depth-limit]';
    if (typeof value === 'string') {
      for (const secret of secrets) {
        for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
          value = (value as string).split(form).join('[REDACTED]');
        }
      }
      return (value as string).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
    }
    if (Array.isArray(value)) return value.map(entry => redact(entry, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
      [key, SECRET_KEY.test(key) ? '[REDACTED]' : redact(entry, depth + 1)]));
    return value;
  }
  return redact;
}

function readOptional(path: string): Buffer | null {
  try { return fs.readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

export class RunRecorder {
  readonly runId = randomUUID();
  readonly directory: string;
  readonly manifest: Fields;
  private readonly redact: (value: unknown) => unknown;
  private readonly fd: number;
  private sequence = 0;
  private checkpointAt = 0;
  private closed = false;
  private reportedShutdown: string | null = null;
  private readonly counts: Record<string, number> = {};
  private waitSamples = 0;
  private stallEvents = 0;
  private outputErrors = 0;

  constructor(readonly cwd = process.cwd(), readonly env: NodeJS.ProcessEnv = process.env,
    private readonly output: (line: string) => void = line => { process.stdout.write(line); }) {
    this.redact = makeRedactor(env);
    this.directory = join(resolve(cwd, env.GAMEPLAY_RUN_DIR || 'data/gameplay-runs'), this.runId);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.fd = fs.openSync(join(this.directory, 'events.jsonl'), 'wx', 0o600);
    const commit = git(cwd, ['rev-parse', 'HEAD'])?.trim() ?? null;
    const status = git(cwd, ['status', '--porcelain']);
    const diff = git(cwd, ['diff', '--binary', 'HEAD']);
    this.manifest = {
      schema_version: 1, run_id: this.runId, phase: 'preparing', started_at: new Date().toISOString(), ended_at: null,
      code: { commit, dirty: status == null ? null : status.length > 0, tracked_diff_sha256: diff == null ? null : digest(diff),
        exact_checkout: status === '', limitation: 'Uncommitted/untracked source is not archived; a dirty checkout is not exactly reproducible.' },
      node_version: process.version,
      requested: {
        minecraft_host: env.MINECRAFT_HOST?.trim() || 'localhost', minecraft_port: env.MINECRAFT_PORT?.trim() || '25565',
        bot_username: env.BOT_USERNAME?.trim() || 'AI_Rei', policy_provider: env.POLICY_PROVIDER?.trim() || 'auto',
        openai_policy_model: env.OPENAI_POLICY_MODEL?.trim() || 'gpt-5.6-luna',
        strategic_model: env.STRATEGIC_MODEL?.trim() || 'gpt-5.6-terra', jev_model: env.JEV_MODEL?.trim() || 'jev-latest',
      },
      runtime: {}, seed: this.seedMetadata(), memory: { status: 'pending' }, knowledge: { status: 'pending' },
      termination: null, counters: {}, last_event_sequence: 0,
      incomplete_run_rule: 'Without phase=finished, termination is unknown (still running or interrupted); never assume successful completion.',
    };
    this.checkpoint();
  }

  /** Use SQLite backup, not a plain copy: committed WAL pages must be included. Never reset the live DB. */
  async prepare(): Promise<void> {
    const source = this.env.DB_PATH?.trim() || './data/gameplay.db';
    if (source === ':memory:') {
      this.manifest.memory = { status: 'empty_in_memory', snapshot: null };
    } else {
      const path = resolve(this.cwd, source);
      if (!fs.existsSync(path)) {
        this.manifest.memory = { status: 'absent_at_start', source_path: path, snapshot: null };
      } else {
        let db: Database.Database | undefined;
        const destination = join(this.directory, 'memory-start.sqlite');
        try {
          db = new Database(path, { readonly: true, fileMustExist: true });
          db.prepare('SELECT name FROM sqlite_schema LIMIT 1').all();
          await db.backup(destination);
        } catch (error) {
          // Native SQLite errors are not always instanceof the current JS realm's Error.
          throw new Error(`memory_snapshot_failed:${errorMessage(error)}`);
        } finally { db?.close(); }
        fs.chmodSync(destination, 0o600);
        this.manifest.memory = { status: 'snapshotted', source_path: path, snapshot: 'memory-start.sqlite',
          sha256: digest(fs.readFileSync(destination)), captured_at: new Date().toISOString(),
          limitation: 'Start-of-run evidence only. Another process writing the live DB after this snapshot is not excluded.' };
      }
    }
    const knowledge = readOptional(resolve(this.cwd, this.env.GAMEPLAY_KNOWLEDGE_FILE || 'data/minecraft-knowledge.json'));
    if (knowledge) {
      let version: string | null = null;
      try { const data = JSON.parse(knowledge.toString('utf8')); if (typeof data.version === 'string') version = data.version; } catch { /* Record invalid export without inventing facts. */ }
      fs.writeFileSync(join(this.directory, 'knowledge-start.json'), knowledge, { mode: 0o600 });
      this.manifest.knowledge = { status: version ? 'captured' : 'invalid_export', version,
        snapshot: 'knowledge-start.json', sha256: digest(knowledge) };
    } else this.manifest.knowledge = { status: 'unavailable', version: null, snapshot: null };
    this.record({ kind: 'run_prepared' });
    this.checkpoint();
  }

  private seedMetadata(): Fields {
    if (this.env.GAMEPLAY_SEED?.trim()) return { value: this.env.GAMEPLAY_SEED.trim(), source: 'operator_label', verified: false };
    const host = this.env.MINECRAFT_HOST?.trim() || 'localhost';
    if (['localhost', '127.0.0.1', '::1'].includes(host)) {
      const bytes = readOptional(resolve(this.cwd, this.env.MC_DEV_DIR || '.minecraft-dev', 'server/server.properties'));
      const text = bytes?.toString('utf8') ?? '';
      const port = /^server-port=(.*)$/m.exec(text)?.[1].trim() || '25565';
      if (port === (this.env.MINECRAFT_PORT?.trim() || '25565')) {
        const value = /^level-seed=(.*)$/m.exec(text)?.[1].trim();
        if (value) return { value, source: 'local_server_properties', verified: false,
          limitation: 'Configured seed, not verified against level.dat; settings may differ from an existing world.' };
      }
    }
    return { value: null, source: 'unavailable', verified: false };
  }

  acceptLine(line: string, stream: 'stdout' | 'stderr'): void {
    let event: Fields;
    try {
      const parsed = JSON.parse(line);
      event = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.kind === 'string'
        ? parsed : { kind: 'process_output', message: line };
    } catch { event = { kind: 'process_output', message: line }; }
    this.record({ ...event, stream });
  }

  record(input: Fields): void {
    if (this.closed) return;
    const event = this.redact({ ...input, run_id: this.runId, sequence: ++this.sequence,
      received_at: new Date().toISOString() }) as Fields;
    const kind = String(event.kind);
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    if (kind === 'shutdown') this.reportedShutdown = typeof event.reason === 'string' ? event.reason : 'unknown';
    if (kind === 'run_context') this.manifest.runtime = event.context;
    if (kind === 'game_event' && event.event_type === 'executive_runtime_started') {
      const detail = typeof event.detail === 'string' ? event.detail : '';
      const provider = /provider=(\S+)/.exec(detail)?.[1], model = /model=(\S+)/.exec(detail)?.[1];
      this.manifest.effective_policy = { provider: provider ?? null, model: model ?? null };
    }
    if (kind === 'state') {
      const task = event.task as Fields | undefined;
      const waiting = task?.status === 'running' && task.detail === 'waiting_for_condition';
      event.intentional_wait = waiting;
      if (waiting) this.waitSamples++;
      this.manifest.last_state = { received_at: event.received_at, hp: event.hp, hunger: event.hunger,
        position: event.position, world: event.world, memory_world_id: event.memory_world_id, task, intentional_wait: waiting };
    }
    if (kind === 'gameplay_no_progress') this.stallEvents++;
    const line = JSON.stringify(event) + '\n';
    fs.writeSync(this.fd, line);
    // A broken terminal must not destroy the authoritative on-disk journal.
    try { this.output(line); } catch { this.outputErrors++; }
    this.manifest.last_event_sequence = this.sequence;
    this.manifest.last_event_at = event.received_at;
    if (['run_context', 'shutdown', 'fatal'].includes(kind) || Date.now() - this.checkpointAt > 2000) this.checkpoint();
  }

  running(pid: number | undefined): void {
    this.manifest.phase = 'running'; this.manifest.child_pid = pid ?? null;
    this.record({ kind: 'run_started' }); this.checkpoint();
  }

  finish(code: number | null, signal: string | null, reason?: string): void {
    if (this.closed) return;
    this.record({ kind: 'run_finished', exit_code: code, signal,
      reason: reason ?? this.reportedShutdown ?? (signal ? 'child_signal' : 'exit_without_shutdown') });
    this.manifest.phase = 'finished'; this.manifest.ended_at = new Date().toISOString();
    this.manifest.termination = { exit_code: code, signal, reported_shutdown: this.reportedShutdown,
      reason: reason ?? this.reportedShutdown ?? (signal ? 'child_signal' : 'exit_without_shutdown'),
      clean_shutdown: !reason && code === 0 && signal === null && this.reportedShutdown !== null };
    this.checkpoint(); fs.closeSync(this.fd); this.closed = true;
  }

  checkpoint(): void {
    if (this.closed) return;
    this.manifest.counters = { events_by_kind: { ...this.counts }, intentional_wait_samples: this.waitSamples,
      no_progress_events: this.stallEvents, console_output_errors: this.outputErrors };
    fs.fsyncSync(this.fd);
    const temporary = join(this.directory, 'manifest.json.tmp');
    fs.writeFileSync(temporary, JSON.stringify(this.redact(this.manifest), null, 2) + '\n', { mode: 0o600, flush: true });
    fs.renameSync(temporary, join(this.directory, 'manifest.json')); this.checkpointAt = Date.now();
  }
}

/** Separate process preserves a termination record even when the gameplay child crashes. */
export async function runRecordedChild(recorder: RunRecorder, args: string[], command = process.execPath): Promise<number> {
  let child: ChildProcess | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let recordingError = false, forced = false;
  const kill = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch { /* Child may already have exited. */ }
  };
  const terminate = (signal: NodeJS.Signals) => {
    kill(signal);
    if (!timer) timer = setTimeout(() => { forced = true; kill('SIGKILL'); }, 10000);
  };
  const receive = (line: string, stream: 'stdout' | 'stderr') => {
    if (recordingError) return;
    try { recorder.acceptLine(line, stream); } catch {
      recordingError = true; terminate('SIGTERM');
    }
  };
  const sigint = () => terminate('SIGINT'), sigterm = () => terminate('SIGTERM');
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  try {
    return await new Promise<number>(resolveCode => {
      child = spawn(command, args, { cwd: recorder.cwd, env: { ...recorder.env, GAMEPLAY_RUN_ID: recorder.runId },
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      try { recorder.running(child.pid); } catch { recordingError = true; terminate('SIGTERM'); }
      const readers = [createInterface({ input: child.stdout!, crlfDelay: Infinity }), createInterface({ input: child.stderr!, crlfDelay: Infinity })];
      readers[0].on('line', line => receive(line, 'stdout'));
      readers[1].on('line', line => receive(line, 'stderr'));
      let spawnError = false;
      child.once('error', error => { spawnError = true; receive(JSON.stringify({ kind: 'spawn_error', message: error.message }), 'stderr'); });
      child.once('close', (code, signal) => {
        readers.forEach(reader => reader.close());
        try { recorder.finish(code, signal, recordingError ? 'recording_failed' : spawnError ? 'spawn_failed' : forced ? 'forced_after_signal' : undefined); }
        catch { recordingError = true; }
        resolveCode(recordingError || spawnError || forced ? 1 : code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
  }
}

async function main(): Promise<void> {
  // Credentials are inherited by the child but are never dumped into the manifest.
  require('dotenv').config({ quiet: true });
  // stdout can fail asynchronously (e.g. a closed pipe); the journal remains authoritative.
  let consoleAvailable = true;
  process.stdout.on('error', () => { consoleAvailable = false; });
  const recorder = new RunRecorder(process.cwd(), process.env, line => { if (consoleAvailable) process.stdout.write(line); });
  try {
    await recorder.prepare();
    const extension = extname(__filename);
    const args = extension === '.ts' ? ['--import', 'tsx', join(__dirname, 'jevMain.ts')] : [join(__dirname, 'jevMain.js')];
    process.exitCode = await runRecordedChild(recorder, [...args, ...process.argv.slice(2)]);
  } catch (error) {
    recorder.record({ kind: 'recorder_error', message: errorMessage(error) });
    recorder.finish(1, null, 'preparation_failed'); process.exitCode = 1;
  }
}
if (require.main === module) void main().catch(() => { process.stderr.write('Gameplay recording failed before launch.\n'); process.exitCode = 1; });
