import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Vec3 } from 'vec3';
import { ExperienceMemory, type Evidence } from './experienceMemory.js';
import { WorldMemory } from './worldMemory.js';
import { SemanticWorldModel } from './semanticWorldModel.js';
import { TaskExecutor } from './taskExecutor.js';
import { ExecutivePolicy } from './executivePolicy.js';
import { SharedStateBus } from '../cognitive/sharedState.js';
import type { ExecutiveDecision, ExecutiveWorldState } from './executiveTypes.js';
import type { PrimitiveOperation } from './primitiveOperations.js';
import type { MemoryNoteInput } from './memoryConsolidation.js';

const registry = require('prismarine-registry')('1.21.4');
const inputNote = (changes: Partial<MemoryNoteInput> = {}): MemoryNoteInput => ({ kind: 'summary',
  title: '配置の記録', content: 'この場所では2回の配置結果を確認した。他の場所での成功は未確認。',
  parentId: null, state: 'candidate', ...changes });

/** Real policy/parser/tasks/assessment/SQLite. Physical effects and the model
 * transport are fixtures; these are not spontaneous-learning/live-game tests. */
describe('T06b model-selected consolidation path', () => {
  let directory: string, fetchSpy: jest.SpyInstance;
  const closables: Array<{ close(): void }> = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'note-integration-'));
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_test_network'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const item of closables.splice(0)) item.close();
    jest.restoreAllMocks(); rmSync(directory, { recursive: true, force: true });
  });
  function fixture() {
    const path = join(directory, 'memory.sqlite'), memory = new WorldMemory(path, 'note-world'), experience = new ExperienceMemory(path);
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
        return { name, stateId: name === 'air' ? 0 : 1, position: p.clone(),
          boundingBox: name === 'air' ? 'empty' : 'block', diggable: name !== 'air', getProperties: () => ({}) };
      }),
    });
    const shared = new SharedStateBus(), semantic = new SemanticWorldModel(bot, shared, undefined, memory, experience);
    const primitive: any = { snapshot: () => ({}), stop: jest.fn(), runAndWait: jest.fn(async (d: { operation: PrimitiveOperation }) => {
      const op = d.operation;
      if (op.action === 'PLACE' && op.item && op.position) blocks.set(`${op.position.x}:${op.position.y}:${op.position.z}`, op.item);
      return { action: 'OPERATE', status: 'succeeded', detail: `operation_completed:${op.action}` };
    }) };
    const task = new TaskExecutor(bot, shared, primitive, { capture: () => ({}) } as any, semantic, memory, experience);
    const policy = new ExecutivePolicy({ provider: 'openai', openaiApiKey: 'fixture-not-a-key', openaiModel: 'fixture-model' });
    const state = () => semantic.capture(task.snapshot());
    const demonstrate = async () => {
      for (const y of [64, 65]) await task.execute({ task: 'EXECUTE_OPERATION',
        operation: { action: 'PLACE', item: 'stone', position: { x: 1, y, z: 0 } }, source: 'openai', confidence: 1, basedOnRevision: 1 });
      return experience.recent() as Evidence[];
    };
    const context = () => ({ worldId: memory.getWorldId(), version: bot.version, dimension: bot.game.dimension });
    return { path, memory, experience, bot, primitive, task, policy, semantic, state, demonstrate, context };
  }
  function answer(ids: string[], changes: Record<string, unknown> = {}) {
    return { task: 'CONSOLIDATE_MEMORY', confidence: 0.8, affordance_id: 'none', operation: null,
      knowledge_query: null, knowledge_offset: null, memory_query: null, memory_cursor: null,
      memory_note: inputNote(), evidence_ids: ids, procedure_name: null, procedure_id: null,
      reason: 'Controlled interpretation for an integration test.', ...changes };
  }
  function response(text: string): Response {
    return { ok: true, json: async () => ({ output_text: text }) } as Response;
  }
  function reply(ids: string[], changes: Record<string, unknown> = {}) {
    fetchSpy.mockResolvedValueOnce(response(JSON.stringify(answer(ids, changes))));
  }
  function noteId(detail: string): string {
    const matched = detail.match(/memory_note_saved:(note:[a-f0-9]+)/);
    expect(matched).not.toBeNull(); return matched![1];
  }
  function command(ids: string[], changes: Partial<ExecutiveDecision> = {}): ExecutiveDecision {
    return { task: 'CONSOLIDATE_MEMORY', memoryNote: inputNote(), evidenceIds: ids, reason: 'test interpretation',
      source: 'openai', confidence: 1, basedOnRevision: 1, ...changes };
  }

  test.each(['output_text', 'content'])('model %s -> actual save -> recall -> next input -> reopen', async envelope => {
    const f = fixture(), traces = await f.demonstrate(), ids = traces.map(e => e.id);
    expect(traces.every(e => e.verified)).toBe(true);
    let request: any;
    fetchSpy.mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
      request = JSON.parse(String(init.body));
      const sent = JSON.parse(request.input), text = JSON.stringify(answer(sent.autonomy.recentExperience.map((e: Evidence) => e.id)));
      return { ok: true, json: async () => envelope === 'output_text' ? { output_text: text } : {
        output: [{ content: [{ type: 'output_text', text }] }],
      } } as Response;
    });
    const selected = await f.policy.decide(f.state());
    expect(request.text.format.schema.properties.task.enum).toContain('CONSOLIDATE_MEMORY');
    expect(request.text.format.schema.required).toContain('memory_note');
    expect(f.experience.notes.history('anything')).toEqual([]); // No save merely from inference.
    const result = await f.task.execute(selected), id = noteId(result.detail);
    expect(result.status).toBe('succeeded'); expect(f.primitive.runAndWait).toHaveBeenCalledTimes(2);
    expect(f.experience.evidence(ids)).toEqual(traces); expect(f.experience.list()).toEqual([]);
    reply([], { task: 'RECALL_MEMORY', memory_note: null, memory_query: id });
    await f.task.execute(await f.policy.decide(f.state()));
    const next = f.state();
    expect((next.autonomy!.memorySearch as any).hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, historicalOnly: true, preview: expect.objectContaining({ interpretationOnly: true, isCurrent: true }) }),
    ]));
    expect(next.targets.some(t => t.id.includes(id))).toBe(false);
    fetchSpy.mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
      const sent = JSON.parse(JSON.parse(String(init.body)).input);
      expect(sent.autonomy.memorySearch.hits.some((h: any) => h.id === id)).toBe(true);
      return response(JSON.stringify(answer([], { task: 'WAIT', memory_note: null })));
    });
    await f.policy.decide(next);
    const saved = f.experience.notes.get(id); f.experience.close();
    const reopened = new ExperienceMemory(f.path); closables.push(reopened);
    expect(reopened.notes.get(id)).toEqual(saved); expect(reopened.evidence(ids)).toEqual(traces);
  });
  test('model correction and withdrawal retain the originals and clear stale search workspace', async () => {
    const f = fixture(), traces = await f.demonstrate(), ids = traces.map(e => e.id);
    reply(ids); const first = noteId((await f.task.execute(await f.policy.decide(f.state()))).detail);
    const original = f.experience.notes.get(first);
    f.experience.search(f.context(), { query: first });
    reply(ids, { memory_note: inputNote({ parentId: first, kind: 'lesson', content: 'この解釈は未確定。' }) });
    const second = noteId((await f.task.execute(await f.policy.decide(f.state()))).detail);
    expect(f.state().autonomy!.memorySearch).toBeNull();
    f.experience.search(f.context(), { query: second });
    reply(ids, { memory_note: inputNote({ parentId: second, state: 'withdrawn', content: '教訓を撤回する。' }) });
    const third = noteId((await f.task.execute(await f.policy.decide(f.state()))).detail);
    expect(f.experience.notes.get(first)).toEqual(original);
    expect(f.experience.notes.get(third)?.state).toBe('withdrawn');
    expect(f.experience.notes.history(first)).toHaveLength(3); expect(f.primitive.runAndWait).toHaveBeenCalledTimes(2);
  });
  test('old failed evidence may inform a note only after retrieval, not as new live observation', async () => {
    const f = fixture();
    f.primitive.runAndWait.mockResolvedValueOnce({ action: 'OPERATE', status: 'failed', detail: 'blocked' });
    await f.task.execute({ task: 'EXECUTE_OPERATION', operation: { action: 'PLACE', item: 'stone', position: { x: 1, y: 64, z: 0 } },
      source: 'openai', confidence: 1, basedOnRevision: 1 });
    const old = f.experience.recent()[0]; expect(old.status).toBe('failed');
    f.memory.startNewWorld(); expect(f.state().autonomy!.recentExperience).toEqual([]);
    reply([old.id]); expect((await f.policy.decide(f.state())).source).toBe('fallback');
    f.experience.search(f.context(), { query: old.id });
    reply([old.id]); const result = await f.task.execute(await f.policy.decide(f.state()));
    const n = f.experience.notes.get(noteId(result.detail))!;
    expect(n.sources[0]).toMatchObject({ id: old.id, status: 'failed', verified: false, worldId: old.worldId });
    expect(f.experience.evidence([old.id])[0]).toEqual(old);
  });
  test('superseded parent in an old model decision is rejected again at execution', async () => {
    const f = fixture(), ids = (await f.demonstrate()).map(e => e.id);
    const first = f.experience.consolidate(f.context(), inputNote(), ids, 'initial');
    f.experience.search(f.context(), { query: first.id });
    reply(ids, { memory_note: inputNote({ parentId: first.id, content: 'stale edit' }) });
    const decision = await f.policy.decide(f.state());
    f.experience.consolidate(f.context(), inputNote({ parentId: first.id, content: 'newer edit' }), ids, 'new');
    const result = await f.task.execute(decision);
    expect(result.status).toBe('failed'); expect(f.experience.notes.history(first.id)).toHaveLength(2);
  });
  test.each([
    { evidence_ids: ['invented'] }, { evidence_ids: [] }, { memory_note: null },
    { memory_note: inputNote({ parentId: 'invented' }) }, { memory_note: { ...inputNote(), state: 'verified' } },
  ])('rejects invalid structured selection %j without saving', async bad => {
    const f = fixture(), ids = (await f.demonstrate()).map(e => e.id);
    reply(ids, bad); expect((await f.policy.decide(f.state())).source).toBe('fallback');
    expect(f.experience.search(f.context(), { query: '配置の記録' }).hits.filter(h => h.kind === 'note')).toEqual([]);
  });
  test('bypassing policy does not allow fabricated evidence', async () => {
    const f = fixture();
    expect((await f.task.execute(command(['invented']))).status).toBe('failed');
    expect(f.primitive.runAndWait).not.toHaveBeenCalled();
  });
  test('stopped runtime does not write interpretations', async () => {
    const f = fixture(), ids = (await f.demonstrate()).map(e => e.id); f.task.stop();
    expect((await f.task.execute(command(ids))).status).toBe('interrupted');
    expect(f.experience.search(f.context(), { query: '配置の記録' }).hits.filter(h => h.kind === 'note')).toEqual([]);
  });
  test.each(['world', 'dimension'])('%s changes before commit interrupt consolidation', async change => {
    const f = fixture(), ids = (await f.demonstrate()).map(e => e.id);
    const capture = f.semantic.capture.bind(f.semantic);
    jest.spyOn(f.semantic, 'capture').mockImplementationOnce(active => {
      const state = capture(active);
      if (change === 'world') f.memory.startNewWorld(); else f.bot.game.dimension = 'the_nether';
      return state;
    });
    expect((await f.task.execute(command(ids))).status).toBe('interrupted');
    expect(f.experience.search(f.context(), { query: '配置の記録' }).hits.filter(h => h.kind === 'note')).toEqual([]);
  });
  test('malformed or incomplete model output does not save a note', async () => {
    const f = fixture();
    fetchSpy.mockResolvedValueOnce(response('{bad'));
    expect((await f.policy.decide(f.state())).source).toBe('fallback');
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'incomplete', output_text: '{}' }) } as Response);
    expect((await f.policy.decide(f.state())).source).toBe('fallback');
    expect(f.experience.recent()).toEqual([]);
  });
  test('choosing another task does not trigger automatic consolidation', async () => {
    const f = fixture(), ids = (await f.demonstrate()).map(e => e.id);
    reply(ids, { task: 'WAIT' }); expect((await f.policy.decide(f.state())).task).toBe('WAIT');
    expect(f.experience.search(f.context(), { query: '配置の記録' }).hits.filter(h => h.kind === 'note')).toEqual([]);
  });
});
