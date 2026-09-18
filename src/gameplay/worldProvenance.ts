import { Vec3 } from 'vec3';

export type PlacedBlockRole = 'structure' | 'workstation' | 'utility';

export class WorldProvenance {
  private readonly placed = new Map<string, {
    role: PlacedBlockRole;
    placedAt: number;
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
