export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface Equipment {
  hand: string | null;
  helmet: string | null;
  chestplate: string | null;
  leggings: string | null;
  boots: string | null;
}

export interface NearbyEntity {
  type: string;
  distance: number;
  direction: string;
}

export interface NearbyBlock {
  type: string;
  distance: number;
  direction: string;
}

export interface PlayerState {
  hp: number;
  maxHp: number;
  hunger: number;
  position: Position;
  biome: string;
  equipment: Equipment;
  inventorySummary: string[];
}

export interface WorldState {
  timeOfDay: 'day' | 'night' | 'dawn' | 'dusk';
  minecraftTime: number;
  weather: 'clear' | 'rain' | 'thunder';
  lightLevel: number;
  nearbyEntities: NearbyEntity[];
  nearbyBlocksOfInterest: NearbyBlock[];
}

export interface BaseInfo {
  known: boolean;
  position: Position | null;
  distance: number | null;
  hasBed: boolean;
  hasFurnace: boolean;
  hasCraftingTable: boolean;
}

export interface PacingInfo {
  currentActionCategory: ActionCategory;
  categoryDurationMinutes: number;
  survivalTimeMinutes: number;
  progressPhase: ProgressPhase;
  bestRecordMinutes: number;
}

export interface PreviousPlan {
  goal: string;
  status: 'in_progress' | 'completed' | 'failed' | 'interrupted';
  progress: string;
}

export interface RecentEvent {
  time: string;
  event: string;
  detail: string;
}

export interface DeathRecord {
  generation: number;
  survivalMinutes: number;
  cause: string;
  lesson: string;
}

export interface Memory {
  totalDeaths: number;
  bestRecordMinutes: number;
  recentDeaths: DeathRecord[];
}

export interface GameState {
  player: PlayerState;
  world: WorldState;
  base: BaseInfo;
  pacing: PacingInfo;
  previousPlan: PreviousPlan | null;
  recentEvents: RecentEvent[];
  stagnationWarning: boolean;
  memory: Memory;
}

export type ActionCategory =
  | 'mining'
  | 'building'
  | 'exploring'
  | 'combat'
  | 'waiting'
  | 'moving'
  | 'crafting'
  | 'farming';

export type ProgressPhase = 'early' | 'stable' | 'advanced' | 'challenge';
