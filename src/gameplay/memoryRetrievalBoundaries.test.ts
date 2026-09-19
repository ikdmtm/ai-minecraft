import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ExperienceMemory } from './experienceMemory.js';
import { MEMORY_SEARCH_MAX_BYTES } from './memoryRetrieval.js';

const context = { worldId: 'current-world', version: '1.21.4', dimension: 'overworld' };
describe('T06a continuation integrity and accumulated coverage', () => {
  let dir: string, memory: ExperienceMemory;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recall-boundaries-')); memory = new ExperienceMemory(join(dir, 'memory.sqlite')); });
  afterEach(() => { memory.close(); rmSync(dir, { recursive: true, force: true }); });
  const row = (id: string, effect = '{}') => ({ id, sessionId: 'fixture-session', worldId: 'old-world', version: '1.21.4', dimension: 'overworld',
    operation: { action: 'USE', item: 'bread' }, status: 'failed', verified: false, detail: 'bread missing', effect,
    origin: { x: 0, y: 64, z: 0 }, window: { slots: [] }, createdAt: 1 });
  function insert(id: string, payload = JSON.stringify(row(id))) {
    (memory as any).db.prepare('INSERT INTO autonomy_evidence(id,payload) VALUES(?,?)').run(id, payload);
  }
  test('a skipped record on an earlier empty page remains visible in final traversal coverage', () => {
    insert('old-target');
    for (let i = 0; i < 70; i++) insert(`other-${i}`, JSON.stringify({ ...row(`other-${i}`), operation: { action: 'WAIT' }, detail: 'unrelated' }));
    insert('oversized', JSON.stringify(row('oversized', 'x'.repeat(70000)))); insert('broken', '{');
    const first = memory.search(context, { query: 'bread' });
    expect(first).toMatchObject({ hits: [], skippedMalformed: 1, skippedOversized: 1, coverage: 'partial' });
    const last = memory.search(context, { query: 'bread', cursor: first.nextCursor! });
    expect(last).toMatchObject({ skippedMalformed: 1, skippedOversized: 1, coverage: 'exhausted' });
    expect(last.hits.map(hit => hit.id)).toEqual(['old-target']);
  });
  test('editing a cursor position cannot fabricate an exhausted search', () => {
    for (let i = 0; i < 20; i++) insert(`e-${i}`);
    const first = memory.search(context, { query: 'bread' });
    const issued = JSON.parse(first.nextCursor!);
    const tampered = { ...issued, before: issued.before.map(() => 0) };
    expect(() => memory.search(context, { query: 'bread', cursor: JSON.stringify(tampered) })).toThrow('memory_cursor_not_issued_or_changed');
    // An unchanged issued cursor remains a valid read-only continuation.
    const next = memory.search(context, { query: 'bread', cursor: first.nextCursor! });
    expect([...first.hits, ...next.hits]).toHaveLength(20);
  });
  test('a restart expires old cursors, not the stored history', () => {
    for (let i = 0; i < 20; i++) insert(`e-${i}`);
    const first = memory.search(context, { query: 'bread' });
    memory.close(); memory = new ExperienceMemory(join(dir, 'memory.sqlite'));
    expect(() => memory.search(context, { query: 'bread', cursor: first.nextCursor! })).toThrow('memory_cursor_not_issued_or_changed');
    expect(memory.search(context, { query: 'bread' }).hits).toHaveLength(12);
  });
  test('response limit includes the actual Unicode context envelope', () => {
    for (let i = 0; i < 20; i++) insert(`e-${i}`, JSON.stringify(row(`e-${i}`, 'あ'.repeat(4000))));
    const wideContext = { ...context, worldId: '界'.repeat(512) };
    let cursor: string | undefined, count = 0;
    do {
      const page = memory.search(wideContext, { query: 'bread', cursor });
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(MEMORY_SEARCH_MAX_BYTES);
      count += page.hits.length; cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(count).toBe(20);
  });
  test('rejects an unbounded context before reading source payloads', () => {
    expect(() => memory.search({ ...context, worldId: 'x'.repeat(513) }, { query: 'bread' })).toThrow('memory_search_context_unavailable');
  });
});
