import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type Database from 'better-sqlite3';
import { ExperienceMemory, type Evidence } from './experienceMemory.js';
import { parseNoteSelection, validateNoteSelection, type MemoryNoteInput } from './memoryConsolidation.js';
import { MEMORY_SEARCH_MAX_BYTES } from './memoryRetrieval.js';

const context = { worldId: 'current-world', version: '1.21.4', dimension: 'overworld' };
const note = (changes: Partial<MemoryNoteInput> = {}): MemoryNoteInput => ({ kind: 'lesson', title: '配置の経験',
  content: '一度の配置結果だけでは、別の場所でも成功するとは限らない。', state: 'candidate', parentId: null, ...changes });
const win = { id: 0, type: 'minecraft:inventory', open: false, inventoryStart: 9, inventoryEnd: 45, cursor: null, slots: [] };

describe('T06b non-destructive memory consolidation', () => {
  let directory: string, path: string, memory: ExperienceMemory;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'memory-notes-')); path = join(directory, 'memory.sqlite'); memory = new ExperienceMemory(path); });
  afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });
  function evidence(changes: Partial<Evidence> = {}) {
    return memory.append({ worldId: 'old-world', version: '1.21.4', dimension: 'overworld',
      operation: { action: 'PLACE', item: 'stone', position: { x: 1, y: 64, z: 0 } },
      status: 'succeeded', verified: true, detail: 'effect_observed', effect: '{}',
      origin: { x: 0.5, y: 64, z: 0.5 }, window: win, ...changes });
  }
  function save(ids: string[], changes: Partial<MemoryNoteInput> = {}, reason = '記録を整理する') {
    return memory.consolidate(context, note(changes), ids, reason);
  }
  function originalRows() {
    const db = (memory as any).db as Database.Database;
    return ['autonomy_evidence', 'autonomy_procedures', 'autonomy_procedure_replays'].map(table =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  }

  test('summaries preserve raw evidence and skill counters, with immutable source fingerprints', () => {
    const a = evidence(), b = evidence();
    const skill = memory.save('demonstration', [a.id, b.id]); memory.recordReplay(skill.id, false);
    const rows = originalRows(), n = save([b.id, a.id]);
    expect(n).toMatchObject({ interpretationOnly: true, state: 'candidate', revision: 1, parentId: null });
    expect(n.rootId).toBe(n.id); expect(n.evidenceIds).toEqual([a.id, b.id].sort());
    expect(n.sources.every(s => /^[a-f0-9]{64}$/.test(s.payloadSha256))).toBe(true);
    expect(n.sources.map(s => s.worldId)).toEqual(['old-world', 'old-world']);
    expect(originalRows()).toEqual(rows);
  });
  test.each([
    ['failed', false], ['interrupted', false], ['succeeded', false], ['succeeded', true],
  ] as const)('keeps source %s/%s unchanged instead of converting it to proof', (status, verified) => {
    const e = evidence({ status, verified });
    expect(save([e.id]).sources[0]).toMatchObject({ status, verified });
    expect(memory.evidence([e.id])[0]).toEqual(e);
  });
  test('grouping crosses worlds without merging their source context or spatial map', () => {
    const a = evidence(), b = evidence({ worldId: 'other', dimension: 'the_nether', version: '1.21.5' });
    const n = save([a.id, b.id], { kind: 'summary' });
    expect(n.sources.map(s => `${s.worldId}/${s.dimension}`).sort()).toEqual(['old-world/overworld', 'other/the_nether']);
    const hit = memory.search(context, { query: n.id }).hits.find(h => h.id === n.id)!;
    expect(hit).toMatchObject({ kind: 'note', historicalOnly: true, compatibleEnvironment: false,
      preview: { interpretationOnly: true, contextRole: 'authored_in_not_applicability' } });
  });
  test('correction, withdrawal and reconsideration append versions without erasing parents', () => {
    const e = evidence(), first = save([e.id]);
    const second = save([e.id], { parentId: first.id, content: '原因はまだ未確定。元の一般化は強すぎた。' }, '元の解釈を訂正');
    const third = save([e.id], { parentId: second.id, state: 'withdrawn', content: 'この教訓は採用しない。' }, '根拠不足');
    const fourth = save([e.id], { parentId: third.id, content: '範囲を限定した候補として再検討する。' }, '再検討');
    expect(memory.notes.get(first.id)).toEqual(first);
    expect(memory.notes.get(second.id)).toEqual(second);
    expect(memory.notes.latestId(first.rootId)).toBe(fourth.id);
    expect(memory.notes.history(first.rootId).map(n => n.revision)).toEqual([4, 3, 2, 1]);
    expect(memory.notes.history(first.rootId, 2, 3).map(n => n.revision)).toEqual([2, 1]);
    expect(memory.evidence([e.id])[0]).toEqual(e);
  });
  test('search labels an old matching note with the latest withdrawal even when new text does not match', () => {
    const e = evidence(), first = save([e.id], { content: 'unique_old_claim' });
    const latest = save([e.id], { parentId: first.id, state: 'withdrawn', content: 'not_supported' }, 'counterexample');
    const found = memory.search(context, { query: 'unique_old_claim' });
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0].preview).toMatchObject({ isCurrent: false, currentState: 'withdrawn', currentRevisionId: latest.id });
    expect(memory.notes.get(first.id)).toEqual(first);
  });
  test('identical retry and reordered evidence do not add versions, including after restart', () => {
    const a = evidence(), b = evidence(), n = save([a.id, b.id]);
    expect(save([b.id, a.id])).toEqual(n);
    memory.close(); memory = new ExperienceMemory(path);
    expect(save([b.id, a.id])).toEqual(n);
    expect(memory.notes.history(n.rootId)).toHaveLength(1);
  });
  test('correction retries are idempotent and stale concurrent edits are refused', () => {
    const e = evidence(), first = save([e.id]);
    const input = { parentId: first.id, content: 'changed' };
    const second = save([e.id], input);
    expect(save([e.id], input)).toEqual(second);
    const other = new ExperienceMemory(path);
    try {
      expect(() => other.consolidate(context, note({ parentId: first.id, content: 'conflicting edit' }), [e.id], 'other'))
        .toThrow('memory_note_parent_superseded');
    } finally { other.close(); }
    expect(memory.notes.history(first.rootId)).toHaveLength(2);
  });
  test('unchanged correction is rejected rather than increasing apparent support', () => {
    const e = evidence(), first = save([e.id]);
    expect(() => save([e.id], { parentId: first.id }, 'reason only changed')).toThrow('memory_note_unchanged');
    expect(memory.notes.history(first.rootId)).toHaveLength(1);
  });
  test('failed insert leaves all original records and the previous current version intact', () => {
    const e = evidence(), first = save([e.id]), before = originalRows();
    const db = (memory as any).db as Database.Database;
    db.exec("CREATE TRIGGER reject_note BEFORE INSERT ON autonomy_memory_notes BEGIN SELECT RAISE(ABORT,'fixture_failure'); END;");
    expect(() => save([e.id], { parentId: first.id, content: 'new interpretation' })).toThrow('fixture_failure');
    expect(memory.notes.latestId(first.rootId)).toBe(first.id); expect(originalRows()).toEqual(before);
  });
  test.each(['missing', 'malformed', 'oversized'])('rejects %s source with no partial note save', mode => {
    const e = evidence(), db = (memory as any).db as Database.Database;
    if (mode !== 'missing') db.prepare('UPDATE autonomy_evidence SET payload=? WHERE id=?')
      .run(mode === 'malformed' ? '{broken' : 'x'.repeat(65537), e.id);
    expect(() => save([mode === 'missing' ? 'unavailable' : e.id])).toThrow('memory_note_source_');
    expect(db.prepare('SELECT count(*) AS n FROM autonomy_memory_notes').get()).toEqual({ n: 0 });
  });
  test.each([
    { title: '' }, { title: 'x'.repeat(121) }, { content: 'x'.repeat(2001) }, { content: '' },
    { kind: 'fact' }, { state: 'verified' }, { parentId: '' }, { state: 'withdrawn' }, { extra: true },
  ])('rejects invalid note shape %j', patch => {
    expect(() => parseNoteSelection({ ...note(), ...patch }, ['source'], 'reason')).toThrow('memory_note');
  });
  test.each([[], ['x', 'x'], Array.from({ length: 13 }, (_, i) => String(i)), [42]])('rejects invalid sources %p', ids => {
    expect(() => parseNoteSelection(note(), ids, 'reason')).toThrow('memory_note');
  });
  test('requires nonempty reason, context and real parent', () => {
    const e = evidence();
    expect(() => save([e.id], {}, '')).toThrow('memory_note_invalid_request');
    expect(() => save([e.id], { parentId: 'invented' })).toThrow('memory_note_parent_missing');
    expect(() => memory.consolidate({ ...context, worldId: '' }, note(), [e.id], 'reason')).toThrow('memory_note_context_invalid');
  });
  test('reading and repeated search never increase evidence counts or certainty', () => {
    const e = evidence(), n = save([e.id]), before = originalRows();
    for (let i = 0; i < 4; i++) memory.search(context, { query: n.id });
    expect(originalRows()).toEqual(before); expect(memory.notes.get(n.id)).toEqual(n);
    expect(memory.list()).toEqual([]);
  });
  test('notes are retrievable beyond the first 64 and each response stays bounded', () => {
    const e = evidence(), all = Array.from({ length: 80 }, (_, i) => save([e.id], { title: `archive_note_${i}` }));
    let cursor: string | undefined; const found: string[] = [];
    do {
      const page = memory.search(context, { query: 'archive_note_', cursor });
      expect(page.scanned).toBeLessThanOrEqual(256);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MEMORY_SEARCH_MAX_BYTES);
      found.push(...page.hits.filter(h => h.kind === 'note').map(h => h.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(all.map(n => n.id).reverse()); expect(new Set(found).size).toBe(80);
  });
  test('external correction invalidates cached current advice without deleting the note', () => {
    const e = evidence(), first = save([e.id]); memory.search(context, { query: first.id });
    const other = new ExperienceMemory(path);
    try { other.consolidate(context, note({ parentId: first.id, content: 'corrected' }), [e.id], 'new view'); }
    finally { other.close(); }
    expect(memory.retrievalSnapshot(context)).toBeNull(); expect(memory.notes.get(first.id)).toEqual(first);
  });
  test('a note ID cannot substitute for an original operation evidence ID', () => {
    const e = evidence(), n = save([e.id]);
    const autonomy = { ...context, recentExperience: [], memorySearch: memory.search(context, { query: n.id }) };
    expect(() => validateNoteSelection(note(), [n.id], 'reason', autonomy)).toThrow('memory_note_evidence_not_presented');
    expect(() => save([n.id])).toThrow('memory_note_source_missing');
  });
});
