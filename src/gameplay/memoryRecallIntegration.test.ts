import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Vec3 } from 'vec3';
import { ExecutivePolicy } from './executivePolicy.js';
import { TaskExecutor } from './taskExecutor.js';
import { SemanticWorldModel } from './semanticWorldModel.js';
import { ExperienceMemory } from './experienceMemory.js';
import { WorldMemory } from './worldMemory.js';
import { SharedStateBus } from '../cognitive/sharedState.js';
import type { MemorySearchResult } from './memoryRetrieval.js';
import type { PrimitiveOperation } from './primitiveOperations.js';

const registry = require('prismarine-registry')('1.21.4');

/** Physical effects and model transport are fixtures. Query/parser/task/storage/
 * snapshot classes and evidence assessment are actual production implementations. */
describe('T06a model-selected history recall integration', () => {
  let directory: string, fetchSpy: jest.SpyInstance, logSpy: jest.SpyInstance;
  const closables: Array<{ close(): void }> = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'memory-recall-integration-'));
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_test_network_request'));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    closables.splice(0).forEach(object => object.close()); jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  function fixture() {
    const path = join(directory, 'memory.sqlite'), memory = new WorldMemory(path, 'world-A'), experience = new ExperienceMemory(path);
    closables.push(memory, experience);
    const blocks = new Map<string, string>();
    const bot: any = Object.assign(new EventEmitter(), {
      registry, version: '1.21.4', game: { dimension: 'overworld' }, health: 20, food: 20,
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true },
      entities: {}, time: { timeOfDay: 1000, day: 0 }, isRaining: false, isSleeping: false,
      currentWindow: null, heldItem: null,
      inventory: { id: 0, type: 'minecraft:inventory', inventoryStart: 9, inventoryEnd: 45,
        slots: Array(46).fill(null), items() { return this.slots.filter(Boolean); } },
      findBlock: jest.fn(() => null), findBlocks: jest.fn(() => []),
      recipesFor: jest.fn(() => []), recipesAll: jest.fn(() => []), canSeeBlock: jest.fn(() => true),
      blockAt: jest.fn((p: Vec3) => {
        const name = blocks.get(`${p.x}:${p.y}:${p.z}`) ?? (p.y < 64 ? 'stone' : 'air');
        return { name, stateId: name === 'air' ? 0 : name === 'stone' ? 1 : 2, position: p.clone(),
          boundingBox: name === 'air' ? 'empty' : 'block', diggable: name !== 'air', getProperties: () => ({}) };
      }),
    });
    const shared = new SharedStateBus(), semantic = new SemanticWorldModel(bot, shared, undefined, memory, experience);
    const primitive: any = { snapshot: () => ({}), stop: jest.fn(), runAndWait: jest.fn(async ({ operation: op }: { operation: PrimitiveOperation }) => {
      if (op.action === 'USE') return { action: 'OPERATE', status: 'failed', detail: 'operation_item_missing:bread' };
      if (op.action === 'PLACE') blocks.set(`${op.position!.x}:${op.position!.y}:${op.position!.z}`, op.item!);
      return { action: 'OPERATE', status: 'succeeded', detail: `operation_completed:${op.action}` };
    }) };
    const task = new TaskExecutor(bot, shared, primitive, { capture: () => ({}) } as any, semantic, memory, experience);
    const policy = new ExecutivePolicy({ provider: 'openai', openaiApiKey: 'fixture-not-a-key', openaiModel: 'fixture-model', timeoutMs: 1000 });
    const state = () => semantic.capture(task.snapshot());
    const execute = (operation: PrimitiveOperation) => task.execute({ task: 'EXECUTE_OPERATION', operation,
      source: 'openai', confidence: 1, basedOnRevision: state().revision });
    const recall = (query: string, cursor?: string) => task.execute({ task: 'RECALL_MEMORY', memoryQuery: query, memoryCursor: cursor,
      source: 'openai', confidence: 1, basedOnRevision: state().revision });
    const demonstrate = async (item = 'stone', x = 1, y = 64) => {
      for (const height of [y, y + 1]) expect((await execute({ action: 'PLACE', item, position: { x, y: height, z: 0 } })).status).toBe('succeeded');
      return experience.recent(2);
    };
    return { memory, experience, bot, primitive, task, policy, state, recall, execute, demonstrate };
  }
  function answer(extra: Record<string, unknown> = {}) {
    return { task: 'RECALL_MEMORY', affordance_id: 'none', operation: null, knowledge_query: null, knowledge_offset: null,
      memory_query: 'bread', memory_cursor: null, procedure_name: null, evidence_ids: [], procedure_id: null,
      confidence: 0.8, reason: 'Controlled query selection; not spontaneous learning.', ...extra };
  }
  function reply(extra: Record<string, unknown> = {}) {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ output_text: JSON.stringify(answer(extra)) }) });
  }
  function searched(f: ReturnType<typeof fixture>): MemorySearchResult { return f.state().autonomy!.memorySearch as MemorySearchResult; }

  test('real recorded failure -> model query -> parser -> executor -> SQLite search -> next input', async () => {
    const f = fixture(); await f.execute({ action: 'USE', item: 'bread' });
    const old = f.experience.recent()[0];
    for (let i = 0; i < 30; i++) f.experience.append({ ...old, operation: { action: 'WAIT', durationMs: 100 }, detail: 'unrelated', effect: '{}', status: 'succeeded', verified: false });
    f.memory.setWorldId('world-B');
    const before = f.state(), calls = f.primitive.runAndWait.mock.calls.length;
    expect(before.autonomy!.recentExperience).toEqual([]);
    expect(before.autonomy!.memorySearch).toBeNull();
    let request: any;
    fetchSpy.mockImplementationOnce(async (_url: unknown, options: RequestInit) => {
      request = JSON.parse(String(options.body));
      return { ok: true, json: async () => ({ output_text: JSON.stringify(answer()) }) };
    });
    const decision = await f.policy.decide(before);
    expect(request.text.format.schema.properties.task.enum).toContain('RECALL_MEMORY');
    expect(request.text.format.schema.required).toEqual(expect.arrayContaining(['memory_query', 'memory_cursor']));
    expect(decision).toMatchObject({ task: 'RECALL_MEMORY', memoryQuery: 'bread', source: 'openai' });
    expect((await f.task.execute(decision)).status).toBe('succeeded');
    const next = f.state(), result = next.autonomy!.memorySearch as MemorySearchResult;
    expect(result.hits.map(hit => hit.id)).toEqual([old.id]);
    expect(result.hits[0]).toMatchObject({ historicalOnly: true, worldId: 'world-A', preview: { status: 'failed', verified: false } });
    expect(next.targets).toEqual(before.targets);
    expect(f.primitive.runAndWait).toHaveBeenCalledTimes(calls);
    expect(f.experience.evidence([old.id])[0]).toEqual(old);
    reply({ task: 'WAIT', memory_query: null }); await f.policy.decide(next);
    const second = JSON.parse(String(fetchSpy.mock.calls[1][1].body));
    expect(JSON.parse(second.input).autonomy.memorySearch.hits[0].id).toBe(old.id);
    const logs = logSpy.mock.calls.map(([line]: [string]) => JSON.parse(line));
    expect(logs.find(row => row.kind === 'memory_recalled')).toMatchObject({ hit_ids: [{ kind: 'evidence', id: old.id }], world_id: 'world-B' });
  });
  test('recalled saved procedure can be selected and rebound in another world, without replaying merely by reading', async () => {
    const f = fixture(), demonstration = await f.demonstrate();
    const saved = f.experience.save('demonstrated wall', demonstration.map(row => row.id));
    f.memory.setWorldId('world-B'); f.bot.entity.position = new Vec3(300.5, 80, 0.5);
    await f.recall(saved.id);
    expect(searched(f).hits.some(hit => hit.kind === 'procedure' && hit.id === saved.id)).toBe(true);
    expect(f.experience.get(saved.id)?.successes).toBe(0);
    reply({ task: 'RUN_PROCEDURE', procedure_id: saved.id, memory_query: null });
    const decision = await f.policy.decide(f.state());
    expect((await f.task.execute(decision)).status).toBe('succeeded');
    expect(f.experience.get(saved.id)?.successes).toBe(1);
    expect(f.experience.recent(2).every(row => row.worldId === 'world-B' && row.verified)).toBe(true);
    expect(f.experience.recent(2)[0].operation.position).toEqual({ x: 301, y: 80, z: 0 });
    expect(f.experience.evidence(demonstration.map(row => row.id))).toEqual(demonstration);
  });
  test('retrieved parent may support a fresh demonstrated revision, not substitute historical evidence for recent evidence', async () => {
    const f = fixture(), old = await f.demonstrate(), parent = f.experience.save('parent', old.map(row => row.id));
    const fresh = await f.demonstrate('oak_planks', 2);
    await f.recall(parent.id);
    const input = f.state(); input.autonomy!.learnedProcedures = []; // Isolate the queried-parent path from the ordinary preview.
    reply({ task: 'SAVE_PROCEDURE', memory_query: null, procedure_id: parent.id,
      procedure_name: 'changed placement', evidence_ids: fresh.map(row => row.id), reason: 'A different demonstrated material.' });
    const decision = await f.policy.decide(input);
    expect(decision.task).toBe('SAVE_PROCEDURE'); expect((await f.task.execute(decision)).status).toBe('succeeded');
    const child = f.experience.list().find(p => p.parentId === parent.id)!;
    expect(child.evidenceIds).toEqual(fresh.map(row => row.id));
    expect(f.experience.get(parent.id)).toEqual(parent);
    const historicalOnly = f.state(); historicalOnly.autonomy!.recentExperience = [];
    reply({ task: 'SAVE_PROCEDURE', memory_query: null, procedure_name: 'not permitted', evidence_ids: old.map(row => row.id) });
    expect(await f.policy.decide(historicalOnly)).toMatchObject({ task: 'WAIT', source: 'fallback', reason: 'procedure_evidence_not_presented' });
  });
  test('world or dimension change hides the query workspace without deleting history', async () => {
    const f = fixture(), rows = await f.demonstrate(); await f.recall('stone');
    expect(searched(f).hits.length).toBeGreaterThan(0);
    f.bot.game.dimension = 'the_nether'; expect(f.state().autonomy!.memorySearch).toBeNull();
    f.bot.game.dimension = 'overworld'; f.memory.setWorldId('world-C'); expect(f.state().autonomy!.memorySearch).toBeNull();
    expect(f.experience.evidence(rows.map(row => row.id))).toEqual(rows);
  });
  test('ordinary capture and WAIT selection do not automatically query the database', async () => {
    const f = fixture(), spy = jest.spyOn(f.experience, 'search');
    f.state(); f.state(); reply({ task: 'WAIT', memory_query: null });
    expect((await f.policy.decide(f.state())).task).toBe('WAIT'); expect(spy).not.toHaveBeenCalled();
  });
  test('stopped execution cannot issue a late query', async () => {
    const f = fixture(), spy = jest.spyOn(f.experience, 'search'); f.task.stop();
    expect((await f.recall('stone')).status).toBe('interrupted'); expect(spy).not.toHaveBeenCalled();
  });
  test.each([null, '', 'x'.repeat(300)])('invalid model query %p falls back without read or physical execution', async query => {
    const f = fixture(), spy = jest.spyOn(f.experience, 'search'); reply({ memory_query: query });
    expect(await f.policy.decide(f.state())).toMatchObject({ task: 'WAIT', source: 'fallback' });
    expect(spy).not.toHaveBeenCalled(); expect(f.primitive.runAndWait).not.toHaveBeenCalled();
  });
  test('invalid direct executor request fails without adding operation evidence or learning statistics', async () => {
    const f = fixture(); expect((await f.recall('')).status).toBe('failed');
    expect(f.experience.recent()).toEqual([]); expect(f.memory.recall({ includeWorld: false })).toEqual([]);
    expect(f.primitive.runAndWait).not.toHaveBeenCalled();
  });
  test('model-selected continuation reaches older matching evidence and reports coverage', async () => {
    const f = fixture(); await f.execute({ action: 'USE', item: 'bread' }); const old = f.experience.recent()[0];
    for (let i = 0; i < 80; i++) f.experience.append({ ...old, operation: { action: 'WAIT', durationMs: 100 }, detail: 'unrelated', effect: '{}', status: 'succeeded', verified: false });
    await f.recall('bread'); const first = searched(f);
    expect(first).toMatchObject({ hits: [], coverage: 'partial' });
    reply({ memory_cursor: first.nextCursor });
    const decision = await f.policy.decide(f.state()); expect(decision.memoryCursor).toBe(first.nextCursor);
    expect((await f.task.execute(decision)).status).toBe('succeeded');
    expect(searched(f).hits.map(hit => hit.id)).toEqual([old.id]);
  });
});
