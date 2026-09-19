import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareIsolatedEvaluation, runIsolatedEvaluation, parseEvaluationArgs, evaluationServerProperties, evaluationToolEnvironment } from './evaluationRunner.js';

// TypeScript's namespace wrapper has non-configurable accessors. Spy on the
// native module exports so calls remain observable without changing the test.
const childProcess = require('node:child_process') as typeof import('node:child_process');
let cwd: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  cwd = fs.mkdtempSync(join(tmpdir(), 'isolated-eval-'));
  const server = join(cwd, '.minecraft-dev/server');
  fs.mkdirSync(join(server, 'world'), { recursive: true });
  fs.writeFileSync(join(server, 'server.jar'), 'fixture-not-a-java-server');
  fs.writeFileSync(join(server, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(join(server, 'world/.ai-world-id'), 'operational-world');
  fs.writeFileSync(join(server, 'world/keep.dat'), 'never mutate this world');
  fs.writeFileSync(join(server, 'server.properties'), 'server-port=25565\nlevel-name=world\n');
  env = { POLICY_PROVIDER: 'openai', OPENAI_API_KEY: 'fixture-private-key', MINECRAFT_HOST: 'production.invalid',
    MINECRAFT_PORT: '25565', GAMEPLAY_WORLD_ID: 'operational-world',
    GAMEPLAY_WORLD_ID_FILE: join(server, 'world/.ai-world-id'), GAMEPLAY_KNOWLEDGE_FILE: '/not/a/test/destination',
    GAMEPLAY_RUN_DIR: '/not/a/test/log', GAMEPLAY_VIEWER_ENABLED: 'true' };
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_network'));
  jest.spyOn(childProcess, 'spawn'); jest.spyOn(childProcess, 'spawnSync');
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }); });
const options = { durationMs: 60000 };

test('preparation isolates every destination without starting any process/model', async () => {
  const before = { ...env };
  const p = await prepareIsolatedEvaluation(cwd, env, options);
  expect(env).toEqual(before);
  expect(p.env).toMatchObject({ MINECRAFT_HOST: '127.0.0.1', MINECRAFT_PORT: '0',
    POLICY_PROVIDER: 'openai', GAMEPLAY_VIEWER_ENABLED: 'false', GAMEPLAY_VIEWER_AUTO_OPEN: 'false' });
  for (const key of ['MC_DEV_DIR', 'DB_PATH', 'GAMEPLAY_RUN_DIR', 'GAMEPLAY_KNOWLEDGE_FILE', 'GAMEPLAY_WORLD_ID_FILE']) {
    expect(p.env[key]!.startsWith(p.directory)).toBe(true);
  }
  expect(p.env.GAMEPLAY_WORLD_ID).not.toBe('operational-world');
  expect(fs.existsSync(join(p.serverDirectory, 'world/keep.dat'))).toBe(false);
  expect(fs.readFileSync(join(cwd, '.minecraft-dev/server/world/keep.dat'), 'utf8')).toBe('never mutate this world');
  expect(p.report).toMatchObject({ phase: 'prepared_not_run', accepted: false, liveModelInvoked: false,
    memory: { status: 'source_absent' } });
  expect(fs.readFileSync(join(p.directory, 'evaluation.json'), 'utf8')).not.toContain('fixture-private-key');
  expect(childProcess.spawn).not.toHaveBeenCalled();
  expect(childProcess.spawnSync).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test('copies committed SQLite WAL data and subsequent test writes stay isolated', async () => {
  const livePath = join(cwd, 'live.db'); env.DB_PATH = livePath;
  const live = new Database(livePath);
  live.pragma('journal_mode = WAL'); live.pragma('wal_autocheckpoint = 0');
  live.exec('CREATE TABLE experience (text TEXT)'); live.prepare('INSERT INTO experience VALUES (?)').run('old experience');
  try {
    const p = await prepareIsolatedEvaluation(cwd, env, options);
    expect(p.report.memory).toMatchObject({ status: 'copied_committed_sqlite', automaticMergeBack: false });
    const copy = new Database(p.env.DB_PATH!);
    try {
      expect(copy.prepare('SELECT * FROM experience').all()).toEqual([{ text: 'old experience' }]);
      copy.prepare('INSERT INTO experience VALUES (?)').run('test-only experience');
      expect(live.prepare('SELECT * FROM experience').all()).toEqual([{ text: 'old experience' }]);
    } finally { copy.close(); }
  } finally { live.close(); }
});

test('fresh comparison is explicit and does not erase the original memory', async () => {
  env.DB_PATH = join(cwd, 'live.db');
  fs.writeFileSync(env.DB_PATH, 'original bytes');
  const p = await prepareIsolatedEvaluation(cwd, env, { ...options, freshMemory: true });
  expect(p.report.memory).toMatchObject({ status: 'explicit_fresh_comparison' });
  expect(fs.existsSync(p.env.DB_PATH!)).toBe(false);
  expect(fs.readFileSync(env.DB_PATH, 'utf8')).toBe('original bytes');
});

test('corrupt source DB fails rather than silently using empty memory', async () => {
  env.DB_PATH = join(cwd, 'broken.db'); fs.writeFileSync(env.DB_PATH, 'broken source');
  await expect(prepareIsolatedEvaluation(cwd, env, options)).rejects.toThrow();
  expect(fs.readFileSync(env.DB_PATH, 'utf8')).toBe('broken source');
  const root = join(cwd, 'data/gameplay-evaluations');
  const dir = fs.readdirSync(root)[0];
  expect(JSON.parse(fs.readFileSync(join(root, dir, 'evaluation.json'), 'utf8')).phase).toBe('preparation_failed');
  expect(childProcess.spawn).not.toHaveBeenCalled();
});

test('separate preparations have separate identities even with the same seed', async () => {
  const a = await prepareIsolatedEvaluation(cwd, env, options);
  const b = await prepareIsolatedEvaluation(cwd, env, options);
  expect(a.directory).not.toBe(b.directory);
  expect(a.env.GAMEPLAY_WORLD_ID).not.toBe(b.env.GAMEPLAY_WORLD_ID);
  expect(a.env.GAMEPLAY_SEED).toBe(b.env.GAMEPLAY_SEED);
});

test('incompatible provider is rejected before creating a destination', async () => {
  env.POLICY_PROVIDER = 'auto'; env.TYPESAFE_API_KEY = 'fixture-typesafe';
  await expect(prepareIsolatedEvaluation(cwd, env, options)).rejects.toThrow('evaluation_preflight_blocked');
  expect(fs.existsSync(join(cwd, 'data'))).toBe(false);
  expect(childProcess.spawn).not.toHaveBeenCalled();
});

test.each(['jar', 'eula'])('missing %s prerequisites do not start anything', async missing => {
  fs.unlinkSync(join(cwd, '.minecraft-dev/server', missing === 'jar' ? 'server.jar' : 'eula.txt'));
  await expect(prepareIsolatedEvaluation(cwd, env, options)).rejects.toThrow('evaluation_source_');
  expect(fs.existsSync(join(cwd, 'data'))).toBe(false);
});

test('refuses unaccepted EULA without changing it', async () => {
  const path = join(cwd, '.minecraft-dev/server/eula.txt'); fs.writeFileSync(path, 'eula=false');
  await expect(prepareIsolatedEvaluation(cwd, env, options)).rejects.toThrow('eula_not_accepted');
  expect(fs.readFileSync(path, 'utf8')).toBe('eula=false');
});

test('running requires a separate explicit opt-in', async () => {
  const p = await prepareIsolatedEvaluation(cwd, env, options);
  await expect(runIsolatedEvaluation(p)).rejects.toThrow('evaluation_explicit_run_required');
  expect(p.report.phase).toBe('prepared_not_run');
  expect(childProcess.spawn).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

test('server properties bind loopback, disable RCON and use a new hardcore world', () => {
  const props = evaluationServerProperties(31001);
  expect(props).toContain('server-ip=127.0.0.1\n'); expect(props).toContain('server-port=31001\n');
  expect(props).toContain('enable-rcon=false\n'); expect(props).toContain('hardcore=true\n');
  expect(props).not.toContain('production.invalid');
});
test.each([0, -1, 65536, 1.5, NaN])('invalid port %p is rejected', port => {
  expect(() => evaluationServerProperties(port)).toThrow('evaluation_port_invalid');
});

test('Java and export subprocesses receive system paths but not model secrets or injected options', () => {
  const source: NodeJS.ProcessEnv = { ...env, PATH: '/fixture/bin', JAVA_HOME: '/fixture/java', HOME: '/fixture/home',
    NODE_OPTIONS: '--require unwanted', JAVA_TOOL_OPTIONS: '-agentlib:unwanted', TYPESAFE_API_KEY: 'private' };
  expect(evaluationToolEnvironment(source)).toEqual({ PATH: '/fixture/bin', JAVA_HOME: '/fixture/java', HOME: '/fixture/home' });
  expect(source.OPENAI_API_KEY).toBe('fixture-private-key');
});

test('CLI defaults to prepare, and run/fresh modes must be explicit', () => {
  expect(parseEvaluationArgs([])).toEqual({ run: false, freshMemory: false, durationMs: 60000 });
  expect(parseEvaluationArgs(['--run', '--seconds=15', '--fresh-memory'])).toEqual({ run: true, freshMemory: true, durationMs: 15000 });
});
test.each([['--force'], ['--run', '--prepare'], ['--run', '--run'], ['--seconds=301'], ['--seconds=30', '--seconds=60']])('bad CLI arguments %j are rejected', (...args) => {
  expect(() => parseEvaluationArgs(args)).toThrow('evaluation_');
});
