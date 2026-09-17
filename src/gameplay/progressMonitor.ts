export interface GameplayPosition {
  x: number;
  y: number;
  z: number;
}

export interface GameplayProgressSnapshot {
  timestamp: number;
  goal: string;
  reflexState: string;
  position: GameplayPosition;
  inventory: Record<string, number>;
}

export interface GameplayProgressAlert {
  stagnantForMs: number;
  goal: string;
  reflexState: string;
  detail: string;
}

export interface GameplayProgressMonitorOptions {
  stallThresholdMs?: number;
  alertCooldownMs?: number;
  movementThresholdBlocks?: number;
}

const DEFAULT_STALL_THRESHOLD_MS = 20_000;
const DEFAULT_ALERT_COOLDOWN_MS = 15_000;
const DEFAULT_MOVEMENT_THRESHOLD_BLOCKS = 1.5;

export class GameplayProgressMonitor {
  private readonly stallThresholdMs: number;
  private readonly alertCooldownMs: number;
  private readonly movementThresholdSq: number;

  private lastProgressSnapshot: GameplayProgressSnapshot | null = null;
  private lastProgressAt = 0;
  private lastAlertAt = 0;

  constructor(options: GameplayProgressMonitorOptions = {}) {
    this.stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.alertCooldownMs = options.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
    const movementThreshold = options.movementThresholdBlocks ?? DEFAULT_MOVEMENT_THRESHOLD_BLOCKS;
    this.movementThresholdSq = movementThreshold * movementThreshold;
  }

  observe(snapshot: GameplayProgressSnapshot): GameplayProgressAlert | null {
    if (!this.lastProgressSnapshot) {
      this.markProgress(snapshot);
      return null;
    }

    if (this.hasMeaningfulProgress(this.lastProgressSnapshot, snapshot)) {
      this.markProgress(snapshot);
      return null;
    }

    const stagnantForMs = Math.max(0, snapshot.timestamp - this.lastProgressAt);
    if (stagnantForMs < this.stallThresholdMs) return null;

    if (this.lastAlertAt > 0 && snapshot.timestamp - this.lastAlertAt < this.alertCooldownMs) {
      return null;
    }

    this.lastAlertAt = snapshot.timestamp;
    return {
      stagnantForMs,
      goal: snapshot.goal,
      reflexState: snapshot.reflexState,
      detail: `No observable world progress for ${Math.round(stagnantForMs / 1000)}s while state=${snapshot.reflexState} goal="${snapshot.goal || '(none)'}"`,
    };
  }

  reset(): void {
    this.lastProgressSnapshot = null;
    this.lastProgressAt = 0;
    this.lastAlertAt = 0;
  }

  private markProgress(snapshot: GameplayProgressSnapshot): void {
    this.lastProgressSnapshot = cloneSnapshot(snapshot);
    this.lastProgressAt = snapshot.timestamp;
  }

  private hasMeaningfulProgress(
    before: GameplayProgressSnapshot,
    after: GameplayProgressSnapshot,
  ): boolean {
    // Intent/state changes are deliberately NOT counted as progress.
    // The bot must actually move through the world or change its inventory.
    if (distanceSq(before.position, after.position) >= this.movementThresholdSq) return true;
    if (!sameInventory(before.inventory, after.inventory)) return true;
    return false;
  }
}

function cloneSnapshot(snapshot: GameplayProgressSnapshot): GameplayProgressSnapshot {
  return {
    ...snapshot,
    position: { ...snapshot.position },
    inventory: { ...snapshot.inventory },
  };
}

function distanceSq(a: GameplayPosition, b: GameplayPosition): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function sameInventory(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
