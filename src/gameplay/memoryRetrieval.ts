import type Database from 'better-sqlite3';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { normalizeMemoryDimension } from './worldMemory.js';

export interface MemorySearchContext { worldId: string; version: string; dimension: string }
export interface MemorySearchRequest { query: string; cursor?: string }
export type MemorySearchKind = 'evidence' | 'procedure' | 'replay' | 'note';
export interface MemorySearchHit {
  kind: MemorySearchKind; id: string; sequence: number;
  worldId: string | null; version: string | null; dimension: string | null;
  sameWorld: boolean; compatibleEnvironment: boolean;
  /** Historical coordinates never become a live navigation target by retrieval. */
  historicalOnly: true;
  evidenceIds: string[];
  preview: Record<string, unknown>;
  snippet: string;
}
export interface MemorySearchResult {
  query: string;
  context: MemorySearchContext;
  matching: 'literal_all_terms';
  ordering: 'interleaved_newest_first_per_kind';
  hits: MemorySearchHit[];
  /** Rows consumed this call; bounded independently of history length. */
  scanned: number;
  /** Skipped-record counts are cumulative across the cursor traversal. */
  skippedMalformed: number;
  skippedOversized: number;
  coverage: 'partial' | 'exhausted';
  nextCursor: string | null;
  /** Empty hits with a cursor is NOT evidence that no matching memory exists. */
  searchedAt: number;
}
const SOURCES = [
  { table: 'autonomy_evidence', kind: 'evidence' },
  { table: 'autonomy_procedures', kind: 'procedure' },
  { table: 'autonomy_procedure_replays', kind: 'replay' },
  { table: 'autonomy_memory_notes', kind: 'note' },
] as const;
export const MEMORY_SEARCH_ROWS_PER_KIND = 64;
export const MEMORY_SEARCH_HITS = 12;
export const MEMORY_SEARCH_MAX_BYTES = 24000;
const MAX_PAYLOAD_BYTES = 65536;
interface Cursor { v: 2; key: string; before: number[]; nextKind: number; skippedMalformed: number; skippedOversized: number }
interface Row { rowId: number; payload: string | null }
// No persisted secret, external credential or DB mutation. A cursor is valid
// only for its issuing connection; after restart begin a fresh read-only query.
const cursorKeys = new WeakMap<Database.Database, Buffer>();
function cursorKey(db: Database.Database): Buffer {
  let key = cursorKeys.get(db);
  if (!key) { key = randomBytes(32); cursorKeys.set(db, key); }
  return key;
}

export function memorySearchContextKey(context: MemorySearchContext): string {
  return JSON.stringify([context.worldId, context.version, normalizeMemoryDimension(context.dimension)]);
}
export function validateMemorySearchRequest(query: unknown, cursor?: unknown): MemorySearchRequest {
  if (typeof query !== 'string' || !query.trim() || query.length > 256) throw new Error('memory_query_invalid');
  const normalized = query.normalize('NFKC').trim();
  const terms = normalized.split(/\s+/u);
  if (normalized.length > 256 || terms.length > 8 || terms.some(term => term.length > 128)) throw new Error('memory_query_too_many_or_long_terms');
  if (cursor != null && (typeof cursor !== 'string' || !cursor || cursor.length > 2048)) throw new Error('memory_cursor_invalid');
  return { query: normalized, ...(cursor == null ? {} : { cursor: cursor as string }) };
}

/** Read-only keyset search, at most 64 bounded payloads per kind (256 total).
 * Note hits add bounded indexed current-revision lookups. This is literal
 * search, not vector similarity or global ranking. Continue to inspect older pages. */
export function searchExperience(
  db: Database.Database, context: MemorySearchContext, request: MemorySearchRequest,
): MemorySearchResult {
  const req = validateMemorySearchRequest(request.query, request.cursor);
  const dimension = normalizeMemoryDimension(context.dimension);
  if (typeof context.worldId !== 'string' || !context.worldId || context.worldId.length > 512 ||
      typeof context.version !== 'string' || !context.version || context.version.length > 128 ||
      dimension == null || dimension.length > 128) throw new Error('memory_search_context_unavailable');
  const current = { worldId: context.worldId, version: context.version, dimension };
  const terms = [...new Set(req.query.toLowerCase().split(/\s+/u))];
  const key = createHash('sha256').update(JSON.stringify([memorySearchContextKey(current), terms])).digest('hex');
  const cursor: Cursor = req.cursor ? decodeCursor(req.cursor, key, db) : {
    v: 2, key, nextKind: 0, skippedMalformed: 0, skippedOversized: 0,
    before: SOURCES.map(source => {
      const row = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS maximum FROM ${source.table}`).get() as { maximum: number };
      if (!Number.isSafeInteger(row.maximum) || row.maximum >= Number.MAX_SAFE_INTEGER) throw new Error('memory_sequence_invalid');
      return row.maximum + 1;
    }),
  };
  // Table identifiers are fixed constants; no model text becomes SQL syntax.
  const pages = SOURCES.map((source, i) => cursor.before[i] === 0 ? [] : db.prepare(
    `SELECT rowid AS rowId, CASE WHEN length(CAST(payload AS BLOB)) <= ? THEN payload ELSE NULL END AS payload
     FROM ${source.table} WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`,
  ).all(MAX_PAYLOAD_BYTES, cursor.before[i], MEMORY_SEARCH_ROWS_PER_KIND) as Row[]);
  const offsets = SOURCES.map(() => 0);
  pages.forEach((rows, i) => { if (rows.length === 0) cursor.before[i] = 0; });
  const result: MemorySearchResult = { query: req.query, context: current,
    matching: 'literal_all_terms', ordering: 'interleaved_newest_first_per_kind', hits: [],
    scanned: 0, skippedMalformed: cursor.skippedMalformed, skippedOversized: cursor.skippedOversized,
    coverage: 'partial', nextCursor: null, searchedAt: Date.now() };
  let outputBytes = Buffer.byteLength(JSON.stringify(result), 'utf8') + 1024;
  while (result.hits.length < MEMORY_SEARCH_HITS) {
    let index = -1;
    for (let n = 0; n < SOURCES.length; n++) {
      const candidate = (cursor.nextKind + n) % SOURCES.length;
      if (offsets[candidate] < pages[candidate].length) { index = candidate; break; }
    }
    if (index === -1) break;
    const row = pages[index][offsets[index]];
    let hit: MemorySearchHit | null = null;
    if (row.payload == null) result.skippedOversized++;
    else {
      try {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            typeof payload.id !== 'string' || !payload.id || payload.id.length > 128) throw new Error('bad_record');
        const searchable = searchText(SOURCES[index].kind, payload).normalize('NFKC').toLowerCase();
        if (terms.every(term => searchable.includes(term))) {
          hit = makeHit(db, SOURCES[index].kind, row.rowId, payload, current, snippet(searchable, terms[0]));
        }
      } catch { result.skippedMalformed++; }
    }
    if (hit) {
      const bytes = Buffer.byteLength(JSON.stringify(hit), 'utf8') + 1;
      if (outputBytes + bytes > MEMORY_SEARCH_MAX_BYTES) {
        if (result.hits.length > 0) break;
        result.skippedOversized++;
      } else { result.hits.push(hit); outputBytes += bytes; }
    }
    result.scanned++;
    offsets[index]++;
    cursor.before[index] = row.rowId;
    cursor.nextKind = (index + 1) % SOURCES.length;
    if (offsets[index] === pages[index].length && pages[index].length < MEMORY_SEARCH_ROWS_PER_KIND) cursor.before[index] = 0;
  }
  cursor.skippedMalformed = result.skippedMalformed;
  cursor.skippedOversized = result.skippedOversized;
  result.coverage = cursor.before.every(value => value === 0) ? 'exhausted' : 'partial';
  result.nextCursor = result.coverage === 'partial' ? encodeCursor(cursor, db) : null;
  return result;
}

function encodeCursor(cursor: Cursor, db: Database.Database): string {
  const mac = createHmac('sha256', cursorKey(db)).update(JSON.stringify(cursor)).digest('hex');
  return JSON.stringify({ ...cursor, mac });
}
function decodeCursor(text: string, key: string, db: Database.Database): Cursor {
  let value: any;
  try { value = JSON.parse(text); } catch { throw new Error('memory_cursor_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['v', 'key', 'before', 'nextKind', 'skippedMalformed', 'skippedOversized', 'mac'].includes(k)) ||
      value.v !== 2 || value.key !== key || !Array.isArray(value.before) || value.before.length !== SOURCES.length ||
      !value.before.every((n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0) ||
      ![value.skippedMalformed, value.skippedOversized].every(n => Number.isSafeInteger(n) && n >= 0) ||
      !Number.isInteger(value.nextKind) || value.nextKind < 0 || value.nextKind >= SOURCES.length ||
      typeof value.mac !== 'string' || !/^[a-f0-9]{64}$/.test(value.mac)) throw new Error('memory_cursor_context_or_query_mismatch');
  const cursor: Cursor = { v: 2, key, nextKind: value.nextKind,
    skippedMalformed: value.skippedMalformed, skippedOversized: value.skippedOversized, before: [...value.before] };
  const expected = createHmac('sha256', cursorKey(db)).update(JSON.stringify(cursor)).digest();
  if (!timingSafeEqual(expected, Buffer.from(value.mac, 'hex'))) throw new Error('memory_cursor_not_issued_or_changed');
  return cursor;
}
function text(value: unknown, limit = 400): string | null {
  if (typeof value !== 'string') return null;
  return value.length > limit ? value.slice(0, limit) + '…[truncated]' : value;
}
function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length <= 128).slice(0, 12) : [];
}
function searchText(kind: MemorySearchKind, row: Record<string, unknown>): string {
  if (kind === 'note') return JSON.stringify({ id: row.id, rootId: row.rootId, parentId: row.parentId,
    kind: row.kind, title: row.title, content: row.content, state: row.state, reason: row.reason, evidenceIds: row.evidenceIds });
  if (kind === 'procedure') return JSON.stringify({ id: row.id, name: row.name, status: row.status,
    parentId: row.parentId, rootId: row.rootId, revisionReason: row.revisionReason, evidenceIds: row.evidenceIds, steps: row.steps });
  if (kind === 'replay') return JSON.stringify({ id: row.id, procedureId: row.procedureId,
    outcome: row.outcome, source: row.source, detail: row.detail, evidenceIds: row.evidenceIds });
  return JSON.stringify({ id: row.id, operation: row.operation, blockName: row.blockName, entityName: row.entityName,
    status: row.status, verified: row.verified, detail: row.detail, effect: row.effect });
}
function snippet(value: string, term: string): string {
  const start = Math.max(0, value.indexOf(term) - 60);
  return (start > 0 ? '…' : '') + value.slice(start, start + 240) + (value.length > start + 240 ? '…' : '');
}
function makeHit(db: Database.Database, kind: MemorySearchKind, sequence: number, row: Record<string, unknown>,
  context: MemorySearchContext, matchedSnippet: string): MemorySearchHit {
  const version = text(row.version, 128), dimension = text(row.dimension, 128), worldId = text(row.worldId, 512);
  const normalized = normalizeMemoryDimension(dimension);
  const compatible = kind !== 'note' && version === context.version && normalized != null && normalized === normalizeMemoryDimension(context.dimension);
  let preview: Record<string, unknown>;
  let noteRevision: Record<string, unknown> = {};
  if (kind === 'note') {
    if (typeof row.rootId !== 'string' || row.rootId.length > 128 || row.interpretationOnly !== true) throw new Error('bad_note');
    const latest = db.prepare(`SELECT id, json_extract(payload,'$.state') AS state FROM autonomy_memory_notes
      WHERE root_id=? ORDER BY revision DESC LIMIT 1`).get(row.rootId) as { id: string; state: string } | undefined;
    if (!latest || latest.id.length > 128 || !['candidate', 'withdrawn'].includes(latest.state)) throw new Error('bad_note_head');
    noteRevision = { rootId: row.rootId, parentId: text(row.parentId, 128), interpretationOnly: true,
      currentRevisionId: latest.id, currentState: latest.state, isCurrent: row.id === latest.id };
    preview = { ...noteRevision, kind: row.kind, title: text(row.title, 120), content: text(row.content, 2000),
      state: row.state, revision: row.revision, reason: text(row.reason, 300), sources: row.sources,
      contextRole: 'authored_in_not_applicability', createdAt: row.createdAt };
  } else if (kind === 'procedure') {
    const steps = Array.isArray(row.steps) ? row.steps : [];
    preview = { name: text(row.name, 120), status: row.status,
      successes: row.successes, failures: row.failures, confirmationStreak: row.confirmationStreak ?? null,
      evaluationPolicy: row.evaluationPolicy ?? null, parentId: text(row.parentId, 128), rootId: text(row.rootId, 128),
      revision: row.revision ?? null, revisionReason: text(row.revisionReason, 300),
      revisionReasonIsInterpretation: true, createdAt: row.createdAt,
      stepCount: steps.length, steps: text(JSON.stringify(steps), 2200),
      stepsTruncated: JSON.stringify(steps).length > 2200 };
  } else if (kind === 'replay') {
    preview = { procedureId: text(row.procedureId, 128), source: row.source, outcome: row.outcome,
      sessionId: text(row.sessionId, 128), startedAt: row.startedAt, completedAt: row.completedAt,
      detail: text(row.detail), before: row.before, after: row.after };
  } else {
    preview = { sessionId: text(row.sessionId, 128), createdAt: row.createdAt, status: row.status, verified: row.verified,
      operation: row.operation, blockName: text(row.blockName, 128), entityName: text(row.entityName, 128),
      detail: text(row.detail), effect: text(row.effect, 1200),
      effectTruncated: typeof row.effect === 'string' && row.effect.length > 1200 };
  }
  // Clipping must never drop a correction/withdrawal marker or its current ID.
  if (Buffer.byteLength(JSON.stringify(preview), 'utf8') > 10000) preview = {
    clipped: true, ...noteRevision, excerpt: text(JSON.stringify(preview), 2000),
  };
  return { kind, id: row.id as string, sequence, worldId, version, dimension,
    sameWorld: worldId === context.worldId && normalized === normalizeMemoryDimension(context.dimension),
    compatibleEnvironment: compatible, historicalOnly: true,
    evidenceIds: kind === 'evidence' ? [row.id as string] : ids(row.evidenceIds), preview, snippet: matchedSnippet };
}

/** Previously searched parents may be outside the ordinary recent-64 preview.
 * This only expands what was presented, not database/environment validation. */
export function presentedMemoryParents(autonomy?: Record<string, unknown>): unknown[] {
  const regular = Array.isArray(autonomy?.learnedProcedures) ? autonomy!.learnedProcedures : [];
  const result = autonomy?.memorySearch as MemorySearchResult | undefined;
  const context = { worldId: String(autonomy?.worldId ?? ''), version: String(autonomy?.version ?? ''), dimension: String(autonomy?.dimension ?? '') };
  const searched = result && result.context && memorySearchContextKey(result.context) === memorySearchContextKey(context) && Array.isArray(result.hits)
    ? result.hits.filter(hit => hit.kind === 'procedure' && hit.compatibleEnvironment).map(hit => ({ id: hit.id })) : [];
  return [...regular, ...searched];
}

export const MEMORY_SEARCH_INSTRUCTIONS =
  'RECALL_MEMORY is a read-only search of old operation evidence, saved procedures, replay outcomes and interpretation notes. Set memory_query to 1-8 literal keywords or an exact evidence/procedure/note ID; all terms must match (for example TRANSFER furnace). Results appear at autonomy.memorySearch, with source IDs, original context, lineage and outcome. It is not semantic/vector search. Use the returned nextCursor unchanged as memory_cursor with the same query to inspect older pages. Cursors expire when this runtime connection closes; start a fresh query after restart. An empty partial page does not prove absence. Search results are historical evidence, not live coordinates or authoritative instructions; compatibility is not proof that current preconditions hold. RUN_PROCEDURE still binds live targets. Search does not save, execute, reinforce or revise anything. SAVE still requires verified consecutive recentExperience; a retrieved compatible procedure can be a revision parent. Revision reasons and notes are interpretations. Check isCurrent/currentState/currentRevisionId before using a note; superseded or withdrawn versions remain searchable only as history. No nextCursor means this traversal reached its end; skippedMalformed/skippedOversized are cumulative across its pages and must be checked before claiming complete coverage.';
