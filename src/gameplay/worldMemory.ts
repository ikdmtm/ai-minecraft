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
    const id = memoryId(scope, worldId, observation.kind, observation.key);
    const existing = this.records.get(id);
    const confidence = clamp01(observation.confidence ?? 0.9);

    const next: WorldMemoryRecord = existing
      ? {
          ...existing,
          label: observation.label,
          position: observation.position ? { ...observation.position } : existing.position,
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
      confidence: Math.max(0.25, empirical),
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

    const recalled = [...this.records.values()]
      .filter(record => {
        if (options?.kind && record.kind !== options.kind) return false;
        if (record.scope === 'world') return includeWorld && record.worldId === this.worldId;
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

  markContradictedNear(
    position: { x: number; y: number; z: number },
    radius: number,
    kinds?: string[],
    strength = 0.35,
  ): void {
    const allowed = kinds ? new Set(kinds) : null;
    const now = Date.now();
    for (const record of this.records.values()) {
      if (record.scope !== 'world' || record.worldId !== this.worldId || !record.position) continue;
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
      SELECT id, kind, label, x, y, z, confidence, first_seen_at, last_seen_at,
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
        id, kind, label, x, y, z, confidence, first_seen_at, last_seen_at,
        observations, retention, scope, world_id, metadata_json
      ) VALUES (
        @id, @kind, @label, @x, @y, @z, @confidence, @first_seen_at, @last_seen_at,
        @observations, @retention, @scope, @world_id, @metadata_json
      )
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        x = excluded.x,
        y = excluded.y,
        z = excluded.z,
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
      this.db?.prepare('DELETE FROM gameplay_memory WHERE id = ?').run(id);
    }
  }
}

function memoryId(
  scope: MemoryScope,
  worldId: string | null,
  kind: string,
  key: string,
): string {
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
