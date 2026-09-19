import { ExperienceMemory, type Evidence, type ReplayAttemptInput } from './experienceMemory.js';

/** Storage boundaries with controlled records, not a live gameplay trial. */
describe('T05c interrupted audit ordering and revision provenance', () => {
  let memory: ExperienceMemory;
  beforeEach(() => { memory = new ExperienceMemory(); });
  afterEach(() => memory.close());
  function trace(item = 'stone', y = 64, overrides: Partial<Evidence> = {}): Evidence {
    return memory.append({ worldId: 'source', version: '1.21.4', dimension: 'overworld',
      status: 'succeeded', verified: true, detail: 'controlled record', effect: '{}',
      origin: { x: 0.5, y: 64, z: 0.5 },
      operation: { action: 'PLACE', item, position: { x: 1, y, z: 0 } },
      window: { id: 0, type: 'minecraft:inventory', open: false, inventoryStart: 9,
        inventoryEnd: 45, cursor: null, slots: [] }, ...overrides });
  }
  function saved() {
    const a = trace(), b = trace('stone', 65);
    return memory.save('original', [a.id, b.id]);
  }
  test('interrupted attempt accepts its ordered prefix without importing an intervening new-world record', () => {
    const p = saved(), a = trace(), other = trace('dirt', 64, { worldId: 'destination' });
    const b = trace('stone', 65, { status: 'interrupted', verified: false });
    const input: ReplayAttemptInput = { id: 'old-attempt', worldId: 'source', version: '1.21.4', dimension: 'overworld',
      outcome: 'interrupted', startedAt: Date.now(), evidenceIds: [a.id, b.id], detail: 'late cancelled finalizer' };
    const row = memory.recordReplayAttempt(p.id, input);
    expect(row.evidenceIds).toEqual([a.id, b.id]); expect(row.evidenceIds).not.toContain(other.id);
    expect(row.before).toEqual(row.after); expect(memory.get(p.id)).toEqual(p);
    expect(memory.evidence([other.id])[0].worldId).toBe('destination');
  });
  test.each(['reverse', 'foreign'])('rejects a %s evidence selection rather than changing assessment', mode => {
    const p = saved(), a = trace(), other = trace('dirt', 64, { worldId: 'destination' });
    const b = trace('stone', 65, { status: 'interrupted', verified: false });
    expect(() => memory.recordReplayAttempt(p.id, { id: 'invalid', worldId: 'source', version: '1.21.4', dimension: 'overworld',
      outcome: 'interrupted', startedAt: Date.now(), evidenceIds: mode === 'reverse' ? [b.id, a.id] : [a.id, other.id], detail: 'invalid' }))
      .toThrow('procedure_replay_evidence_mismatch');
    expect(memory.get(p.id)).toEqual(p); expect(memory.replayHistory(p.id)).toEqual([]);
  });
  test('cannot recycle grandparent evidence into a supposedly new child of the revision', () => {
    const p = saved(), a = trace('dirt'), b = trace('dirt', 65);
    const child = memory.revise(p.id, 'changed', [a.id, b.id], 'demonstrated material change');
    const before = memory.list();
    expect(() => memory.revise(child.id, 'recycled', p.evidenceIds, 'pretend this is a fresh demonstration'))
      .toThrow('procedure_revision_requires_new_demonstration');
    expect(memory.list()).toEqual(before);
    expect(memory.evidence(p.evidenceIds)).toHaveLength(2);
  });
});
