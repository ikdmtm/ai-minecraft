import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { ExecutivePolicy } from './executivePolicy.js';
import { ExperienceMemory, type Evidence } from './experienceMemory.js';
import { WorldMemory } from './worldMemory.js';
import { SemanticWorldModel } from './semanticWorldModel.js';
import { TaskExecutor } from './taskExecutor.js';
import { SharedStateBus } from '../cognitive/sharedState.js';
import type { PrimitiveOperation } from './primitiveOperations.js';
import type { ExecutiveWorldState } from './executiveTypes.js';

const registry = require('prismarine-registry')('1.21.4');

/** Transport and physical results are controlled. The policy, snapshots, task
 * executor, effect assessment and SQLite storage below are the real classes.
 * No Minecraft connection or paid model request is made by this suite. */
describe('T05a evidence-backed model procedure selection', () => {
  let directory: string;
  let fetchSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const closables: Array<{ close(): void }> = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'procedure-selection-'));
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_test_network_request'));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const object of closables.splice(0)) object.close();
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function fixture() {
    const db = join(directory, 'memory.sqlite');
    const memory = new WorldMemory(db, 'selection-world');
    const experience = new ExperienceMemory(db);
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
          boundingBox: name === 'air' ? 'empty' : 'block', diggable: name !== 'air',
          getProperties: () => ({}) };
      }),
    });
    const shared = new SharedStateBus();
    const semantic = new SemanticWorldModel(bot, shared, undefined, memory, experience);
    const primitive: any = {
      snapshot: () => ({}), stop: jest.fn(),
      runAndWait: jest.fn(async (decision: { operation: PrimitiveOperation }) => {
        const op = decision.operation;
        if (op.action === 'PLACE' && op.position && op.item) {
          blocks.set(`${op.position.x}:${op.position.y}:${op.position.z}`, op.item);
        }
        return { action: 'OPERATE', status: 'succeeded', detail: `operation_completed:${op.action}` };
      }),
    };
    const task = new TaskExecutor(bot, shared, primitive, { capture: () => ({}) } as any, semantic, memory, experience);
    const policy = new ExecutivePolicy({ provider: 'openai', openaiApiKey: 'fixture-not-a-key',
      openaiModel: 'fixture-model', timeoutMs: 1000 });
    const state = () => semantic.capture(task.snapshot());
    const demonstrate = async () => {
      for (const y of [64, 65]) {
        const result = await task.execute({ task: 'EXECUTE_OPERATION',
          operation: { action: 'PLACE', item: 'stone', position: { x: 1, y, z: 0 } },
          source: 'openai', confidence: 1, basedOnRevision: 1 });
        expect(result.status).toBe('succeeded');
      }
      const traces = experience.recent();
      expect(traces).toHaveLength(2);
      expect(traces.every(e => e.status === 'succeeded' && e.verified)).toBe(true);
      expect(experience.list()).toEqual([]); // Demonstration alone must NOT learn/save automatically.
      return traces;
    };
    return { db, bot, memory, experience, shared, semantic, primitive, task, policy, state, demonstrate };
  }

  function answer(ids: unknown, overrides: Record<string, unknown> = {}) {
    return { task: 'SAVE_PROCEDURE', affordance_id: 'none', operation: null,
      knowledge_query: null, knowledge_offset: null, procedure_id: null,
      procedure_name: '  自分で試した2段の配置  ', evidence_ids: ids,
      confidence: 0.8, reason: 'Controlled model choice, not a spontaneous learning claim.', ...overrides };
  }
  function response(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as Response;
  }
  function reply(ids: unknown, overrides: Record<string, unknown> = {}) {
    fetchSpy.mockResolvedValueOnce(response({ output_text: JSON.stringify(answer(ids, overrides)) }));
  }
  function presented(state: ExecutiveWorldState): Evidence[] {
    return state.autonomy!.recentExperience as Evidence[];
  }
  function logs(kind: string) {
    return logSpy.mock.calls.map(([text]: [string]) => JSON.parse(text)).filter(row => row.kind === kind);
  }

  test.each(['output_text', 'content'])('model %s response uses actually presented IDs, saves and exposes a candidate', async envelope => {
    const f = fixture(), traces = await f.demonstrate(), initial = f.state();
    const originalEvidence = f.experience.evidence(traces.map(e => e.id));
    let request: any;
    fetchSpy.mockImplementationOnce(async (_url: unknown, options: RequestInit) => {
      request = JSON.parse(String(options.body));
      const input = JSON.parse(request.input);
      const ids = (input.autonomy.recentExperience as Evidence[]).map(e => e.id);
      const text = JSON.stringify(answer(ids));
      return response(envelope === 'output_text' ? { output_text: text } : {
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      });
    });
    const decision = await f.policy.decide(initial);
    expect(request.text.format.schema.properties.task.enum).toContain('SAVE_PROCEDURE');
    expect(request.text.format.schema.required).toEqual(expect.arrayContaining(['procedure_name', 'evidence_ids']));
    expect(presented(JSON.parse(request.input))).toEqual(originalEvidence);
    expect(decision).toMatchObject({ task: 'SAVE_PROCEDURE', source: 'openai',
      procedureName: '自分で試した2段の配置', evidenceIds: traces.map(e => e.id), basedOnRevision: initial.revision });
    expect(f.experience.list()).toEqual([]); // Policy inference has no storage side effect.
    const result = await f.task.execute(decision);
    const saved = f.experience.list()[0];
    expect(result).toEqual({ status: 'succeeded', detail: `procedure_saved:${saved.id}:candidate` });
    expect(saved).toMatchObject({ name: decision.procedureName, status: 'candidate', successes: 0,
      failures: 0, evidenceIds: traces.map(e => e.id) });
    expect(saved.steps.map(s => s.operation.action)).toEqual(['PLACE', 'PLACE']);
    expect(saved.steps.every(s => s.operation.position === undefined)).toBe(true);
    expect(f.primitive.runAndWait).toHaveBeenCalledTimes(2); // Saving does not execute a replay.
    expect(f.experience.evidence(saved.evidenceIds)).toEqual(originalEvidence);
    expect(f.state().autonomy!.learnedProcedures).toEqual([expect.objectContaining({ id: saved.id, status: 'candidate' })]);
    expect(logs('executive_decision').at(-1)).toMatchObject({ evidence_ids: saved.evidenceIds, procedure_name: saved.name });
    expect(logs('procedure_saved').at(-1)).toMatchObject({ procedure_id: saved.id, evidence_ids: saved.evidenceIds, procedure_status: 'candidate' });
  });

  test('a model choosing WAIT after valid evidence never triggers automatic saving', async () => {
    const f = fixture(); await f.demonstrate();
    reply([], { task: 'WAIT', procedure_name: null });
    expect((await f.policy.decide(f.state())).task).toBe('WAIT');
    expect(f.experience.list()).toEqual([]);
    expect(logs('procedure_saved')).toEqual([]);
  });

  test.each([
    ['blank name', '   ', 'valid', 'procedure_invalid_request'],
    ['long name', 'x'.repeat(121), 'valid', 'procedure_invalid_request'],
    ['non-text name', 42, 'valid', 'procedure_invalid_request'],
    ['missing IDs', 'name', null, 'procedure_invalid_request'],
    ['non-array IDs', 'name', 'not-an-array', 'procedure_invalid_request'],
    ['one ID', 'name', 'one', 'procedure_invalid_request'],
    ['duplicate IDs', 'name', 'duplicate', 'procedure_invalid_request'],
    ['invented ID', 'name', 'invented', 'procedure_evidence_not_presented'],
    ['non-text ID', 'name', 'number', 'procedure_invalid_request'],
    ['too many IDs', 'name', 'many', 'procedure_invalid_request'],
    ['reverse order', 'name', 'reverse', 'procedure_requires_contiguous_demonstration'],
  ])('rejects %s without saving or changing the evidence', async (_label, name, mode, error) => {
    const f = fixture(), traces = await f.demonstrate(), ids = traces.map(e => e.id);
    const variants: Record<string, unknown> = { valid: ids, one: [ids[0]], duplicate: [ids[0], ids[0]],
      invented: [ids[0], 'not-an-evidence-id'], number: [ids[0], 123], many: Array.from({ length: 13 }, (_, i) => `id-${i}`), reverse: [...ids].reverse() };
    reply(typeof mode === 'string' && mode in variants ? variants[mode] : mode, { procedure_name: name });
    const decision = await f.policy.decide(f.state());
    expect(decision).toMatchObject({ task: 'WAIT', source: 'fallback', reason: error });
    expect(decision.evidenceIds).toBeUndefined();
    expect(f.experience.list()).toEqual([]); expect(f.experience.evidence(ids)).toEqual(traces);
  });

  test.each(['failed', 'interrupted', 'unconfirmed'])('does not select %s evidence as a demonstrated procedure', async outcome => {
    const f = fixture(), traces = await f.demonstrate(), state = f.state();
    const selected = presented(state);
    selected[1] = { ...selected[1], status: outcome === 'unconfirmed' ? 'succeeded' : outcome as 'failed' | 'interrupted', verified: false };
    reply(traces.map(e => e.id));
    expect(await f.policy.decide(state)).toMatchObject({ task: 'WAIT', source: 'fallback', reason: 'procedure_requires_verified_evidence' });
    expect(f.experience.list()).toEqual([]);
  });

  test.each(['sessionId', 'worldId', 'version', 'dimension', 'sequence'])('rejects a demonstration crossing %s', async boundary => {
    const f = fixture(), traces = await f.demonstrate(), state = f.state();
    const selected = presented(state);
    selected[1] = { ...selected[1], [boundary]: boundary === 'sequence' ? selected[1].sequence + 1 : 'other-context' };
    reply(traces.map(e => e.id));
    expect(await f.policy.decide(state)).toMatchObject({ task: 'WAIT', source: 'fallback', reason: 'procedure_requires_contiguous_demonstration' });
    expect(f.experience.list()).toEqual([]);
  });

  test('existing database IDs not presented in this request are not guessed or silently substituted', async () => {
    const f = fixture(), traces = await f.demonstrate(), state = f.state();
    state.autonomy!.recentExperience = [];
    reply(traces.map(e => e.id));
    expect(await f.policy.decide(state)).toMatchObject({ task: 'WAIT', source: 'fallback', reason: 'procedure_evidence_not_presented' });
    expect(f.experience.evidence(traces.map(e => e.id))).toHaveLength(2); expect(f.experience.list()).toEqual([]);
  });

  test('database still rejects fabricated evidence if the policy boundary is bypassed', async () => {
    const f = fixture(), traces = await f.demonstrate();
    const result = await f.task.execute({ task: 'SAVE_PROCEDURE', procedureName: 'not demonstrated',
      evidenceIds: [traces[0].id, 'invented'], source: 'openai', confidence: 1, basedOnRevision: 1 });
    expect(result).toEqual({ status: 'failed', detail: 'procedure_evidence_missing' });
    expect(f.experience.list()).toEqual([]); expect(f.primitive.runAndWait).toHaveBeenCalledTimes(2);
  });

  test('repeated model SAVE preserves and reports the actual persisted status', async () => {
    const f = fixture(), traces = await f.demonstrate(), ids = traces.map(e => e.id);
    reply(ids); await f.task.execute(await f.policy.decide(f.state()));
    const id = f.experience.list()[0].id;
    // Synthetic replay counters only: this test does not claim actual skill reuse.
    f.experience.recordReplay(id, true); f.experience.recordReplay(id, true);
    const before = f.experience.get(id)!;
    reply(ids, { procedure_name: 'another proposed label' });
    expect(await f.task.execute(await f.policy.decide(f.state()))).toEqual({ status: 'succeeded', detail: `procedure_saved:${id}:verified` });
    expect(f.experience.get(id)).toEqual(before); expect(f.experience.list()).toHaveLength(1);
    expect(logs('procedure_saved').at(-1)).toMatchObject({ procedure_id: id, procedure_name: before.name, procedure_status: 'verified' });
  });

  test('saved candidate and original evidence appear after SQLite reopen', async () => {
    const f = fixture(), traces = await f.demonstrate();
    reply(traces.map(e => e.id)); await f.task.execute(await f.policy.decide(f.state()));
    const saved = f.experience.list()[0]; f.experience.close();
    const reopened = new ExperienceMemory(f.db); closables.push(reopened);
    const semantic = new SemanticWorldModel(f.bot, f.shared, undefined, f.memory, reopened);
    expect(semantic.capture(f.task.snapshot()).autonomy!.learnedProcedures).toEqual([
      expect.objectContaining({ id: saved.id, evidenceIds: saved.evidenceIds, status: 'candidate' }),
    ]);
    expect(reopened.evidence(saved.evidenceIds)).toEqual(traces);
  });

  test.each(['malformed', 'incomplete', 'refusal', 'transport'])('a %s model response cannot save a procedure', async fault => {
    const f = fixture(); await f.demonstrate();
    if (fault === 'transport') fetchSpy.mockRejectedValueOnce(new Error('fixture_transport_error'));
    else fetchSpy.mockResolvedValueOnce(response(fault === 'malformed' ? { output_text: '{' } :
      fault === 'incomplete' ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } :
      { output: [{ content: [{ type: 'refusal', refusal: 'fixture refusal' }] }] }));
    expect(await f.policy.decide(f.state())).toMatchObject({ task: 'WAIT', source: 'fallback' });
    expect(f.experience.list()).toEqual([]); expect(logs('procedure_saved')).toEqual([]);
  });

  test('a delayed valid save response cannot write after the task runtime was stopped', async () => {
    const f = fixture(), traces = await f.demonstrate();
    let release!: (value: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const pending = f.policy.decide(f.state()); f.task.stop();
    release(response({ output_text: JSON.stringify(answer(traces.map(e => e.id))) }));
    const decision = await pending;
    expect(decision.task).toBe('SAVE_PROCEDURE');
    expect(await f.task.execute(decision)).toEqual({ status: 'interrupted', detail: 'runtime_stopped' });
    expect(f.experience.list()).toEqual([]); expect(f.experience.recent()).toEqual(traces);
  });

  test('JEV choice-only path explicitly remains outside the SAVE_PROCEDURE acceptance scope', async () => {
    const f = fixture(); await f.demonstrate();
    fetchSpy.mockResolvedValueOnce(response({ answers: { task: { choice: 'WAIT', confidence: 1 }, affordance: { choice: 'none' } } }));
    const policy = new ExecutivePolicy({ provider: 'jev', typesafeApiKey: 'fixture-not-a-key', openaiApiKey: 'unused-fixture' });
    expect((await policy.decide(f.state())).source).toBe('jev');
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
    expect(Object.keys(body.questions.task.criteria).sort()).toEqual(['EXECUTE_AFFORDANCE', 'WAIT']);
    expect(f.experience.list()).toEqual([]);
  });
});
