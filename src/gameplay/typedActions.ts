export type GameplayActionType =
  | 'CONTINUE'
  | 'NAVIGATE'
  | 'EXPLORE'
  | 'MINE'
  | 'DIG_STAIRCASE'
  | 'CRAFT'
  | 'BUILD_SHELTER'
  | 'HUNT_FOOD'
  | 'EAT'
  | 'FLEE'
  | 'ATTACK'
  | 'SLEEP'
  | 'WAIT';

export type CompassDirection = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export type CraftItem = string;

export interface TypedGameplayDecision {
  action: GameplayActionType;
  blockTargetId?: string;
  entityTargetId?: string;
  craftItem?: CraftItem;
  direction?: CompassDirection;
  targetPosition?: { x: number; y: number; z: number };
  confidence: number;
  reason?: string;
  source: 'jev' | 'openai' | 'safety' | 'fallback' | 'task';
}

export interface SkillSnapshot {
  id: number;
  action: GameplayActionType | 'NONE';
  targetId: string | null;
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: number | null;
  updatedAt: number;
  detail: string;
}

export interface WorldCandidate {
  id: string;
  kind: 'block' | 'entity';
  name: string;
  distance: number;
  position: { x: number; y: number; z: number };
  hostile?: boolean;
  foodAnimal?: boolean;
}

export interface JevWorldState {
  ts: number;
  player: {
    hp: number;
    hunger: number;
    oxygen: number;
    onFire: boolean;
    position: { x: number; y: number; z: number };
    heldItem: string | null;
  };
  world: {
    timeOfDay: number;
    day: number;
    isNight: boolean;
    raining: boolean;
    blockBelow: string | null;
  };
  inventory: Record<string, number>;
  strategy: {
    mainGoal: string;
    subGoals: string[];
  };
  currentSkill: SkillSnapshot;
  blockCandidates: WorldCandidate[];
  entityCandidates: WorldCandidate[];
  recentEvents: Array<{ type: string; detail: string; importance: string }>;
}

export const GAMEPLAY_ACTIONS: GameplayActionType[] = [
  'CONTINUE',
  'NAVIGATE',
  'EXPLORE',
  'MINE',
  'DIG_STAIRCASE',
  'CRAFT',
  'BUILD_SHELTER',
  'HUNT_FOOD',
  'EAT',
  'FLEE',
  'ATTACK',
  'SLEEP',
  'WAIT',
];

export const COMPASS_DIRECTIONS: CompassDirection[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
