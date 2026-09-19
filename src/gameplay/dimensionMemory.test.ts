import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { WorldMemory, normalizeMemoryDimension } from './worldMemory.js';
import { ExperienceMemory } from './experienceMemory.js';
import { SemanticWorldModel } from './semanticWorldModel.js';
import { WorldProvenance } from './worldProvenance.js';
import { TaskExecutor } from './taskExecutor.js';
import { SharedStateBus } from '../cognitive/sharedState.js';
import { windowSnapshot, type PrimitiveOperation } from './primitiveOperations.js';
import type { ExecutiveTaskSnapshot } from './executiveTypes.js';

const registry = require('prismarine-registry')('1.21.4');
const dimensions = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];
const position = { x: 3, y: 64, z: 0 };
const idle: ExecutiveTaskSnapshot = {
  id: 0, task: 'NONE', targetId: null, status: 'idle', startedAt: null, updatedAt: 0, detail: '', progress: {},
};
function fakeBot(): any {
  return Object.assign(new EventEmitter(), {
    registry, version: '1.21.4', game: { dimension: 'overworld' }, food: 20, health: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0 }, entities: {},
    time: { timeOfDay: 1000, day: 0 }, isRaining: false, currentWindow: null, heldItem: null,
    inventory: { id: 0, type: 'minecraft:inventory', inventoryStart: 9, inventoryEnd: 45,
      slots: Array(46).fill(null), items() { return this.slots.filter(Boolean); } },
    findBlock: jest.fn(() => null), findBlocks: jest.fn(() => []), blockAt: jest.fn(() => null),
    canSeeBlock: jest.fn(() => true), recipesFor: jest.fn(() => []), recipesAll: jest.fn(() => []),
  });
}

describe('T04a-2a dimension memory and evidence (temporary SQLite; mocked physical world)', () => {
  let directory: string;
  const closables: Array<{ close(): void }> = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'dimension-memory-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const object of closables.splice(0)) object.close();
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  function memory(path = join(directory, 'memory.sqlite'), world = 'fixture-world') {
    const result = new WorldMemory(path, world); closables.push(result); return result;
  }
  function experience() {
    const result = new ExperienceMemory(join(directory, 'experience.sqlite')); closables.push(result); return result;
  }
  function placed(mem: WorldMemory, dimension?: string, label = 'stone', confidence = 1) {
    return mem.observe({ kind: 'placed_block', key: '3:64:0', label, position,
      dimension, scope: 'world', retention: 'stable', confidence });
  }
  function spatial(mem: WorldMemory, dimension?: string, limit = 32) {
    return mem.recall({ dimension, includeGlobal: false, limit });
  }
  function taskFixture(bot: any, mem: WorldMemory, exp: ExperienceMemory, implementation: () => Promise<unknown>) {
    const primitive: any = { runAndWait: jest.fn(implementation), snapshot: () => ({}), stop: jest.fn() };
    const task = new TaskExecutor(bot, new SharedStateBus(), primitive,
      { capture: () => ({}) } as any, {} as any, mem, exp);
    const execute = (operation: PrimitiveOperation) => task.execute({
      task: 'EXECUTE_OPERATION', operation, source: 'openai', confidence: 1, basedOnRevision: 1,
    });
    return { task, primitive, execute };
  }

  test.each([
    ['overworld', 'minecraft:overworld'], ['the_nether', 'minecraft:the_nether'],
    ['nether', 'minecraft:the_nether'], ['the_end', 'minecraft:the_end'],
    ['minecraft:overworld', 'minecraft:overworld'], ['example:moon', 'example:moon'],
    [undefined, null], ['unknown', null], ['', null],
  ])('normalizes %s without guessing an unknown dimension', (input, expected) => {
    expect(normalizeMemoryDimension(input)).toBe(expected);
  });

  test('identical keys and coordinates in three dimensions persist as distinct records', () => {
    const path = join(directory, 'memory.sqlite'), mem = memory(path);
    const records = dimensions.map((dim, i) => placed(mem, dim, ['stone', 'netherrack', 'end_stone'][i]));
    expect(new Set(records.map(r => r.id)).size).toBe(3);
    for (let i = 0; i < dimensions.length; i++) {
      expect(spatial(mem, dimensions[i]).map(r => r.id)).toEqual([records[i].id]);
    }
    mem.close();
    const reopened = memory(path);
    for (let i = 0; i < dimensions.length; i++) {
      expect(spatial(reopened, dimensions[i])[0]).toMatchObject({ id: records[i].id, position, dimension: dimensions[i] });
    }
    expect(reopened.recallHistory('fixture-world')).toHaveLength(3);
  });

  test('dimension filtering happens before recall ranking and its limit', () => {
    const mem = memory(); const home = placed(mem, dimensions[0], 'home', 0.5);
    for (let i = 0; i < 40; i++) mem.observe({ kind: 'placed_block', key: `nether-${i}`, label: 'other',
      position, dimension: dimensions[1], retention: 'stable', confidence: 1 });
    expect(spatial(mem, dimensions[0], 1).map(r => r.id)).toEqual([home.id]);
  });

  test('contradiction at a coordinate weakens only that dimension', () => {
    const mem = memory(); dimensions.forEach(dim => placed(mem, dim));
    mem.markContradictedNear(position, 0.1, ['placed_block'], 1, 'the_nether');
    expect(spatial(mem, dimensions[1])).toEqual([]);
    expect(spatial(mem, dimensions[0])[0].confidence).toBe(1);
    expect(spatial(mem, dimensions[2])[0].confidence).toBe(1);
    expect(mem.recallHistory('fixture-world')).toHaveLength(3);
  });

  test('old SQL schema migrates additively; unknown coordinates are not assigned to overworld', () => {
    const path = join(directory, 'legacy.sqlite');
    const database = new Database(path);
    database.exec(`CREATE TABLE gameplay_memory (
      id TEXT PRIMARY KEY, kind TEXT, label TEXT, x REAL, y REAL, z REAL,
      confidence REAL, first_seen_at INTEGER, last_seen_at INTEGER, observations INTEGER,
      retention TEXT, scope TEXT, world_id TEXT, metadata_json TEXT);
      CREATE TABLE gameplay_memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const now = Date.now();
    database.prepare('INSERT INTO gameplay_memory VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'legacy-home', 'placed_block', 'home', 3, 64, 0, 1, now, now, 1, 'stable', 'world', 'fixture-world', '{"original":true}',
    );
    database.close();
    const mem = memory(path);
    expect(spatial(mem, dimensions[0])).toEqual([]);
    expect(mem.recallHistory('fixture-world')[0]).toMatchObject({ id: 'legacy-home', dimension: null, metadata: { original: true } });
    placed(mem, dimensions[0]); mem.close();
    const reopened = memory(path);
    expect(spatial(reopened, dimensions[0])).toHaveLength(1);
    expect(reopened.recallHistory('fixture-world')).toHaveLength(2);
  });

  test('unqualified recall is not a wildcard; global experience remains accessible from each map', () => {
    const mem = memory(); const legacy = placed(mem);
    dimensions.forEach(dim => placed(mem, dim));
    mem.recordProcedureOutcome({ key: 'fixture', label: 'observed failure', success: false, detail: 'fixture' });
    expect(spatial(mem).map(r => r.id)).toEqual([legacy.id]);
    for (const dimension of dimensions) {
      expect(mem.recall({ dimension }).filter(r => r.scope === 'global')[0].metadata.failures).toBe(1);
    }
  });

  test('replacing the world still excludes every previous dimension without deleting history', () => {
    const mem = memory(); dimensions.forEach(dim => placed(mem, dim));
    mem.setWorldId('new-world-same-seed');
    for (const dim of dimensions) expect(spatial(mem, dim)).toEqual([]);
    expect(mem.recallHistory('fixture-world')).toHaveLength(3);
  });

  test('live targets and prompt memories follow the current dimension and recover on return', () => {
    const mem = memory(), bot = fakeBot();
    const records = dimensions.map(dim => placed(mem, dim));
    placed(mem, undefined, 'legacy');
    const semantic = new SemanticWorldModel(bot, new SharedStateBus(), undefined, mem);
    let previousRevision = 0;
    for (const dim of [...dimensions, dimensions[0]]) {
      bot.game.dimension = dim;
      const state = semantic.capture(idle);
      const expected = records.find(r => r.dimension === dim)!;
      expect(state.targets.filter(t => t.kind === 'remembered_location').map(t => t.metadata.memoryId)).toEqual([expected.id]);
      expect(state.memory.filter(r => r.scope === 'world').map(r => r.id)).toEqual([expected.id]);
      expect(state.revision).toBeGreaterThan(previousRevision); previousRevision = state.revision;
    }
    bot.game.dimension = undefined;
    const unknown = semantic.capture(idle);
    expect(unknown.targets.filter(t => t.kind === 'remembered_location')).toEqual([]);
    expect(unknown.memory.filter(r => r.scope === 'world')).toEqual([]);
  });

  test('same-coordinate entity observations are tagged with the observed dimension', () => {
    const mem = memory(), bot = fakeBot();
    bot.entities[2] = { id: 2, name: 'cow', type: 'mob', position: new Vec3(3, 64, 0) };
    const semantic = new SemanticWorldModel(bot, new SharedStateBus(), undefined, mem);
    semantic.capture(idle); bot.game.dimension = 'the_nether'; semantic.capture(idle);
    const records = mem.recallHistory('fixture-world').filter(r => r.kind === 'entity_sighting');
    expect(records).toHaveLength(2);
    expect(new Set(records.map(r => r.dimension))).toEqual(new Set(dimensions.slice(0, 2)));
  });

  test('capture invalidates unscoped physical provenance and surface anchor on a context change', () => {
    const mem = memory(), bot = fakeBot(), provenance = new WorldProvenance();
    const semantic = new SemanticWorldModel(bot, new SharedStateBus(), provenance, mem);
    provenance.markPlaced(position, 'utility'); provenance.markStructure('shelter', position);
    const first = semantic.capture(idle);
    expect(first.targets.some(t => t.kind === 'known_structure')).toBe(true);
    (semantic as any).lastSurfaceAnchor = { ...position };
    bot.game.dimension = 'the_nether'; const next = semantic.capture(idle);
    expect(provenance.isPlayerPlaced(position)).toBe(false);
    expect(next.targets.some(t => t.kind === 'known_structure')).toBe(false);
    expect((semantic as any).lastSurfaceAnchor).toBeNull();
    expect(next.revision).toBeGreaterThan(first.revision);
  });

  test('recent current-context evidence excludes another dimension without deleting it', () => {
    const mem = memory(), exp = experience(), bot = fakeBot();
    for (const dimension of ['overworld', 'the_nether']) exp.append({
      worldId: 'fixture-world', version: '1.21.4', dimension,
      operation: { action: 'WAIT', durationMs: 100 }, status: 'succeeded', verified: true,
      detail: 'fixture', effect: 'fixture', origin: position, window: windowSnapshot(bot),
    });
    const semantic = new SemanticWorldModel(bot, new SharedStateBus(), undefined, mem, exp);
    const overworld = semantic.capture(idle);
    expect(overworld.autonomy).toBeDefined();
    expect(overworld.autonomy?.recentExperience).toEqual([
      expect.objectContaining({ worldId: 'fixture-world', dimension: 'overworld' }),
    ]);
    bot.game.dimension = 'the_nether';
    const nether = semantic.capture(idle);
    expect(nether.autonomy).toBeDefined();
    expect(nether.autonomy?.recentExperience).toEqual([
      expect.objectContaining({ worldId: 'fixture-world', dimension: 'the_nether' }),
    ]);
    expect(exp.recent()).toHaveLength(2);
  });

  test('verified PLACE records the current dimension rather than an unknown spatial record', async () => {
    const mem = memory(), exp = experience(), bot = fakeBot(); let built = false;
    bot.game.dimension = 'the_nether';
    bot.blockAt.mockImplementation(() => ({ name: built ? 'stone' : 'air', stateId: built ? 1 : 0 }));
    const { execute } = taskFixture(bot, mem, exp, async () => {
      built = true; return { action: 'OPERATE', status: 'succeeded', detail: 'completed' };
    });
    expect((await execute({ action: 'PLACE', position, item: 'stone' })).status).toBe('succeeded');
    expect(spatial(mem, dimensions[1])[0]).toMatchObject({ label: 'stone', dimension: dimensions[1] });
    expect(spatial(mem, dimensions[0])).toEqual([]);
    expect(spatial(mem)).toEqual([]);
  });

  test('verified BREAK cannot invalidate an identical block in the other dimension', async () => {
    const mem = memory(), exp = experience(), bot = fakeBot(); let broken = false;
    dimensions.forEach(dim => placed(mem, dim)); bot.game.dimension = 'the_nether';
    bot.blockAt.mockImplementation(() => ({ name: broken ? 'air' : 'stone', stateId: broken ? 0 : 1 }));
    const { execute } = taskFixture(bot, mem, exp, async () => {
      broken = true; return { action: 'OPERATE', status: 'succeeded', detail: 'completed' };
    });
    expect((await execute({ action: 'BREAK', position })).status).toBe('succeeded');
    expect(spatial(mem, dimensions[1])).toEqual([]);
    expect(spatial(mem, dimensions[0])).toHaveLength(1);
    expect(spatial(mem, dimensions[2])).toHaveLength(1);
  });

  test.each(['dimension', 'world'])('a late operation crossing %s keeps source evidence and creates no destination memory', async boundary => {
    const mem = memory(), exp = experience(), bot = fakeBot();
    const { execute } = taskFixture(bot, mem, exp, async () => {
      if (boundary === 'dimension') bot.game.dimension = 'the_nether';
      else mem.setWorldId('other-world');
      bot.blockAt.mockReturnValue({ name: 'stone', stateId: 1 });
      return { action: 'OPERATE', status: 'succeeded', detail: 'completed' };
    });
    const result = await execute({ action: 'PLACE', position, item: 'stone' });
    expect(result).toEqual({ status: 'interrupted', detail: 'task_replan:spatial_context_changed' });
    expect(mem.recallHistory('fixture-world')).toEqual([]);
    expect(mem.recallHistory('other-world')).toEqual([]);
    expect(mem.recall({ includeWorld: false })).toEqual([]);
    const evidence = exp.recent()[0];
    expect(evidence).toMatchObject({ worldId: 'fixture-world', dimension: 'overworld', status: 'interrupted', verified: false });
    expect(JSON.parse(evidence.effect).contextChanged).toBe(true);
  });

  test('an unknown dimension cannot create coordinate evidence by assuming overworld', async () => {
    const mem = memory(), exp = experience(), bot = fakeBot(); bot.game.dimension = undefined;
    const { execute, primitive } = taskFixture(bot, mem, exp, async () => ({ action: 'OPERATE', status: 'succeeded' }));
    expect((await execute({ action: 'PLACE', position, item: 'stone' })).status).toBe('interrupted');
    expect(primitive.runAndWait).not.toHaveBeenCalled(); expect(exp.recent()).toEqual([]);
  });
});
