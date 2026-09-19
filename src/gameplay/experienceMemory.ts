import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { windowSnapshot, type PrimitiveOperation } from './primitiveOperations.js';
import { deriveProcedureSteps } from './procedureBindings.js';
import { normalizeMemoryDimension } from './worldMemory.js';
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
}

/** Append-only evidence. Procedures contain data, never JavaScript, shell commands or eval. */
export class ExperienceMemory {
  private db: Database.Database;
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
    `);
  }
  close(): void { if (this.db.open) this.db.close(); }
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
  save(name: string, ids: string[]): LearnedProcedure {
    if (!name.trim() || name.length > 120 || ids.length < 2 || ids.length > 12 || new Set(ids).size !== ids.length) throw new Error('procedure_invalid_request');
    const traces = this.evidence(ids), first = traces[0];
    for (let i = 0; i < traces.length; i++) {
      const trace = traces[i];
      if (trace.status !== 'succeeded' || !trace.verified) throw new Error('procedure_requires_verified_evidence');
      if (trace.sessionId !== first.sessionId || trace.worldId !== first.worldId || trace.version !== first.version || trace.dimension !== first.dimension ||
          (i > 0 && trace.sequence !== traces[i - 1].sequence + 1)) throw new Error('procedure_requires_contiguous_demonstration');
    }
    const id = 'learned:' + createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 20);
    const existing = this.get(id); if (existing) return existing;
    const procedure: LearnedProcedure = { id, name: name.trim(), version: first.version, dimension: first.dimension,
      steps: deriveProcedureSteps(traces), evidenceIds: [...ids], successes: 0, failures: 0, status: 'candidate', createdAt: Date.now() };
    this.persist(procedure); return procedure;
  }
  get(id: string): LearnedProcedure | undefined {
    const row = this.db.prepare('SELECT payload FROM autonomy_procedures WHERE id=?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  list(version?: string, dimension?: string): LearnedProcedure[] {
    // Filter before the display limit: other environments must not hide an
    // older compatible procedure. Relevance ranking/indexing remains separate.
    return (this.db.prepare('SELECT payload FROM autonomy_procedures ORDER BY rowid DESC').all() as { payload: string }[])
      .map(row => JSON.parse(row.payload) as LearnedProcedure)
      .filter(p => (!version || p.version === version) && (dimension == null ||
        (normalizeMemoryDimension(dimension) != null && normalizeMemoryDimension(p.dimension) === normalizeMemoryDimension(dimension))))
      .slice(0, 64);
  }
  recordReplay(id: string, success: boolean): void {
    const procedure = this.get(id); if (!procedure) throw new Error('procedure_not_found');
    if (success) procedure.successes++; else procedure.failures++;
    procedure.status = procedure.successes >= 2 && procedure.failures === 0 ? 'verified' : 'candidate';
    this.persist(procedure);
  }
  private persist(procedure: LearnedProcedure): void {
    this.db.prepare('INSERT INTO autonomy_procedures(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
      .run(procedure.id, JSON.stringify(procedure));
  }
}
