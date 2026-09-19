import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

export type MemoryRetention = 'transient' | 'session' | 'stable';
export type MemoryScope = 'world' | 'global' | 'stable';

export interface WorldMemoryObservation {
  kind: string;
  key: string;
  label: string;
  position?: { x: number; y: number; z: number };
  dimension?: string | null;
  scope?: MemoryScope;
  retention?: MemoryRetention;
  confidence?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WorldMemoryRecord {
  id: string;
  kind: string;
  label: string;
  position?: { x: number; y: number; z: number };
  dimension: string | null;
  confidence: number;
  firstSeenAt: number;
  lastSeenAt: number;
  observations: number;
  retention: MemoryRetention;
  scope: MemoryScope;
  worldId: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

type MemoryRow = {
  id: string;
  kind: string;
  label: string;
  x: number | null;
  y: number | null;
  z: number | null;
  dimension: string | null;
  confidence: number;
  first_seen_at: number;
  last_seen_at: number;
  observations: number;
  retention: MemoryRetention;
  scope: MemoryScope;
  world_id: string | null;
  metadata_json: string;
};

export class WorldMemory {
  private readonly records = new Map<string, WorldMemoryRecord>();
  private readonly db: Database.Database | null;
  private worldId: string;

  constructor(dbPath?: string, worldId?: string) {
    if (dbPath) mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = dbPath ? new Database(dbPath) : null;
    this.worldId = worldId ?? 'world-ephemeral';
    if (this.db) {
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS gameplay_memory_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS gameplay_memory (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          label TEXT NOT NULL,
          x REAL,
          y REAL,
          z REAL,
          dimension TEXT,
          confidence REAL NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          observations INTEGER NOT NULL,
          retention TEXT NOT NULL,
          scope TEXT NOT NULL,
          world_id TEXT,
          metadata_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_gameplay_memory_scope
          ON gameplay_memory(scope, world_id, kind, last_seen_at);
      `);
      // Additive migration: old coordinates remain dimension-unknown history.
      // Never guess overworld, rewrite IDs, or delete the previous records.
      const database = this.db;
      database.transaction(() => {
        const columns = database.prepare('PRAGMA table_info(gameplay_memory)').all() as Array<{ name: string }>;
        if (!columns.some(column => column.name === 'dimension')) {
          database.exec('ALTER TABLE gameplay_memory ADD COLUMN dimension TEXT');
        }
      })();
      const persistedWorld = this.db.prepare(
        'SELECT value FROM gameplay_memory_meta WHERE key = ?',
      ).get('current_world_id') as { value?: string } | undefined;
      this.worldId = worldId ?? persistedWorld?.value ?? newWorldId();
      this.persistCurrentWorldId();
      this.loadPersisted();
    } else if (!worldId) {
      this.worldId = newWorldId();
    }
  }

  setWorldId(worldId: string): void {
    this.worldId = worldId;
    this.persistCurrentWorldId();
  }

  startNewWorld(): string {
    this.worldId = newWorldId();
    this.persistCurrentWorldId();
    return this.worldId;
  }

  getWorldId(): string {
    return this.worldId;
  }

  observe(observation: WorldMemoryObservation): WorldMemoryRecord {
    const now = Date.now();
    const scope = observation.scope ?? 'world';
    const retention = observation.retention ?? (scope === 'stable' ? 'stable' : 'session');
    const worldId = scope === 'world' ? this.worldId : null;
    const dimension = scope === 'world' ? normalizeMemoryDimension(observation.dimension) : null;
    const id = memoryId(scope, worldId, observation.kind, observation.key, dimension);
    const existing = this.records.get(id);
    const confidence = clamp01(observation.confidence ?? 0.9);
    // Sampling the same fact many times a second is not independent evidence or a reason for a disk write.
    if (existing && now - existing.lastSeenAt < 2000 &&
        JSON.stringify(existing.metadata) === JSON.stringify(observation.metadata ?? {}) &&
        ((!existing.position && !observation.position) || (existing.position && observation.position && distance(existing.position, observation.position) < 0.5))) {
      return cloneRecord(existing);
    }

    const next: WorldMemoryRecord = existing
      ? {
          ...existing,
          label: observation.label,
          position: observation.position ? { ...observation.position } : existing.position,
          dimension,
          confidence: Math.max(effectiveConfidence(existing, now), confidence),
          lastSeenAt: now,
          observations: existing.observations + 1,
          retention: strongerRetention(existing.retention, retention),
          scope,
          worldId,
          metadata: {
            ...existing.metadata,
            ...(observation.metadata ?? {}),
          },
        }
      : {
          id,
          kind: observation.kind,
          label: observation.label,
          position: observation.position ? { ...observation.position } : undefined,
          dimension,
          confidence,
          firstSeenAt: now,
          lastSeenAt: now,
          observations: 1,
          retention,
          scope,
          worldId,
          metadata: { ...(observation.metadata ?? {}) },
        };

    this.records.set(id, next);
    this.persist(next);
    return cloneRecord(next);
  }

  recordProcedureOutcome(input: {
    key: string;
    label: string;
    success: boolean;
    detail: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): WorldMemoryRecord {
    const scope: MemoryScope = 'global';
    const id = memoryId(scope, null, 'procedure', input.key);
    const existing = this.records.get(id);
    const successes = Number(existing?.metadata.successes ?? 0) + (input.success ? 1 : 0);
    const failures = Number(existing?.metadata.failures ?? 0) + (input.success ? 0 : 1);
    const attempts = successes + failures;
    const empirical = attempts > 0 ? successes / attempts : 0.5;

    return this.observe({
      kind: 'procedure',
      key: input.key,
      label: input.label,
      scope,
      retention: 'stable',
      confidence: 1, // Confidence in the recorded evidence, not probability of future success.
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
        successes,
        failures,
        attempts,
        successRate: Math.round(empirical * 1000) / 1000,
        lastOutcome: input.success ? 'success' : 'failure',
        lastDetail: input.detail.slice(0, 240),
      },
    });
  }

  recall(options?: {
    kind?: string;
    dimension?: string | null;
    origin?: { x: number; y: number; z: number };
    minConfidence?: number;
    limit?: number;
    includeWorld?: boolean;
    includeGlobal?: boolean;
  }): WorldMemoryRecord[] {
    const now = Date.now();
    const minConfidence = options?.minConfidence ?? 0.12;
    const origin = options?.origin;
    const includeWorld = options?.includeWorld ?? true;
    const includeGlobal = options?.includeGlobal ?? true;
    // No dimension means legacy/unknown only, NOT a wildcard across all maps.
    // Runtime callers must pass the currently observed dimension.
    const dimension = normalizeMemoryDimension(options?.dimension);

    const recalled = [...this.records.values()]
      .filter(record => {
        if (options?.kind && record.kind !== options.kind) return false;
        if (record.scope === 'world') {
          return includeWorld && record.worldId === this.worldId && record.dimension === dimension;
        }
        return includeGlobal;
      })
      .map(record => ({
        ...cloneRecord(record),
        confidence: effectiveConfidence(record, now),
      }))
      .filter(record => record.confidence >= minConfidence)
      .sort((a, b) => {
        const confidenceDelta = b.confidence - a.confidence;
        if (Math.abs(confidenceDelta) > 0.05) return confidenceDelta;
        if (origin && a.position && b.position) {
          const da = distance(origin, a.position);
          const db = distance(origin, b.position);
          if (da !== db) return da - db;
        } else if (origin && Boolean(a.position) !== Boolean(b.position)) {
          return a.position ? -1 : 1;
        }
        return b.lastSeenAt - a.lastSeenAt;
      })
      .slice(0, options?.limit ?? 32);

    this.prune(now);
    return recalled;
  }

  close(): void { if (this.db?.open) this.db.close(); }

  recallHistory(worldId: string, limit = 16): WorldMemoryRecord[] {
    if (!this.db) return [...this.records.values()].filter(r => r.scope === 'world' && r.worldId === worldId).slice(0, limit).map(cloneRecord);
    const rows = this.db.prepare('SELECT * FROM gameplay_memory WHERE scope = ? AND world_id = ? ORDER BY last_seen_at DESC LIMIT ?').all('world', worldId, Math.min(64, limit)) as MemoryRow[];
    return rows.map(r => ({ id: r.id, kind: r.kind, label: r.label,
      position: r.x == null || r.y == null || r.z == null ? undefined : { x: r.x, y: r.y, z: r.z },
      dimension: normalizeMemoryDimension(r.dimension),
      confidence: r.confidence, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, observations: r.observations,
      retention: r.retention, scope: r.scope, worldId: r.world_id, metadata: JSON.parse(r.metadata_json) }));
  }

  markContradictedNear(
    position: { x: number; y: number; z: number },
    radius: number,
    kinds?: string[],
    strength = 0.35,
    dimension?: string | null,
  ): void {
    const allowed = kinds ? new Set(kinds) : null;
    const currentDimension = normalizeMemoryDimension(dimension);
    const now = Date.now();
    for (const record of this.records.values()) {
      if (record.scope !== 'world' || record.worldId !== this.worldId || !record.position || record.dimension !== currentDimension) continue;
      if (allowed && !allowed.has(record.kind)) continue;
      if (distance(position, record.position) > radius) continue;
      record.confidence = clamp01(effectiveConfidence(record, now) - strength);
      record.lastSeenAt = now;
      this.persist(record);
    }
  }

  markContradicted(id: string, strength = 0.35): void {
    const record = this.records.get(id);
    if (!record) return;
    record.confidence = clamp01(effectiveConfidence(record, Date.now()) - strength);
    record.lastSeenAt = Date.now();
    this.persist(record);
  }

  reinforce(id: string, amount = 0.1): void {
    const record = this.records.get(id);
    if (!record) return;
    record.confidence = clamp01(effectiveConfidence(record, Date.now()) + amount);
    record.lastSeenAt = Date.now();
    this.persist(record);
  }

  private persistCurrentWorldId(): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO gameplay_memory_meta(key, value)
      VALUES('current_world_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(this.worldId);
  }

  private loadPersisted(): void {
    if (!this.db) return;
    const rows = this.db.prepare(`
      SELECT id, kind, label, x, y, z, dimension, confidence, first_seen_at, last_seen_at,
             observations, retention, scope, world_id, metadata_json
      FROM gameplay_memory
    `).all() as MemoryRow[];

    for (const row of rows) {
      let metadata: Record<string, string | number | boolean | null> = {};
      try {
        const parsed = JSON.parse(row.metadata_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
      } catch {
        // Keep corrupt metadata isolated; the memory itself is still usable.
      }
      const position = row.x == null || row.y == null || row.z == null
        ? undefined
        : { x: row.x, y: row.y, z: row.z };
      this.records.set(row.id, {
        id: row.id,
        kind: row.kind,
        label: row.label,
        position,
        dimension: normalizeMemoryDimension(row.dimension),
        confidence: row.confidence,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        observations: row.observations,
        retention: row.retention,
        scope: row.scope,
        worldId: row.world_id,
        metadata,
      });
    }
  }

  private persist(record: WorldMemoryRecord): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO gameplay_memory (
        id, kind, label, x, y, z, dimension, confidence, first_seen_at, last_seen_at,
        observations, retention, scope, world_id, metadata_json
      ) VALUES (
        @id, @kind, @label, @x, @y, @z, @dimension, @confidence, @first_seen_at, @last_seen_at,
        @observations, @retention, @scope, @world_id, @metadata_json
      )
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        x = excluded.x,
        y = excluded.y,
        z = excluded.z,
        dimension = excluded.dimension,
        confidence = excluded.confidence,
        last_seen_at = excluded.last_seen_at,
        observations = excluded.observations,
        retention = excluded.retention,
        metadata_json = excluded.metadata_json
    `).run({
      id: record.id,
      kind: record.kind,
      label: record.label,
      x: record.position?.x ?? null,
      y: record.position?.y ?? null,
      z: record.position?.z ?? null,
      dimension: record.dimension,
      confidence: record.confidence,
      first_seen_at: record.firstSeenAt,
      last_seen_at: record.lastSeenAt,
      observations: record.observations,
      retention: record.retention,
      scope: record.scope,
      world_id: record.worldId,
      metadata_json: JSON.stringify(record.metadata),
    });
  }

  private prune(now: number): void {
    for (const [id, record] of this.records) {
      if (record.retention === 'stable' || record.scope !== 'world') continue;
      if (effectiveConfidence(record, now) >= 0.025) continue;
      this.records.delete(id);
      // Retain the disk record as history; forgetting removes only active working memory.
    }
  }
}

/** Normalize protocol/resource-location spelling without inventing a dimension. */
export function normalizeMemoryDimension(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name === 'overworld') return 'minecraft:overworld';
  if (name === 'nether' || name === 'the_nether') return 'minecraft:the_nether';
  if (name === 'end' || name === 'the_end') return 'minecraft:the_end';
  return /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(name) ? name : null;
}

function memoryId(
  scope: MemoryScope,
  worldId: string | null,
  kind: string,
  key: string,
  dimension: string | null = null,
): string {
  if (scope === 'world' && dimension != null) {
    return `world-dimension:${JSON.stringify([worldId, dimension, kind, key])}`;
  }
  return scope === 'world'
    ? `world:${worldId ?? 'unknown'}:${kind}:${key}`
    : `${scope}:${kind}:${key}`;
}

function cloneRecord(record: WorldMemoryRecord): WorldMemoryRecord {
  return {
    ...record,
    position: record.position ? { ...record.position } : undefined,
    metadata: { ...record.metadata },
  };
}

function effectiveConfidence(record: WorldMemoryRecord, now: number): number {
  if (record.retention === 'stable' || record.scope === 'stable') return record.confidence;
  const ageMs = Math.max(0, now - record.lastSeenAt);
  const halfLifeMs = record.retention === 'transient'
    ? 3 * 60_000
    : record.scope === 'global'
      ? 12 * 60 * 60_000
      : 30 * 60_000;
  return clamp01(record.confidence * Math.pow(0.5, ageMs / halfLifeMs));
}

function strongerRetention(a: MemoryRetention, b: MemoryRetention): MemoryRetention {
  const rank: Record<MemoryRetention, number> = {
    transient: 0,
    session: 1,
    stable: 2,
  };
  return rank[a] >= rank[b] ? a : b;
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function newWorldId(): string {
  return `world-${Date.now()}-${randomUUID().slice(0, 8)}`;
}
