import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Vec3 } from 'vec3';
import { ExperienceMemory, type Evidence, type LearnedProcedure, type ReplayAttemptInput } from './experienceMemory.js';
import { WorldMemory } from './worldMemory.js';
import { TaskExecutor } from './taskExecutor.js';
import { SemanticWorldModel } from './semanticWorldModel.js';
import { ExecutivePolicy } from './executivePolicy.js';
import { SharedStateBus } from '../cognitive/sharedState.js';
import type { PrimitiveOperation } from './primitiveOperations.js';

const registry = require('prismarine-registry')('1.21.4');

/** Real task/assessment/storage/policy classes; only physical state changes and
 * model transport are controlled. No live server or paid inference in this suite. */
describe('T05c evidence-backed procedure reevaluation and revision', () => {
  let directory: string;
  const closables: Array<{ close(): void }> = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'procedure-revision-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_test_network_request'));
  });
  afterEach(() => {
    for (const object of closables.splice(0)) object.close();
    jest.restoreAllMocks();
    rmSync(directory, { force: true, recursive: true });
  });
  function fixture() {
    const path = join(directory, 'memory.sqlite');
    const memory = new WorldMemory(path, 'revision-world');
    const experience = new ExperienceMemory(path);
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
    const shared = new SharedStateBus();
    const semantic = new SemanticWorldModel(bot, shared, undefined, memory, experience);
    const apply = async ({ operation: op }: { operation: PrimitiveOperation }) => {
      if (op.action === 'PLACE' && op.position && op.item) blocks.set(`${op.position.x}:${op.position.y}:${op.position.z}`, op.item);
      return { action: 'OPERATE', status: 'succeeded', detail: `operation_completed:${op.action}` };
    };
    const primitive: any = { snapshot: () => ({}), stop: jest.fn(), runAndWait: jest.fn(apply) };
    const task = new TaskExecutor(bot, shared, primitive, { capture: () => ({}) } as any, semantic, memory, experience);
    const policy = new ExecutivePolicy({ provider: 'openai', openaiApiKey: 'fixture-not-a-key', openaiModel: 'fixture-model', timeoutMs: 1000 });
    const decision = { source: 'openai' as const, confidence: 1, basedOnRevision: 1 };
    const demonstrate = async (item = 'stone', dx = 1): Promise<Evidence[]> => {
      blocks.clear(); // Test fixture setup, never a runtime auto-repair.
      for (const y of [64, 65]) {
        const result = await task.execute({ ...decision, task: 'EXECUTE_OPERATION',
          operation: { action: 'PLACE', item, position: { x: dx, y, z: 0 } } });
        expect(result.status).toBe('succeeded');
      }
      const traces = experience.recent(2);
      expect(traces.every(trace => trace.verified && trace.status === 'succeeded')).toBe(true);
      return traces;
    };
    const saved = async () => experience.save('original', (await demonstrate()).map(trace => trace.id));
    const run = async (procedure: LearnedProcedure) => {
      blocks.clear();
      return task.execute({ ...decision, task: 'RUN_PROCEDURE', procedureId: procedure.id });
    };
    const revise = (parent: LearnedProcedure, traces: Evidence[], name = 'changed') => task.execute({
      ...decision, task: 'SAVE_PROCEDURE', procedureId: parent.id, procedureName: name,
      evidenceIds: traces.map(trace => trace.id), reason: 'A demonstrated change; effectiveness is still a hypothesis.',
    });
    return { path, memory, experience, bot, blocks, shared, semantic, task, policy, primitive, apply,
      decision, demonstrate, saved, run, revise };
  }
  const failure = () => ({ action: 'OPERATE', status: 'failed', detail: 'fixture_adapter_failure' });
  const unconfirmed = () => ({ action: 'OPERATE', status: 'succeeded', detail: 'operation_completed:PLACE' });

  test('failure no longer permanently disqualifies a procedure; real replay evidence and all counters remain', async () => {
    const f = fixture(), parent = await f.saved(), original = f.experience.evidence(parent.evidenceIds);
    await f.run(parent); await f.run(parent);
    expect(f.experience.get(parent.id)).toMatchObject({ status: 'verified', successes: 2, failures: 0 });
    f.primitive.runAndWait.mockImplementationOnce(failure);
    expect((await f.run(parent)).status).toBe('failed');
    expect(f.experience.get(parent.id)).toMatchObject({ status: 'candidate', successes: 2, failures: 1, confirmationStreak: 0 });
    await f.run(parent);
    expect(f.experience.get(parent.id)).toMatchObject({ status: 'candidate', failures: 1, confirmationStreak: 1 });
    await f.run(parent);
    expect(f.experience.get(parent.id)).toMatchObject({ status: 'verified', successes: 4, failures: 1, confirmationStreak: 2 });
    const history = f.experience.replayHistory(parent.id);
    expect(history.map(row => row.outcome)).toEqual(['succeeded', 'succeeded', 'failed', 'succeeded', 'succeeded']);
    expect(history.every(row => row.source === 'runtime' && row.evidenceIds.length > 0)).toBe(true);
    for (const row of history) {
      expect(row.worldId).toBe('revision-world');
      expect(row.evidenceIds.some(id => parent.evidenceIds.includes(id))).toBe(false);
      const traces = f.experience.evidence(row.evidenceIds);
      expect(traces.every(trace => trace.sessionId === row.sessionId)).toBe(true);
      if (row.outcome === 'succeeded') expect(traces.every(trace => trace.status === 'succeeded' && trace.verified)).toBe(true);
    }
    expect(history[2].after.failures).toBe(1);
    expect(history[4].before.status).toBe('candidate'); expect(history[4].after.status).toBe('verified');
    expect(f.experience.evidence(parent.evidenceIds)).toEqual(original);
    const snapshot = f.semantic.capture(f.task.snapshot());
    expect(snapshot.autonomy!.learnedProcedures).toContainEqual(expect.objectContaining({ id: parent.id, status: 'verified', failures: 1 }));
  });

  test('another real failure resets confirmation streak without removing earlier attempts', async () => {
    const f = fixture(), p = await f.saved();
    f.primitive.runAndWait.mockImplementationOnce(failure); await f.run(p); await f.run(p);
    f.primitive.runAndWait.mockImplementationOnce(failure); await f.run(p); await f.run(p);
    expect(f.experience.get(p.id)).toMatchObject({ successes: 2, failures: 2, status: 'candidate', confirmationStreak: 1 });
    await f.run(p);
    expect(f.experience.get(p.id)).toMatchObject({ successes: 3, failures: 2, status: 'verified' });
    expect(f.experience.replayHistory(p.id)).toHaveLength(5);
  });

  test.each(['unconfirmed', 'interrupted', 'missing_binding'])('%s attempt is journaled without changing evaluation', async mode => {
    const f = fixture(), p = await f.saved();
    await f.run(p); const before = f.experience.get(p.id);
    if (mode === 'unconfirmed') f.primitive.runAndWait.mockImplementationOnce(unconfirmed);
    else if (mode === 'interrupted') f.primitive.runAndWait.mockResolvedValueOnce({ action: 'OPERATE', status: 'interrupted', detail: 'fixture_safety' });
    else {
      const sql = new Database(f.path);
      const edited = { ...before!, steps: [{ operation: { action: 'OPEN' }, binding: { kind: 'block', name: 'furnace' } }, before!.steps[1]] };
      sql.prepare('UPDATE autonomy_procedures SET payload=? WHERE id=?').run(JSON.stringify(edited), p.id); sql.close();
    }
    const actualBefore = f.experience.get(p.id), callsBefore = f.primitive.runAndWait.mock.calls.length;
    expect((await f.run(p)).status).toBe('interrupted');
    expect(f.experience.get(p.id)).toEqual(actualBefore);
    const last = f.experience.replayHistory(p.id).at(-1)!;
    expect(last.outcome).toBe(mode === 'unconfirmed' ? 'unconfirmed' : 'interrupted');
    expect(last.before).toEqual(last.after);
    expect(f.primitive.runAndWait.mock.calls.length - callsBefore).toBe(mode === 'missing_binding' ? 0 : 1);
    if (mode !== 'missing_binding') {
      await f.run(p);
      expect(f.experience.get(p.id)?.status).toBe('verified');
    }
  });

  test('partial replay retains its confirmed prefix and stops at an unconfirmed step', async () => {
    const f = fixture(), p = await f.saved();
    f.primitive.runAndWait.mockImplementationOnce(f.apply).mockImplementationOnce(unconfirmed);
    expect((await f.run(p)).status).toBe('interrupted');
    const row = f.experience.replayHistory(p.id)[0];
    expect(row.outcome).toBe('unconfirmed');
    expect(f.experience.evidence(row.evidenceIds).map(trace => trace.verified)).toEqual([true, false]);
    expect(f.experience.get(p.id)).toEqual(p);
  });

  test.each(['stop', 'new_world', 'dimension'])('%s during replay preserves source context and avoids negative learning', async mode => {
    const f = fixture(), p = await f.saved();
    f.primitive.runAndWait.mockImplementationOnce(async () => {
      if (mode === 'stop') f.task.stop();
      if (mode === 'new_world') f.memory.startNewWorld();
      if (mode === 'dimension') f.bot.game.dimension = 'the_nether';
      return unconfirmed();
    });
    expect((await f.run(p)).status).toBe('interrupted');
    const row = f.experience.replayHistory(p.id)[0];
    expect(row).toMatchObject({ outcome: 'interrupted', worldId: 'revision-world', dimension: 'overworld' });
    expect(f.experience.evidence(row.evidenceIds)[0].status).toBe('interrupted');
    expect(f.experience.get(p.id)).toEqual(p);
  });

  test('replay audit and evaluation persist across database reopen', async () => {
    const f = fixture(), p = await f.saved();
    f.primitive.runAndWait.mockImplementationOnce(failure); await f.run(p); await f.run(p); await f.run(p);
    const history = f.experience.replayHistory(p.id), summary = f.experience.get(p.id);
    f.experience.close();
    const reopened = new ExperienceMemory(f.path); closables.push(reopened);
    expect(reopened.replayHistory(p.id)).toEqual(history); expect(reopened.get(p.id)).toEqual(summary);
    expect(reopened.evidence(history[0].evidenceIds)[0].status).toBe('failed');
  });

  test('legacy payloads are unchanged on open; unknown historic order is not converted into a clean streak', async () => {
    const f = fixture(), p = await f.saved(), old = { ...p, successes: 9, failures: 3 };
    const sql = new Database(f.path), original = JSON.stringify(old);
    sql.prepare('UPDATE autonomy_procedures SET payload=? WHERE id=?').run(original, p.id);
    f.experience.close(); const reopened = new ExperienceMemory(f.path); closables.push(reopened);
    expect((sql.prepare('SELECT payload FROM autonomy_procedures WHERE id=?').get(p.id) as any).payload).toBe(original);
    expect(reopened.replayHistory(p.id)).toEqual([]);
    // Compatibility reports are explicitly labeled, never passed off as live replay evidence.
    reopened.recordReplay(p.id, true);
    expect(reopened.get(p.id)).toMatchObject({ status: 'candidate', successes: 10, failures: 3, confirmationStreak: 1 });
    reopened.recordReplay(p.id, true);
    expect(reopened.get(p.id)).toMatchObject({ status: 'verified', successes: 11, failures: 3 });
    expect(reopened.replayHistory(p.id).every(row => row.source === 'legacy_api' && row.evidenceIds.length === 0)).toBe(true);
    sql.close();
  });

  test('same runtime attempt is idempotent and conflicting retry is rejected', async () => {
    const f = fixture(), p = await f.saved(), traces = await f.demonstrate();
    const input: ReplayAttemptInput = { id: 'attempt-1', outcome: 'succeeded', evidenceIds: traces.map(t => t.id),
      detail: 'controlled verified result', worldId: 'revision-world', version: '1.21.4', dimension: 'overworld', startedAt: Date.now() };
    const one = f.experience.recordReplayAttempt(p.id, input), summary = f.experience.get(p.id);
    expect(f.experience.recordReplayAttempt(p.id, input)).toEqual(one);
    expect(f.experience.get(p.id)).toEqual(summary); expect(f.experience.replayHistory(p.id)).toHaveLength(1);
    expect(() => f.experience.recordReplayAttempt(p.id, { ...input, detail: 'different report' })).toThrow('id_conflict');
    expect(f.experience.get(p.id)).toEqual(summary);
  });

  test.each(['invented', 'partial_success', 'false_failure', 'wrong_world'])('rejects %s runtime report without counter/audit mutation', async mode => {
    const f = fixture(), p = await f.saved(), traces = await f.demonstrate();
    const input: ReplayAttemptInput = { id: 'invalid-attempt', outcome: 'succeeded', evidenceIds: traces.map(t => t.id),
      detail: 'fixture', worldId: 'revision-world', version: '1.21.4', dimension: 'overworld', startedAt: Date.now() };
    if (mode === 'invented') input.evidenceIds = ['invented'];
    if (mode === 'partial_success') input.evidenceIds = [traces[0].id];
    if (mode === 'false_failure') input.outcome = 'failed';
    if (mode === 'wrong_world') input.worldId = 'other-world';
    expect(() => f.experience.recordReplayAttempt(p.id, input)).toThrow();
    expect(f.experience.get(p.id)).toEqual(p); expect(f.experience.replayHistory(p.id)).toEqual([]);
  });

  test('summary update rolls back if append-only audit insertion fails', async () => {
    const f = fixture(), p = await f.saved(), sql = new Database(f.path);
    sql.exec("CREATE TRIGGER test_reject_replay BEFORE INSERT ON autonomy_procedure_replays BEGIN SELECT RAISE(ABORT, 'fixture_audit_failure'); END;");
    expect(() => f.experience.recordReplay(p.id, true)).toThrow('fixture_audit_failure');
    expect(f.experience.get(p.id)).toEqual(p); expect(f.experience.replayHistory(p.id)).toEqual([]);
    sql.close();
  });

  test('paged replay history does not discard older failures', async () => {
    const f = fixture(), p = await f.saved();
    f.experience.recordReplay(p.id, false);
    for (let i = 0; i < 35; i++) f.experience.recordReplay(p.id, true);
    expect(f.experience.replayHistory(p.id)).toHaveLength(32);
    expect(f.experience.replayHistory(p.id, 32, 32)[0].outcome).toBe('failed');
    expect(f.experience.get(p.id)?.failures).toBe(1);
  });

  test('a deliberately revised child preserves parent evaluation, source evidence and lineage across reopen', async () => {
    const f = fixture(), p = await f.saved();
    f.primitive.runAndWait.mockImplementationOnce(failure); await f.run(p);
    const parentBefore = f.experience.get(p.id), parentEvidence = f.experience.evidence(p.evidenceIds), parentHistory = f.experience.replayHistory(p.id);
    const revisedTrace = await f.demonstrate('dirt');
    expect((await f.revise(p, revisedTrace)).status).toBe('succeeded');
    const child = f.experience.list().find(row => row.id !== p.id)!;
    expect(child).toMatchObject({ parentId: p.id, rootId: p.id, revision: 2, status: 'candidate', successes: 0, failures: 0 });
    expect(child.evidenceIds).toEqual(revisedTrace.map(t => t.id));
    expect(f.experience.get(p.id)).toEqual(parentBefore); expect(f.experience.evidence(p.evidenceIds)).toEqual(parentEvidence);
    expect(f.experience.replayHistory(p.id)).toEqual(parentHistory);
    await f.run(child); await f.run(child);
    expect(f.experience.get(child.id)?.status).toBe('verified'); expect(f.experience.get(p.id)).toEqual(parentBefore);
    const latestChild = f.experience.get(child.id);
    f.experience.close(); const reopened = new ExperienceMemory(f.path); closables.push(reopened);
    expect(reopened.get(child.id)).toEqual(latestChild); expect(reopened.get(p.id)).toEqual(parentBefore);
    expect(reopened.evidence(child.evidenceIds)).toEqual(revisedTrace);
  });

  test('repeating an explicit revision request returns the same evaluated child without renaming or resetting it', async () => {
    const f = fixture(), p = await f.saved(), traces = await f.demonstrate('dirt');
    const child = f.experience.revise(p.id, 'revision', traces.map(t => t.id), 'demonstrated changed material');
    await f.run(child); await f.run(child);
    const before = f.experience.get(child.id);
    expect(f.experience.revise(p.id, 'another name', traces.map(t => t.id), 'another explanation')).toEqual(before);
    expect(f.experience.list()).toHaveLength(2);
  });

  test('new demonstrated child of a child retains the root and never inherits its counters', async () => {
    const f = fixture(), p = await f.saved(), traces = await f.demonstrate('dirt');
    const child = f.experience.revise(p.id, 'revision', traces.map(t => t.id), 'changed material');
    const nextTrace = await f.demonstrate('cobblestone');
    const grandchild = f.experience.revise(child.id, 'another revision', nextTrace.map(t => t.id), 'another demonstrated material');
    expect(grandchild).toMatchObject({ parentId: child.id, rootId: p.id, revision: 3, successes: 0, failures: 0, status: 'candidate' });
    expect(f.experience.get(child.id)).toEqual(child); expect(f.experience.get(p.id)).toEqual(p);
  });

  test.each(['unchanged', 'parent_evidence', 'missing_parent', 'unconfirmed', 'version', 'dimension', 'blank_reason'])('rejects %s revision without changing old records', async mode => {
    const f = fixture(), p = await f.saved();
    if (mode === 'version') f.bot.version = '1.21.5';
    if (mode === 'dimension') f.bot.game.dimension = 'the_nether';
    const traces = await f.demonstrate(mode === 'unchanged' ? 'stone' : 'dirt');
    let ids = traces.map(t => t.id), parentId = p.id, reason = 'demonstrated revision';
    if (mode === 'parent_evidence') ids = p.evidenceIds;
    if (mode === 'missing_parent') parentId = 'not-a-procedure';
    if (mode === 'blank_reason') reason = ' ';
    if (mode === 'unconfirmed') {
      const row = f.experience.append({ ...traces[1], operation: { action: 'PLACE', item: 'dirt', position: { x: 1, y: 66, z: 0 } }, verified: false });
      ids = [traces[1].id, row.id];
    }
    const before = f.experience.list(), evidence = f.experience.recent();
    expect(() => f.experience.revise(parentId, 'revision', ids, reason)).toThrow();
    expect(f.experience.list()).toEqual(before); expect(f.experience.recent()).toEqual(evidence);
  });

  test('controlled model chooses a presented parent and fresh evidence through the real parsing/save path', async () => {
    const f = fixture(), p = await f.saved(), traces = await f.demonstrate('dirt');
    const state = f.semantic.capture(f.task.snapshot());
    const answer = { task: 'SAVE_PROCEDURE', affordance_id: 'none', operation: null,
      knowledge_query: null, knowledge_offset: null, procedure_id: p.id, procedure_name: 'new demonstrated approach',
      evidence_ids: traces.map(t => t.id), confidence: 0.8, reason: 'Changed the demonstrated material.' };
    (globalThis.fetch as jest.Mock).mockImplementationOnce(async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(String(options.body));
      expect(request.instructions).toContain('To revise a learned procedure');
      expect(JSON.parse(request.input).autonomy.learnedProcedures).toContainEqual(expect.objectContaining({ id: p.id }));
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(answer) }) } as Response;
    });
    const selection = await f.policy.decide(state);
    expect(selection).toMatchObject({ task: 'SAVE_PROCEDURE', procedureId: p.id, evidenceIds: traces.map(t => t.id) });
    expect(f.experience.list()).toHaveLength(1); // Inference alone does not persist.
    expect((await f.task.execute(selection)).status).toBe('succeeded');
    expect(f.experience.list().find(row => row.parentId === p.id)?.status).toBe('candidate');
    expect(f.experience.get(p.id)).toEqual(p);
  });

  test.each(['not_presented', 'invalid_parent', 'missing_reason'])('model %s revision is rejected before persistence', async mode => {
    const f = fixture(), p = await f.saved(), traces = await f.demonstrate('dirt'), state = f.semantic.capture(f.task.snapshot());
    if (mode === 'not_presented') state.autonomy!.learnedProcedures = [];
    const answer = { task: 'SAVE_PROCEDURE', affordance_id: 'none', operation: null,
      knowledge_query: null, knowledge_offset: null, procedure_id: mode === 'invalid_parent' ? 42 : p.id,
      procedure_name: 'revision', evidence_ids: traces.map(t => t.id), confidence: 1, reason: mode === 'missing_reason' ? '' : 'proposed change' };
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(answer) }) });
    const result = await f.policy.decide(state);
    expect(result).toMatchObject({ task: 'WAIT', source: 'fallback' });
    expect(f.experience.list()).toEqual([p]);
  });
});
