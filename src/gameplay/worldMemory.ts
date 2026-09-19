export type MemoryRetention = 'transient' | 'session' | 'stable';

export interface WorldMemoryObservation {
  kind: string;
  key: string;
  label: string;
  position: { x: number; y: number; z: number };
  retention?: MemoryRetention;
  confidence?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WorldMemoryRecord {
  id: string;
  kind: string;
  label: string;
  position: { x: number; y: number; z: number };
  confidence: number;
  firstSeenAt: number;
  lastSeenAt: number;
  observations: number;
  retention: MemoryRetention;
  metadata: Record<string, string | number | boolean | null>;
}

export class WorldMemory {
  private readonly records = new Map<string, WorldMemoryRecord>();

  observe(observation: WorldMemoryObservation): WorldMemoryRecord {
    const now = Date.now();
    const id = `${observation.kind}:${observation.key}`;
    const existing = this.records.get(id);
    const confidence = clamp01(observation.confidence ?? 0.9);

    if (existing) {
      const merged: WorldMemoryRecord = {
        ...existing,
        label: observation.label,
        position: { ...observation.position },
        confidence: Math.max(effectiveConfidence(existing, now), confidence),
        lastSeenAt: now,
        observations: existing.observations + 1,
        retention: strongerRetention(existing.retention, observation.retention ?? existing.retention),
        metadata: {
          ...existing.metadata,
          ...(observation.metadata ?? {}),
        },
      };
      this.records.set(id, merged);
      return { ...merged, position: { ...merged.position }, metadata: { ...merged.metadata } };
    }

    const created: WorldMemoryRecord = {
      id,
      kind: observation.kind,
      label: observation.label,
      position: { ...observation.position },
      confidence,
      firstSeenAt: now,
      lastSeenAt: now,
      observations: 1,
      retention: observation.retention ?? 'session',
      metadata: { ...(observation.metadata ?? {}) },
    };
    this.records.set(id, created);
    return { ...created, position: { ...created.position }, metadata: { ...created.metadata } };
  }

  recall(options?: {
    kind?: string;
    origin?: { x: number; y: number; z: number };
    minConfidence?: number;
    limit?: number;
  }): WorldMemoryRecord[] {
    const now = Date.now();
    const minConfidence = options?.minConfidence ?? 0.12;
    const origin = options?.origin;

    const recalled = [...this.records.values()]
      .filter(record => !options?.kind || record.kind === options.kind)
      .map(record => ({
        ...record,
        position: { ...record.position },
        metadata: { ...record.metadata },
        confidence: effectiveConfidence(record, now),
      }))
      .filter(record => record.confidence >= minConfidence)
      .sort((a, b) => {
        const confidenceDelta = b.confidence - a.confidence;
        if (Math.abs(confidenceDelta) > 0.05) return confidenceDelta;
        if (origin) {
          const da = distance(origin, a.position);
          const db = distance(origin, b.position);
          if (da !== db) return da - db;
        }
        return b.lastSeenAt - a.lastSeenAt;
      })
      .slice(0, options?.limit ?? 32);

    this.prune(now);
    return recalled;
  }

  clear(): void {
    this.records.clear();
  }

  markContradicted(id: string, strength = 0.35): void {
    const record = this.records.get(id);
    if (!record) return;
    record.confidence = clamp01(effectiveConfidence(record, Date.now()) - strength);
  }

  reinforce(id: string, amount = 0.1): void {
    const record = this.records.get(id);
    if (!record) return;
    record.confidence = clamp01(effectiveConfidence(record, Date.now()) + amount);
    record.lastSeenAt = Date.now();
  }

  private prune(now: number): void {
    for (const [id, record] of this.records) {
      if (record.retention === 'stable') continue;
      if (effectiveConfidence(record, now) < 0.025) this.records.delete(id);
    }
  }
}

function effectiveConfidence(record: WorldMemoryRecord, now: number): number {
  if (record.retention === 'stable') return record.confidence;
  const ageMs = Math.max(0, now - record.lastSeenAt);
  const halfLifeMs = record.retention === 'transient'
    ? 3 * 60_000
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
