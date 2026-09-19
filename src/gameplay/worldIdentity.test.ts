import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldMemory } from './worldMemory.js';
import { CognitiveOrchestrator, type CognitiveOrchestratorConfig } from './jevOrchestrator.js';
import { resolveGameplayWorldIdentity, advanceGameplayWorldIdentity } from './worldIdentity.js';

const connection = { mcHost: 'localhost', mcPort: 25565 };
const envKeys = ['MC_DEV_DIR', 'GAMEPLAY_WORLD_ID', 'GAMEPLAY_WORLD_ID_FILE', 'MC_SEED'] as const;

describe('T04a1 world/server identity (temporary files and SQLite, no network)', () => {
  let directory: string;
  let marker: string;
  let originalEnv: Record<string, string | undefined>;
  const runtimes: CognitiveOrchestrator[] = [];
  const memories: WorldMemory[] = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'world-identity-'));
    marker = join(directory, 'server/world/.ai-world-id');
    mkdirSync(join(directory, 'server/world'), { recursive: true });
    writeFileSync(join(directory, 'server/server.properties'), 'level-name=world\nserver-port=25565\nlevel-seed=8675309\n');
    writeFileSync(marker, 'world-A\n');
    originalEnv = {};
    for (const key of envKeys) { originalEnv[key] = process.env[key]; delete process.env[key]; }
    process.env.MC_DEV_DIR = directory;
    process.env.MC_SEED = '8675309';
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) {
      runtime.destroy();
      (runtime as any).memory.close();
      (runtime as any).experience.close();
    }
    for (const memory of memories.splice(0)) memory.close();
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  function runtime(host = 'localhost', port = 25565, db = join(directory, 'memory.sqlite')) {
    const config: CognitiveOrchestratorConfig = {
      ...connection, mcHost: host, mcPort: port, dbPath: db,
      tacticalModel: 'fixture', strategicModel: 'fixture', botUsername: 'Fixture',
      cameraPlayer: '', voicevoxHost: '', voicevoxSpeakerId: 0,
    };
    const instance = new CognitiveOrchestrator(config); runtimes.push(instance); return instance;
  }
  function memory(instance: CognitiveOrchestrator): WorldMemory { return (instance as any).memory; }
  function home(mem: WorldMemory) {
    return mem.observe({ kind: 'placed_block', key: 'home', label: 'home',
      position: { x: 53, y: 65, z: 72 }, scope: 'world', retention: 'stable' });
  }
  function close(instance: CognitiveOrchestrator) {
    memory(instance).close(); (instance as any).experience.close();
  }

  test('same managed world has the same namespace independent of seed labels', () => {
    const a = resolveGameplayWorldIdentity(connection);
    process.env.MC_SEED = '123';
    const b = resolveGameplayWorldIdentity(connection);
    expect(a.source).toBe('marker'); expect(b.memoryWorldId).toBe(a.memoryWorldId);
    expect(readFileSync(marker, 'utf8')).toBe('world-A\n');
  });
  test('runtime/SQLite reopen restores the same world spatial record', () => {
    const a = runtime(); const record = home(memory(a)); const id = memory(a).getWorldId(); close(a);
    const b = runtime();
    expect(memory(b).getWorldId()).toBe(id);
    expect(memory(b).recall({ includeGlobal: false })[0].id).toBe(record.id);
    expect(memory(b).recall({ includeGlobal: false })[0].position).toEqual(record.position);
  });
  test('same seed with a replacement marker excludes old coordinates but retains history and global evidence', () => {
    const a = runtime(); const oldId = memory(a).getWorldId(); const record = home(memory(a));
    memory(a).recordProcedureOutcome({ key: 'example', label: 'observed failure', success: false, detail: 'fixture' }); close(a);
    writeFileSync(marker, 'world-B\n');
    const b = runtime();
    expect(process.env.MC_SEED).toBe('8675309');
    expect(memory(b).getWorldId()).not.toBe(oldId);
    expect(memory(b).recall({ includeGlobal: false })).toEqual([]);
    expect(memory(b).recallHistory(oldId)[0].id).toBe(record.id);
    expect(memory(b).recall({ includeWorld: false })[0].metadata.failures).toBe(1);
  });
  test('same explicit world token on a different server or port never shares its map', () => {
    process.env.GAMEPLAY_WORLD_ID = 'same-token';
    const a = runtime('server-a.example', 25565); home(memory(a)); const id = memory(a).getWorldId(); close(a);
    const b = runtime('server-b.example', 25565);
    expect(memory(b).getWorldId()).not.toBe(id);
    expect(memory(b).recall({ includeGlobal: false })).toEqual([]); close(b);
    const c = runtime('server-a.example', 25566);
    expect(memory(c).getWorldId()).not.toBe(id);
    expect(memory(c).recall({ includeGlobal: false })).toEqual([]); close(c);
    const d = runtime('server-a.example', 25565);
    expect(memory(d).getWorldId()).toBe(id);
    expect(memory(d).recall({ includeGlobal: false })).toHaveLength(1);
  });
  test('remote and mismatching local-port connections do not borrow the local marker', () => {
    for (const target of [{ mcHost: 'remote.example', mcPort: 25565 }, { mcHost: 'localhost', mcPort: 25566 }]) {
      const a = resolveGameplayWorldIdentity(target), b = resolveGameplayWorldIdentity(target);
      expect(a.source).toBe('session_unconfirmed'); expect(a.memoryWorldId).not.toBe(b.memoryWorldId);
    }
  });
  test('a custom level needs explicit configuration rather than borrowing server/world', () => {
    writeFileSync(join(directory, 'server/server.properties'), 'level-name=other\nserver-port=25565\n');
    expect(resolveGameplayWorldIdentity(connection).source).toBe('session_unconfirmed');
    process.env.GAMEPLAY_WORLD_ID_FILE = marker;
    expect(resolveGameplayWorldIdentity(connection).source).toBe('marker');
  });
  test('missing default marker does not fall back to the previous database map', () => {
    const a = runtime(); const id = memory(a).getWorldId(); home(memory(a)); close(a);
    rmSync(marker);
    const b = runtime();
    expect(memory(b).getWorldId()).not.toBe(id);
    expect(memory(b).recall({ includeGlobal: false })).toEqual([]);
    expect(memory(b).recallHistory(id)).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
  });
  test.each(['missing', 'empty'])('invalid explicit marker (%s) fails before opening the runtime DB', kind => {
    process.env.GAMEPLAY_WORLD_ID_FILE = join(directory, 'explicit-marker');
    if (kind === 'empty') writeFileSync(process.env.GAMEPLAY_WORLD_ID_FILE, '\n');
    const db = join(directory, 'not-created.sqlite');
    expect(() => runtime('localhost', 25565, db)).toThrow('explicit_marker_missing_or_empty');
    expect(existsSync(db)).toBe(false);
  });
  test('explicit generation rotation refuses the unchanged token before changing runtime state', () => {
    process.env.GAMEPLAY_WORLD_ID = 'manual-A';
    const a = runtime(); const id = memory(a).getWorldId(); home(memory(a));
    expect(() => a.nextGeneration()).toThrow('explicit_rotation_required');
    expect(a.getGeneration()).toBe(1); expect(memory(a).getWorldId()).toBe(id);
    expect(memory(a).recall({ includeGlobal: false })).toHaveLength(1);
    expect(readFileSync(marker, 'utf8')).toBe('world-A\n');
    process.env.GAMEPLAY_WORLD_ID = 'manual-B'; a.nextGeneration();
    const newId = memory(a).getWorldId(); close(a);
    const b = runtime(); expect(memory(b).getWorldId()).toBe(newId);
    expect(memory(b).recall({ includeGlobal: false })).toEqual([]);
  });
  test('managed generation rotation persists its marker and survives runtime reopen', () => {
    const a = runtime(); const oldId = memory(a).getWorldId(); home(memory(a)); a.nextGeneration();
    const newId = memory(a).getWorldId();
    expect(newId).not.toBe(oldId); expect(readFileSync(marker, 'utf8').trim()).not.toBe('world-A'); close(a);
    const b = runtime(); expect(memory(b).getWorldId()).toBe(newId);
    expect(memory(b).recallHistory(oldId)).toHaveLength(1);
  });
  test('an externally replaced marker is adopted once, not rotated again', () => {
    const a = resolveGameplayWorldIdentity(connection);
    writeFileSync(marker, 'external-B\n');
    const b = advanceGameplayWorldIdentity(connection, a);
    expect(b.worldToken).toBe('external-B'); expect(readFileSync(marker, 'utf8')).toBe('external-B\n');
  });
  test('restart path refreshes identity after external reset without reconstructing the runtime', () => {
    const a = runtime(); home(memory(a)); const oldId = memory(a).getWorldId();
    writeFileSync(marker, 'external-B\n');
    (a as any).refreshWorldIdentity();
    expect(memory(a).getWorldId()).not.toBe(oldId);
    expect(memory(a).recall({ includeGlobal: false })).toEqual([]);
    expect(memory(a).recallHistory(oldId)).toHaveLength(1);
  });
  test('legacy coordinates remain history, never guessed to belong to a server', () => {
    const old = new WorldMemory(join(directory, 'memory.sqlite'), 'world-A'); memories.push(old);
    home(old); old.recordProcedureOutcome({ key: 'legacy', label: 'experience', success: true, detail: 'fixture' }); old.close();
    const a = runtime();
    expect(memory(a).recall({ includeGlobal: false })).toEqual([]);
    expect(memory(a).recallHistory('world-A')).toHaveLength(1);
    expect(memory(a).recall({ includeWorld: false })[0].label).toBe('experience');
  });
  test('running generation transitions are rejected before any marker update', () => {
    const a = runtime(); (a as any).running = true;
    try { expect(() => a.nextGeneration()).toThrow('stop_runtime_before_changing_world'); }
    finally { (a as any).running = false; }
    expect(readFileSync(marker, 'utf8')).toBe('world-A\n');
  });
});
