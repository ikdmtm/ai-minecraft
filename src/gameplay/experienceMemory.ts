import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { parseOperation, windowSnapshot, type PrimitiveOperation } from './primitiveOperations.js';

export interface Evidence {
  id: string; sequence: number; sessionId: string; worldId: string; version: string; dimension: string;
  operation: PrimitiveOperation; status: 'succeeded' | 'failed' | 'interrupted'; verified: boolean;
  detail: string; effect: string; origin: { x: number; y: number; z: number };
  blockName?: string; entityName?: string;
  window: ReturnType<typeof windowSnapshot>; createdAt: number;
}
export interface ProcedureStep {
  operation: PrimitiveOperation;
  binding?: { kind: 'block' | 'entity'; name: string } | { kind: 'relative'; offset: { x: number; y: number; z: number } };
  windowType?: string;
  sourceItem?: string;
  destinationInventory?: boolean;
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
    const origin = first.origin;
    const steps = traces.map(trace => {
      const operation = parseOperation(trace.operation);
      const step: ProcedureStep = { operation: { ...operation } };
      delete step.operation.position; delete step.operation.entityId; delete step.operation.windowId;
      if (['PLACE', 'MOVE', 'LOOK'].includes(operation.action) || (operation.position && !trace.blockName)) {
        const p = operation.position!;
        step.binding = { kind: 'relative', offset: { x: p.x - Math.floor(origin.x), y: p.y - Math.floor(origin.y), z: p.z - Math.floor(origin.z) } };
      } else if (operation.position && trace.blockName) step.binding = { kind: 'block', name: trace.blockName };
      if (operation.entityId != null) {
        if (!trace.entityName) throw new Error('procedure_unknown_entity_binding');
        step.binding = { kind: 'entity', name: trace.entityName };
      }
      if (operation.action === 'TRANSFER') {
        step.windowType = String(trace.window.type);
        const source = trace.window.slots[operation.sourceSlot!];
        const destination = trace.window.slots[operation.destinationSlot!];
        if (!source?.item || !destination) throw new Error('procedure_missing_slot_evidence');
        if (source.zone === 'inventory') { step.sourceItem = source.item; delete step.operation.sourceSlot; }
        if (destination.zone === 'inventory') { step.destinationInventory = true; delete step.operation.destinationSlot; }
      }
      if (operation.action === 'WAIT' && (operation.durationMs ?? 5000) > 10000) throw new Error('procedure_wait_too_long');
      return step;
    });
    const procedure: LearnedProcedure = { id, name: name.trim(), version: first.version, dimension: first.dimension,
      steps, evidenceIds: [...ids], successes: 0, failures: 0, status: 'candidate', createdAt: Date.now() };
    this.persist(procedure); return procedure;
  }
  get(id: string): LearnedProcedure | undefined {
    const row = this.db.prepare('SELECT payload FROM autonomy_procedures WHERE id=?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  list(version?: string, dimension?: string): LearnedProcedure[] {
    return (this.db.prepare('SELECT payload FROM autonomy_procedures ORDER BY rowid DESC LIMIT 64').all() as { payload: string }[])
      .map(row => JSON.parse(row.payload) as LearnedProcedure)
      .filter(p => (!version || p.version === version) && (!dimension || p.dimension === dimension));
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

/** Late binding makes a learned procedure reusable without importing old-world coordinates. */
export function bindProcedureStep(
  step: ProcedureStep, bot: mineflayer.Bot, anchor: Vec3, entities: Map<string, number>,
): PrimitiveOperation {
  const op = { ...step.operation };
  if (step.binding?.kind === 'relative') op.position = anchor.plus(new Vec3(step.binding.offset.x, step.binding.offset.y, step.binding.offset.z));
  if (step.binding?.kind === 'block') {
    const name = step.binding.name;
    const block = bot.findBlock({ matching: b => b.name === name && bot.canSeeBlock(b), maxDistance: 16 });
    if (!block) throw new Error(`procedure_block_precondition_missing:${name}`);
    op.position = { ...block.position };
  }
  if (step.binding?.kind === 'entity') {
    const name = step.binding.name;
    let id = entities.get(name);
    if (id == null) {
      const entity = bot.nearestEntity(e => e.name === name && e !== bot.entity);
      if (!entity) throw new Error(`procedure_entity_precondition_missing:${name}`);
      id = entity.id; entities.set(name, id);
    }
    if (!bot.entities[id]) throw new Error('procedure_bound_entity_disappeared');
    op.entityId = id;
  }
  if (op.action === 'CLOSE') op.windowId = (bot.currentWindow ?? bot.inventory).id;
  if (op.action === 'TRANSFER') {
    const win = bot.currentWindow ?? bot.inventory;
    if (String(win.type) !== step.windowType) throw new Error('procedure_window_precondition_changed');
    op.windowId = win.id;
    if (step.sourceItem) {
      const slot = win.slots.findIndex((item, index) => index >= win.inventoryStart && index < win.inventoryEnd &&
        item != null && item.name === step.sourceItem && item.count >= (op.count ?? 1));
      if (slot < 0) throw new Error('procedure_inventory_item_missing');
      op.sourceSlot = slot;
    }
    if (step.destinationInventory) {
      const source = win.slots[op.sourceSlot!];
      const slot = win.slots.findIndex((item, index) => index >= win.inventoryStart && index < win.inventoryEnd && index !== op.sourceSlot &&
        (!item || (source && item.type === source.type && JSON.stringify(item.nbt) === JSON.stringify(source.nbt) && item.count + (op.count ?? 1) <= item.stackSize)));
      if (slot < 0) throw new Error('procedure_inventory_full');
      op.destinationSlot = slot;
    }
  }
  return parseOperation(op);
}
