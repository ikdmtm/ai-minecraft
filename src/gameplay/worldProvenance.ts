import { Vec3 } from 'vec3';

export type PlacedBlockRole = 'structure' | 'workstation' | 'utility';

export class WorldProvenance {
  private readonly placed = new Map<string, {
    role: PlacedBlockRole;
    placedAt: number;
  }>();
  private readonly structures = new Map<string, {
    kind: string;
    position: { x: number; y: number; z: number };
    completedAt: number;
  }>();

  markPlaced(position: { x: number; y: number; z: number }, role: PlacedBlockRole): void {
    this.placed.set(key(position), { role, placedAt: Date.now() });
  }

  forget(position: { x: number; y: number; z: number }): void {
    this.placed.delete(key(position));
  }

  isPlayerPlaced(position: { x: number; y: number; z: number }): boolean {
    return this.placed.has(key(position));
  }

  roleOf(position: { x: number; y: number; z: number }): PlacedBlockRole | null {
    return this.placed.get(key(position))?.role ?? null;
  }

  markStructure(kind: string, position: { x: number; y: number; z: number }): void {
    this.structures.set(`${kind}:${key(position)}`, {
      kind,
      position: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
      completedAt: Date.now(),
    });
  }

  listStructures(kind?: string): Array<{
    kind: string;
    position: { x: number; y: number; z: number };
    completedAt: number;
  }> {
    return [...this.structures.values()]
      .filter(entry => !kind || entry.kind === kind)
      .map(entry => ({
        kind: entry.kind,
        position: { ...entry.position },
        completedAt: entry.completedAt,
      }));
  }

  hasStructureNearby(
    kind: string,
    position: { x: number; y: number; z: number },
    maxDistance: number,
  ): boolean {
    for (const entry of this.structures.values()) {
      if (entry.kind !== kind) continue;
      const distance = Math.hypot(
        entry.position.x - position.x,
        entry.position.y - position.y,
        entry.position.z - position.z,
      );
      if (distance <= maxDistance) return true;
    }
    return false;
  }

  pruneMissing(blockAt: (pos: Vec3) => any | null): void {
    for (const value of this.placed.keys()) {
      const [x, y, z] = value.split(':').map(Number);
      const block = blockAt(new Vec3(x, y, z));
      if (!block || block.name === 'air') this.placed.delete(value);
    }
  }
}

function key(position: { x: number; y: number; z: number }): string {
  return `${Math.floor(position.x)}:${Math.floor(position.y)}:${Math.floor(position.z)}`;
}
