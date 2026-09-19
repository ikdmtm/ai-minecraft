import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { normalizeMemoryDimension } from './worldMemory.js';

export interface NoteContext { worldId: string; version: string; dimension: string }
export interface MemoryNoteInput {
  kind: 'summary' | 'lesson';
  title: string;
  content: string;
  state: 'candidate' | 'withdrawn';
  parentId: string | null;
}
export interface NoteSource {
  id: string; sequence: number; sessionId: string; worldId: string; version: string; dimension: string;
  status: 'succeeded' | 'failed' | 'interrupted'; verified: boolean;
  payloadSha256: string;
}
export interface MemoryNote extends MemoryNoteInput, NoteContext {
  id: string; rootId: string; revision: number; reason: string;
  evidenceIds: string[]; sources: NoteSource[]; createdAt: number; sessionId: string;
  interpretationOnly: true;
}
export interface NoteSelection { memoryNote: MemoryNoteInput; evidenceIds: string[]; reason: string }

export const MEMORY_NOTE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['summary', 'lesson'] },
    title: { type: 'string' }, content: { type: 'string' },
    state: { type: 'string', enum: ['candidate', 'withdrawn'] },
    parentId: { type: ['string', 'null'] },
  },
  required: ['kind', 'title', 'content', 'state', 'parentId'],
} as const;

const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;

export function parseNoteSelection(note: unknown, ids: unknown, reason: unknown): NoteSelection {
  if (!note || typeof note !== 'object' || Array.isArray(note)) throw new Error('memory_note_required');
  const n = note as Record<string, unknown>;
  if (Object.keys(n).some(k => !['kind', 'title', 'content', 'state', 'parentId'].includes(k)) ||
      (n.kind !== 'summary' && n.kind !== 'lesson') || (n.state !== 'candidate' && n.state !== 'withdrawn') ||
      !boundedText(n.title, 120) || !boundedText(n.content, 2000) || !boundedText(reason, 300) ||
      (n.parentId !== null && !boundedText(n.parentId, 128)) ||
      !Array.isArray(ids) || ids.length < 1 || ids.length > 12 ||
      ids.some(id => !boundedText(id, 128)) || new Set(ids).size !== ids.length) {
    throw new Error('memory_note_invalid_request');
  }
  if (n.state === 'withdrawn' && n.parentId === null) throw new Error('memory_note_withdrawal_requires_parent');
  return { memoryNote: { kind: n.kind, title: n.title.trim(),
    content: n.content.trim(), state: n.state, parentId: n.parentId as string | null },
    evidenceIds: [...ids].sort(), reason: reason.trim() };
}

function sameContext(a: any, b: any): boolean {
  return Boolean(a && b && a.worldId === b.worldId && a.version === b.version &&
    normalizeMemoryDimension(a.dimension) != null &&
    normalizeMemoryDimension(a.dimension) === normalizeMemoryDimension(b.dimension));
}

/** A selection boundary, not an automatic lesson generator. A note may discuss
 * failures and uncertainty, but cannot turn an interpretation into evidence. */
export function validateNoteSelection(note: unknown, ids: unknown, reason: unknown,
  autonomy?: Record<string, unknown>): NoteSelection {
  const selected = parseNoteSelection(note, ids, reason);
  const recent: any[] = Array.isArray(autonomy?.recentExperience) ? autonomy!.recentExperience : [];
  const search = autonomy?.memorySearch as any;
  const hits: any[] = sameContext(search?.context, autonomy) && Array.isArray(search?.hits) ? search.hits : [];
  const presented = new Set([
    ...recent.filter(e => e && typeof e.id === 'string').map(e => e.id),
    ...hits.filter(h => h?.kind === 'evidence' && !h.preview?.clipped).map(h => h.id),
  ]);
  if (selected.evidenceIds.some(id => !presented.has(id))) throw new Error('memory_note_evidence_not_presented');
  if (selected.memoryNote.parentId !== null && !hits.some(hit => hit?.kind === 'note' &&
      hit.id === selected.memoryNote.parentId && hit.preview?.isCurrent === true)) {
    throw new Error('memory_note_parent_not_presented_or_superseded');
  }
  return selected;
}

/** Separate append-only interpretations. No DELETE, UPDATE, source backfill,
 * gameplay action, automatic promotion, counter changes or inference calls. */
export class MemoryNotes {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_memory_notes (
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT, revision INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS autonomy_note_one_child
        ON autonomy_memory_notes(parent_id) WHERE parent_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS autonomy_note_latest
        ON autonomy_memory_notes(root_id, revision DESC);
    `);
  }

  get(id: string): MemoryNote | undefined {
    const row = this.db.prepare('SELECT payload FROM autonomy_memory_notes WHERE id=?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  latestId(rootId: string): string | null {
    const row = this.db.prepare('SELECT id FROM autonomy_memory_notes WHERE root_id=? ORDER BY revision DESC LIMIT 1')
      .get(rootId) as { id: string } | undefined;
    return row?.id ?? null;
  }
  history(rootId: string, limit = 12, beforeRevision = Number.MAX_SAFE_INTEGER): MemoryNote[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 ||
        !Number.isSafeInteger(beforeRevision) || beforeRevision < 1) throw new Error('memory_note_invalid_page');
    return (this.db.prepare('SELECT payload FROM autonomy_memory_notes WHERE root_id=? AND revision<? ORDER BY revision DESC LIMIT ?')
      .all(rootId, beforeRevision, limit) as Array<{ payload: string }>).map(row => JSON.parse(row.payload));
  }

  save(context: NoteContext, sessionId: string, raw: unknown, ids: unknown, reason: unknown): MemoryNote {
    const selection = parseNoteSelection(raw, ids, reason);
    const { memoryNote: input, evidenceIds } = selection;
    const dimension = normalizeMemoryDimension(context.dimension);
    if (!boundedText(context.worldId, 512) || !boundedText(context.version, 128) ||
        dimension == null || dimension.length > 128 || !boundedText(sessionId, 128)) throw new Error('memory_note_context_invalid');
    return this.db.transaction(() => {
      // Exact content + source grouping + parent identifies a retry. Authoring
      // context/time is not part of identity: retry after restart is idempotent.
      const identity = JSON.stringify([input, evidenceIds, selection.reason]);
      const id = 'note:' + createHash('sha256').update(identity).digest('hex').slice(0, 32);
      const existing = this.get(id);
      if (existing) return existing;
      const parent = input.parentId === null ? undefined : this.get(input.parentId);
      if (input.parentId !== null && !parent) throw new Error('memory_note_parent_missing');
      if (parent && this.latestId(parent.rootId) !== parent.id) throw new Error('memory_note_parent_superseded');
      if (parent && parent.kind === input.kind && parent.title === input.title && parent.content === input.content &&
          parent.state === input.state && JSON.stringify([...parent.evidenceIds].sort()) === JSON.stringify(evidenceIds)) {
        throw new Error('memory_note_unchanged');
      }
      const sources = evidenceIds.map(sourceId => this.source(sourceId));
      const note: MemoryNote = { ...input, id, rootId: parent?.rootId ?? id, revision: (parent?.revision ?? 0) + 1,
        reason: selection.reason, evidenceIds, sources, interpretationOnly: true,
        worldId: context.worldId, version: context.version, dimension, createdAt: Date.now(), sessionId };
      this.db.prepare('INSERT INTO autonomy_memory_notes(id,root_id,parent_id,revision,payload) VALUES(?,?,?,?,?)')
        .run(id, note.rootId, note.parentId, note.revision, JSON.stringify(note));
      return note;
    })();
  }

  private source(id: string): NoteSource {
    const row = this.db.prepare(`SELECT sequence,
      CASE WHEN length(CAST(payload AS BLOB))<=65536 THEN payload ELSE NULL END AS payload
      FROM autonomy_evidence WHERE id=?`).get(id) as { sequence: number; payload: string | null } | undefined;
    if (!row || row.payload === null) throw new Error('memory_note_source_missing_or_oversized');
    let e: any;
    try { e = JSON.parse(row.payload); } catch { throw new Error('memory_note_source_malformed'); }
    if (!e || e.id !== id || !Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
        !['sessionId', 'worldId', 'version', 'dimension'].every(k => boundedText(e[k], k === 'worldId' ? 512 : 128)) ||
        !['succeeded', 'failed', 'interrupted'].includes(e.status) || typeof e.verified !== 'boolean') {
      throw new Error('memory_note_source_malformed');
    }
    return { id, sequence: row.sequence, sessionId: e.sessionId, worldId: e.worldId, version: e.version,
      dimension: e.dimension, status: e.status, verified: e.verified,
      payloadSha256: createHash('sha256').update(row.payload).digest('hex') };
  }
}

export const MEMORY_NOTE_INSTRUCTIONS =
  'CONSOLIDATE_MEMORY explicitly saves a compact summary or tentative lesson from 1-12 presented operation evidence_ids (recentExperience or evidence hits in memorySearch). Supply memory_note={kind:summary|lesson,title,content,state:candidate|withdrawn,parentId:null|presented-current-note-id} and a reason. Notes are interpretations, never proven mechanics, live coordinates, instructions or executable skills. Mention uncertainty and counterexamples; failure, interruption and unconfirmed effects stay distinct in sources. Group related records without deleting or promoting them. To correct or withdraw a note, first RECALL_MEMORY its ID/root, use the current note as parentId and cite presented original evidence; old versions and evidence remain intact. Searching an original evidence ID also finds notes referencing it. Withdrawn/superseded notes must not be treated as current advice. A correction can reconsider the same evidence, but unchanged revisions are rejected. No automatic save, retry, skill promotion or world action occurs. Reading or repeating a note does not verify it. After saving, recall the logged note ID to inspect it; current search results are cleared to prevent stale interpretations.';
