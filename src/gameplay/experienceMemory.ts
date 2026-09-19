import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { windowSnapshot, type PrimitiveOperation } from './primitiveOperations.js';
import { deriveProcedureSteps, procedureEnvironmentMatches } from './procedureBindings.js';
import { normalizeMemoryDimension } from './worldMemory.js';
import { searchExperience, memorySearchContextKey, type MemorySearchContext, type MemorySearchRequest, type MemorySearchResult } from './memoryRetrieval.js';
import { MemoryNotes, type MemoryNote } from './memoryConsolidation.js';
export { bindProcedureStep, completeProcedureStepBinding, ProcedureBindingError, procedureEnvironmentMatches } from './procedureBindings.js';

export interface Evidence {
  id: string; sequence: number; sessionId: string; worldId: string; version: string; dimension: string;
  operation: PrimitiveOperation; status: 'succeeded' | 'failed' | 'interrupted'; verified: boolean;
  detail: string; effect: string; origin: { x: number; y: number; z: number };
  blockName?: string; entityName?: string;
  window: ReturnType<typeof windowSnapshot>; createdAt: number;
}
export interface ProcedureStep {
  operation: PrimitiveOperation;
  binding?: { kind: 'block' | 'entity'; name: string; ref?: string } |
    { kind: 'relative'; offset: { x: number; y: number; z: number }; ref?: string };
  windowType?: string;
  sourceItem?: string;
  destinationInventory?: boolean;
  opensWindowRef?: string;
  windowBinding?: { ref: string; type: string; open: boolean };
  sourceRole?: string | null;
  destinationRole?: string | null;
}
export interface LearnedProcedure {
  id: string; name: string; version: string; dimension: string; steps: ProcedureStep[];
  evidenceIds: string[]; successes: number; failures: number;
  status: 'candidate' | 'verified'; createdAt: number;
  /** New assessments only. Old payloads are not rewritten or backfilled. */
  confirmationStreak?: number;
  evaluationPolicy?: 'two_confirmed_replays_since_failure_v1';
  parentId?: string;
  rootId?: string;
  revision?: number;
  /** Model interpretation, not an established explanation of past failures. */
  revisionReason?: string;
}
export type ReplayOutcome = 'succeeded' | 'failed' | 'interrupted' | 'unconfirmed';
export interface ReplayAttemptInput {
  id: string; outcome: ReplayOutcome; evidenceIds: string[]; detail: string;
  worldId: string; version: string; dimension: string; startedAt: number;
}
interface EvaluationSnapshot {
  status: LearnedProcedure['status']; successes: number; failures: number; confirmationStreak: number;
}
export interface ReplayRecord {
  id: string; procedureId: string; source: 'runtime' | 'legacy_api'; sessionId: string;
  outcome: ReplayOutcome; evidenceIds: string[]; detail: string;
  worldId: string | null; version: string | null; dimension: string | null;
  startedAt: number; completedAt: number;
  before: EvaluationSnapshot; after: EvaluationSnapshot;
}

/** Append-only evidence and replay journal. Templates are data, never code. */
export class ExperienceMemory {
  private db: Database.Database;
  private lastMemorySearch?: MemorySearchResult;
  readonly notes: MemoryNotes;
  readonly sessionId = randomUUID();
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_evidence (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_procedures (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS autonomy_procedure_replays (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        procedure_id TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS autonomy_replays_by_procedure
        ON autonomy_procedure_replays(procedure_id, sequence);
    `);
    this.notes = new MemoryNotes(this.db);
  }
  close(): void { if (this.db.open) this.db.close(); }
  /** Explicit query only: ordinary observation does not scan history. */
  search(context: MemorySearchContext, request: MemorySearchRequest): MemorySearchResult {
    this.lastMemorySearch = undefined;
    const result = searchExperience(this.db, context, request);
    this.lastMemorySearch = structuredClone(result);
    return result;
  }
  retrievalSnapshot(context: MemorySearchContext): MemorySearchResult | null {
    if (!this.lastMemorySearch || memorySearchContextKey(this.lastMemorySearch.context) !== memorySearchContextKey(context)) return null;
    // An independently written correction must not leave a cached note labeled current.
    if (this.lastMemorySearch.hits.some(hit => hit.kind === 'note' &&
        this.notes.latestId(String(hit.preview.rootId)) !== hit.preview.currentRevisionId)) {
      this.lastMemorySearch = undefined;
      return null;
    }
    return structuredClone(this.lastMemorySearch);
  }
  consolidate(context: MemorySearchContext, note: unknown, ids: unknown, reason: unknown): MemoryNote {
    const saved = this.notes.save(context, this.sessionId, note, ids, reason);
    // The next model can recall the returned ID. Do not carry superseded advice
    // forward, auto-search the archive, or manufacture a new operation trace.
    this.lastMemorySearch = undefined;
    return saved;
  }
  append(input: Omit<Evidence, 'id' | 'sequence' | 'sessionId' | 'createdAt'>): Evidence {
    const row = { ...input, id: randomUUID(), sequence: 0, sessionId: this.sessionId, createdAt: Date.now() };
    const result = this.db.prepare('INSERT INTO autonomy_evidence(id,payload) VALUES(?,?)').run(row.id, JSON.stringify(row));
    row.sequence = Number(result.lastInsertRowid);
    return row;
  }
  private decode(row: { sequence: number; payload: string }): Evidence {
    return { ...JSON.parse(row.payload), sequence: row.sequence };
  }
  recent(limit = 16): Evidence[] {
    return (this.db.prepare('SELECT sequence,payload FROM autonomy_evidence ORDER BY sequence DESC LIMIT ?')
      .all(Math.min(64, Math.max(1, limit))) as Array<{ sequence: number; payload: string }>).map(row => this.decode(row)).reverse();
  }
  evidence(ids: string[]): Evidence[] {
    return ids.map(id => {
      const row = this.db.prepare('SELECT sequence,payload FROM autonomy_evidence WHERE id=?').get(id) as { sequence: number; payload: string } | undefined;
      if (!row) throw new Error('procedure_evidence_missing');
      return this.decode(row);
    });
  }
  private demonstration(name: string, ids: string[]): Evidence[] {
    if (typeof name !== 'string' || !name.trim() || name.length > 120 || !Array.isArray(ids) ||
        ids.length < 2 || ids.length > 12 || ids.some(id => typeof id !== 'string' || !id) ||
        new Set(ids).size !== ids.length) throw new Error('procedure_invalid_request');
    const traces = this.evidence(ids), first = traces[0];
    for (let i = 0; i < traces.length; i++) {
      const trace = traces[i];
      if (trace.status !== 'succeeded' || !trace.verified) throw new Error('procedure_requires_verified_evidence');
      if (trace.sessionId !== first.sessionId || trace.worldId !== first.worldId || trace.version !== first.version || trace.dimension !== first.dimension ||
          (i > 0 && trace.sequence !== traces[i - 1].sequence + 1)) throw new Error('procedure_requires_contiguous_demonstration');
    }
    return traces;
  }
  save(name: string, ids: string[]): LearnedProcedure {
    const traces = this.demonstration(name, ids), first = traces[0];
    const id = 'learned:' + createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 20);
    const existing = this.get(id); if (existing) return existing;
    const procedure: LearnedProcedure = { id, name: name.trim(), version: first.version, dimension: first.dimension,
      steps: deriveProcedureSteps(traces), evidenceIds: [...ids], successes: 0, failures: 0, status: 'candidate', createdAt: Date.now() };
    this.persist(procedure); return procedure;
  }
  /** A deliberately selected, demonstrated child. The parent is never reset,
   * replaced, retired, or granted the child's successes. No automatic revision. */
  revise(parentId: string, name: string, ids: string[], reason: string): LearnedProcedure {
    if (typeof parentId !== 'string' || !parentId || typeof reason !== 'string' ||
        !reason.trim() || reason.length > 300) throw new Error('procedure_revision_invalid_request');
    return this.db.transaction(() => {
      const parent = this.get(parentId);
      if (!parent) throw new Error('procedure_revision_parent_missing');
      const traces = this.demonstration(name, ids), first = traces[0];
      if (!procedureEnvironmentMatches(parent, first.version, first.dimension)) throw new Error('procedure_revision_environment_mismatch');
      const id = 'learned:' + createHash('sha256').update(JSON.stringify([parentId, ids])).digest('hex').slice(0, 20);
      const existing = this.get(id); if (existing) return existing;
      const parentEnd = this.evidence(parent.evidenceIds).at(-1);
      if (!parentEnd || first.sequence <= parentEnd.sequence) throw new Error('procedure_revision_requires_new_demonstration');
      const steps = deriveProcedureSteps(traces);
      if (ids.some(id => parent.evidenceIds.includes(id)) || canonical(steps) === canonical(parent.steps)) {
        throw new Error('procedure_revision_unchanged:replay_existing_procedure');
      }
      const child: LearnedProcedure = { id, name: name.trim(), version: first.version, dimension: first.dimension,
        steps, evidenceIds: [...ids], successes: 0, failures: 0, status: 'candidate', createdAt: Date.now(),
        parentId, rootId: parent.rootId ?? parent.id, revision: (parent.revision ?? 1) + 1,
        revisionReason: reason.trim() };
      this.persist(child); return child;
    })();
  }
  get(id: string): LearnedProcedure | undefined {
    const row = this.db.prepare('SELECT payload FROM autonomy_procedures WHERE id=?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  list(version?: string, dimension?: string): LearnedProcedure[] {
    // Filter before the display limit. Relevance ranking/indexing is separate.
    return (this.db.prepare('SELECT payload FROM autonomy_procedures ORDER BY rowid DESC').all() as { payload: string }[])
      .map(row => JSON.parse(row.payload) as LearnedProcedure)
      .filter(p => (!version || p.version === version) && (dimension == null ||
        (normalizeMemoryDimension(dimension) != null && normalizeMemoryDimension(p.dimension) === normalizeMemoryDimension(dimension))))
      .slice(0, 64);
  }
  /** Compatibility API for existing callers/tests. Its audit entries explicitly
   * lack runtime evidence; do not describe them as evidence-backed game replays. */
  recordReplay(id: string, success: boolean): void {
    this.commitReplay(id, { id: randomUUID(), outcome: success ? 'succeeded' : 'failed', evidenceIds: [],
      detail: 'legacy_boolean_report', worldId: null, version: null, dimension: null, startedAt: Date.now(),
      source: 'legacy_api', sessionId: this.sessionId });
  }
  /** Runtime reports exactly the evidence generated by this attempt, including
   * partial/interrupted traces. No last-N query that could pick up another task. */
  recordReplayAttempt(procedureId: string, input: ReplayAttemptInput): ReplayRecord {
    if (typeof input.id !== 'string' || !input.id || input.id.length > 128 ||
        !['succeeded', 'failed', 'interrupted', 'unconfirmed'].includes(input.outcome) ||
        !Array.isArray(input.evidenceIds) || input.evidenceIds.length > 12 ||
        input.evidenceIds.some(id => typeof id !== 'string' || !id) || new Set(input.evidenceIds).size !== input.evidenceIds.length ||
        typeof input.detail !== 'string' || !Number.isFinite(input.startedAt) ||
        typeof input.worldId !== 'string' || !input.worldId || typeof input.version !== 'string' || !input.version ||
        normalizeMemoryDimension(input.dimension) == null) throw new Error('procedure_replay_invalid_report');
    const procedure = this.get(procedureId);
    if (!procedure) throw new Error('procedure_not_found');
    if (!procedureEnvironmentMatches(procedure, input.version, input.dimension)) throw new Error('procedure_environment_mismatch');
    const traces = this.evidence(input.evidenceIds);
    // Unlike a demonstration selected for SAVE, a cancelled runtime's finalizer
    // can append after another task. Check this attempt's ordered prefix, not
    // adjacency in the shared append log, and never include the intervening task.
    if (traces.length > procedure.steps.length || traces.some((trace, i) =>
      trace.sessionId !== this.sessionId || trace.worldId !== input.worldId || trace.version !== input.version ||
      normalizeMemoryDimension(trace.dimension) !== normalizeMemoryDimension(input.dimension) ||
      trace.operation.action !== procedure.steps[i].operation.action ||
      (i > 0 && trace.sequence <= traces[i - 1].sequence))) throw new Error('procedure_replay_evidence_mismatch');
    if (input.outcome === 'succeeded' && (traces.length !== procedure.steps.length ||
        traces.some(trace => trace.status !== 'succeeded' || !trace.verified))) throw new Error('procedure_replay_unverified_success');
    if (input.outcome === 'failed' && traces.at(-1)?.status !== 'failed') throw new Error('procedure_replay_failure_evidence_required');
    if (input.outcome === 'unconfirmed' && (traces.at(-1)?.status !== 'succeeded' || traces.at(-1)?.verified !== false)) {
      throw new Error('procedure_replay_unconfirmed_evidence_required');
    }
    return this.commitReplay(procedureId, { ...input, evidenceIds: [...input.evidenceIds],
      source: 'runtime', sessionId: this.sessionId });
  }
  replayHistory(procedureId: string, limit = 32, offset = 0): ReplayRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('procedure_replay_invalid_page');
    }
    return (this.db.prepare('SELECT payload FROM autonomy_procedure_replays WHERE procedure_id=? ORDER BY sequence DESC LIMIT ? OFFSET ?')
      .all(procedureId, limit, offset) as Array<{ payload: string }>).map(row => JSON.parse(row.payload) as ReplayRecord).reverse();
  }
  private commitReplay(procedureId: string, input: Omit<ReplayRecord, 'procedureId' | 'completedAt' | 'before' | 'after'>): ReplayRecord {
    // Summary update and append-only audit are one transaction; retries of the
    // same attempt cannot double-count it, and a failed write rolls both back.
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT payload FROM autonomy_procedure_replays WHERE id=?').get(input.id) as { payload: string } | undefined;
      if (row) {
        const existing = JSON.parse(row.payload) as ReplayRecord;
        const { completedAt: _time, before: _before, after: _after, ...request } = existing;
        if (canonical(request) !== canonical({ ...input, procedureId })) throw new Error('procedure_replay_id_conflict');
        return existing;
      }
      const procedure = this.get(procedureId);
      if (!procedure) throw new Error('procedure_not_found');
      const before = evaluationSnapshot(procedure);
      if (input.outcome === 'succeeded' || input.outcome === 'failed') {
        if (input.outcome === 'succeeded') procedure.successes++; else procedure.failures++;
        procedure.confirmationStreak = input.outcome === 'succeeded' ? before.confirmationStreak + 1 : 0;
        procedure.evaluationPolicy = 'two_confirmed_replays_since_failure_v1';
        procedure.status = procedure.confirmationStreak >= 2 ? 'verified' : 'candidate';
        this.persist(procedure);
      }
      const record: ReplayRecord = { ...input, procedureId, evidenceIds: [...input.evidenceIds],
        completedAt: Date.now(), before, after: evaluationSnapshot(procedure) };
      this.db.prepare('INSERT INTO autonomy_procedure_replays(id,procedure_id,payload) VALUES(?,?,?)')
        .run(record.id, procedureId, JSON.stringify(record));
      return record;
    })();
  }
  private persist(procedure: LearnedProcedure): void {
    this.db.prepare('INSERT INTO autonomy_procedures(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
      .run(procedure.id, JSON.stringify(procedure));
  }
}

function evaluationSnapshot(p: LearnedProcedure): EvaluationSnapshot {
  // With historical failures the order of old boolean reports is unknown. Do
  // not manufacture a clean streak from the cumulative success count.
  const confirmationStreak = p.confirmationStreak ?? (p.failures === 0 ? p.successes : 0);
  return { status: p.status, successes: p.successes, failures: p.failures, confirmationStreak };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
