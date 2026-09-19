import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ExperienceMemory, type Evidence } from './experienceMemory.js';
import { MEMORY_SEARCH_HITS, MEMORY_SEARCH_MAX_BYTES, MEMORY_SEARCH_ROWS_PER_KIND, validateMemorySearchRequest,
  presentedMemoryParents, type MemorySearchContext, type MemorySearchResult } from './memoryRetrieval.js';

const context: MemorySearchContext = { worldId: 'new-world', version: '1.21.4', dimension: 'overworld' };
const window = { id: 0, type: 'minecraft:inventory', open: false, inventoryStart: 9, inventoryEnd: 45,
  cursor: null, slots: [] };

describe('T06a bounded read-only history retrieval', () => {
  let directory: string, memory: ExperienceMemory;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'memory-retrieval-')); memory = new ExperienceMemory(join(directory, 'memory.sqlite')); });
  afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });
  function evidence(item = 'stone', overrides: Partial<Evidence> = {}) {
    return memory.append({ worldId: 'old-world', version: '1.21.4', dimension: 'overworld', status: 'succeeded',
      verified: true, detail: 'effect_observed', effect: '{"outcome":"effect_observed"}',
      origin: { x: 100.5, y: 64, z: -300.5 }, window,
      operation: { action: 'PLACE', item, position: { x: 101, y: 64, z: -301 } }, ...overrides });
  }
  function all(query: string) {
    const pages: MemorySearchResult[] = [];
    let cursor: string | undefined;
    do {
      const page = memory.search(context, { query, cursor });
      expect(page.scanned).toBeLessThanOrEqual(3 * MEMORY_SEARCH_ROWS_PER_KIND);
      expect(page.hits.length).toBeLessThanOrEqual(MEMORY_SEARCH_HITS);
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(MEMORY_SEARCH_MAX_BYTES);
      pages.push(page); cursor = page.nextCursor ?? undefined;
      expect(pages.length).toBeLessThan(100);
    } while (cursor);
    return { pages, hits: pages.flatMap(page => page.hits) };
  }
  function procedure(item = 'stone') {
    const a = evidence(item), b = evidence(item, { operation: { action: 'PLACE', item, position: { x: 101, y: 65, z: -301 } } });
    return memory.save(`${item} demonstrated placement`, [a.id, b.id]);
  }

  test('finds a failure older than the recent-64 buffer without treating an empty partial page as absence', () => {
    const old = evidence('furnace', { status: 'failed', verified: false, detail: 'operation_destination_full' });
    for (let i = 0; i < 150; i++) evidence('dirt');
    expect(memory.recent(64).some(row => row.id === old.id)).toBe(false);
    const found = all('furnace operation_destination_full');
    expect(found.pages[0]).toMatchObject({ hits: [], coverage: 'partial' });
    expect(found.hits.map(hit => hit.id)).toEqual([old.id]);
    expect(found.hits[0]).toMatchObject({ worldId: 'old-world', historicalOnly: true, sameWorld: false,
      compatibleEnvironment: true, evidenceIds: [old.id], preview: { status: 'failed', verified: false } });
    expect(memory.evidence([old.id])[0]).toEqual(old);
  });
  test('uses all case-insensitive normalized terms, not an OR match', () => {
    const target = evidence('furnace', { detail: 'FAILED retry' }); evidence('furnace'); evidence('stone', { detail: 'FAILED' });
    expect(all('ＦＵＲＮＡＣＥ failed').hits.map(hit => hit.id)).toEqual([target.id]);
  });
  test('supports Japanese literal text without an English-only tokenizer', () => {
    const row = evidence('stone', { detail: '足場が足りないため中断' });
    expect(all('足場 足りない').hits.map(hit => hit.id)).toEqual([row.id]);
  });
  test.each([undefined, null, '', '   ', 'x'.repeat(257), 'x'.repeat(129), 'a b c d e f g h i'])('rejects invalid query %p', query => {
    expect(() => validateMemorySearchRequest(query)).toThrow('memory_query');
  });
  test.each([123, '', 'x'.repeat(2049)])('rejects invalid cursor shape %p', cursor => {
    expect(() => validateMemorySearchRequest('stone', cursor)).toThrow('memory_cursor');
  });
  test('query text is literal data, not SQL syntax or a pattern language', () => {
    evidence(); expect(all("'; DROP TABLE autonomy_evidence;--").hits).toEqual([]);
    expect(memory.recent()).toHaveLength(1); expect(all('%').hits).toEqual([]);
  });
  test('pages matching records without loss or duplication', () => {
    const expected = Array.from({ length: 43 }, () => evidence()).map(row => row.id);
    const found = all('stone');
    expect(found.pages.length).toBeGreaterThan(1);
    expect(found.hits.map(hit => hit.id)).toEqual(expected.reverse());
    expect(new Set(found.hits.map(hit => hit.id)).size).toBe(43);
  });
  test('continuation does not restart on newly appended evidence', () => {
    const old = Array.from({ length: 20 }, () => evidence()).map(row => row.id);
    const first = memory.search(context, { query: 'stone' });
    const added = evidence();
    const second = memory.search(context, { query: 'stone', cursor: first.nextCursor! });
    expect([...first.hits, ...second.hits].map(hit => hit.id)).toEqual([...old].reverse());
    expect(memory.search(context, { query: 'stone' }).hits[0].id).toBe(added.id);
  });
  test.each([{ worldId: 'other-world' }, { version: '1.21.5' }, { dimension: 'the_nether' }])('rejects a cursor from another context %j', changed => {
    for (let i = 0; i < 20; i++) evidence();
    const page = memory.search(context, { query: 'stone' });
    expect(() => memory.search({ ...context, ...changed }, { query: 'stone', cursor: page.nextCursor! })).toThrow('memory_cursor');
  });
  test('rejects a continuation for another query and malformed JSON', () => {
    for (let i = 0; i < 20; i++) evidence();
    const page = memory.search(context, { query: 'stone' });
    expect(() => memory.search(context, { query: 'dirt', cursor: page.nextCursor! })).toThrow('memory_cursor');
    expect(() => memory.search(context, { query: 'stone', cursor: '{' })).toThrow('memory_cursor');
  });
  test('rejects unknown dimensions without treating them as the current overworld', () => {
    expect(() => memory.search({ ...context, dimension: '' }, { query: 'stone' })).toThrow('context_unavailable');
  });
  test('flags version and dimension mismatch; an old coordinate remains historical even in the same world', () => {
    evidence('stone', { worldId: context.worldId, dimension: 'minecraft:overworld' });
    evidence('stone', { version: '1.21.5' }); evidence('stone', { dimension: 'the_nether' });
    const hits = all('stone').hits;
    expect(hits.filter(hit => hit.compatibleEnvironment)).toHaveLength(1);
    expect(hits.find(hit => hit.sameWorld)?.historicalOnly).toBe(true);
  });
  test('finds old procedures, revision links and replay records without mutating any payload', () => {
    const parent = procedure('furnace');
    const a = evidence('chest'), b = evidence('chest', { operation: { action: 'PLACE', item: 'chest', position: { x: 101, y: 65, z: -301 } } });
    const child = memory.revise(parent.id, '改良した設備配置', [a.id, b.id], '試した配置を変えた');
    memory.recordReplay(parent.id, false);
    const before = memory.get(parent.id), journal = memory.replayHistory(parent.id);
    const hits = all(parent.id).hits;
    expect(hits.some(hit => hit.id === child.id && hit.preview.parentId === parent.id)).toBe(true);
    expect(hits.some(hit => hit.kind === 'replay' && hit.preview.source === 'legacy_api' && hit.preview.outcome === 'failed')).toBe(true);
    expect(hits.find(hit => hit.id === child.id)?.evidenceIds).toEqual([a.id, b.id]);
    expect(memory.get(parent.id)).toEqual(before); expect(memory.replayHistory(parent.id)).toEqual(journal);
  });
  test('a compatible old procedure outside the 64-entry preview remains searchable', () => {
    const old = procedure('furnace');
    for (let i = 0; i < 70; i++) procedure('stone');
    expect(memory.list().some(p => p.id === old.id)).toBe(false);
    expect(all('furnace').hits.some(hit => hit.kind === 'procedure' && hit.id === old.id)).toBe(true);
  });
  test('reading, returning results and reading the workspace never reinforces or alters evidence', () => {
    const row = evidence(); const before = memory.evidence([row.id]);
    const result = memory.search(context, { query: 'stone' }); result.hits.length = 0;
    expect(memory.retrievalSnapshot(context)?.hits).toHaveLength(1);
    const snapshot = memory.retrievalSnapshot(context)!; snapshot.hits[0].preview.status = 'invented';
    expect(memory.retrievalSnapshot(context)?.hits[0].preview.status).toBe('succeeded');
    expect(memory.evidence([row.id])).toEqual(before); expect(memory.list()).toEqual([]);
  });
  test('workspace is contextual and clears on a rejected query', () => {
    evidence(); memory.search(context, { query: 'stone' });
    expect(memory.retrievalSnapshot({ ...context, worldId: 'different' })).toBeNull();
    expect(() => memory.search(context, { query: '' })).toThrow();
    expect(memory.retrievalSnapshot(context)).toBeNull();
  });
  test('reopen preserves searchable evidence but not an old transient response workspace', () => {
    const row = evidence(); memory.search(context, { query: 'stone' }); memory.close();
    memory = new ExperienceMemory(join(directory, 'memory.sqlite'));
    expect(memory.retrievalSnapshot(context)).toBeNull();
    expect(all('stone').hits[0].id).toBe(row.id);
  });
  test('oversized and malformed rows are explicitly counted, never silently claimed as searched', () => {
    const db = (memory as any).db;
    db.prepare('INSERT INTO autonomy_evidence(id,payload) VALUES(?,?)').run('bad-json', '{');
    evidence('stone', { effect: 'x'.repeat(70000) }); const good = evidence('stone');
    const page = memory.search(context, { query: 'stone' });
    expect(page).toMatchObject({ skippedMalformed: 1, skippedOversized: 1, coverage: 'exhausted' });
    expect(page.hits.map(hit => hit.id)).toEqual([good.id]);
  });
  test('byte budget preserves continuation rather than losing matching multilingual records', () => {
    const rows = Array.from({ length: 25 }, () => evidence('stone', { effect: 'あ'.repeat(4000) }));
    const found = all('stone');
    expect(found.pages[0].hits.length).toBeLessThan(12);
    expect(found.hits.map(hit => hit.id)).toEqual(rows.map(row => row.id).reverse());
    expect(found.hits.every(hit => hit.preview.effectTruncated)).toBe(true);
  });
  test('a retrieved compatible parent can be presented without accepting stale or incompatible search results', () => {
    const saved = procedure(); const result = memory.search(context, { query: saved.id });
    const autonomy = { ...context, memorySearch: result, learnedProcedures: [] };
    expect(presentedMemoryParents(autonomy)).toContainEqual({ id: saved.id });
    expect(presentedMemoryParents({ ...autonomy, worldId: 'another' })).toEqual([]);
    expect(presentedMemoryParents({ ...autonomy, version: '1.21.5' })).toEqual([]);
  });
});
