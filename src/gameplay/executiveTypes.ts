import type { CraftItem } from './typedActions.js';

export type ExecutiveTaskType =
  | 'CONTINUE_TASK'
  | 'NAVIGATE_TARGET'
  | 'GATHER_RESOURCE'
  | 'CRAFT_ITEM'
  | 'BUILD_STRUCTURE'
  | 'WAIT';

export type ExecutiveResource = 'none' | 'logs' | 'cobblestone' | 'food';
export type ExecutiveStructure = 'none' | 'shelter';

export type SemanticTargetKind =
  | 'land'
  | 'shelter_site'
  | 'tree_cluster'
  | 'stone_source'
  | 'food_source';

export interface SemanticPosition {
  x: number;
  y: number;
  z: number;
}

export interface SemanticTarget {
  id: string;
  kind: SemanticTargetKind;
  position: SemanticPosition;
  distance: number;
  score: number;
  risk: 'low' | 'medium' | 'high';
  metadata: Record<string, string | number | boolean | null>;
}

export interface ExecutiveTaskSnapshot {
  id: number;
  task: ExecutiveTaskType | 'NONE';
  targetId: string | null;
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: number | null;
  updatedAt: number;
  detail: string;
  progress: Record<string, number | string | boolean | null>;
}

export interface ExecutiveWorldState {
  revision: number;
  capturedAt: number;
  player: {
    hp: number;
    hunger: number;
    oxygen: number;
    position: SemanticPosition;
    inWater: boolean;
    onSolidGround: boolean;
  };
  world: {
    timeOfDay: number;
    day: number;
    isNight: boolean;
    raining: boolean;
  };
  inventory: Record<string, number>;
  strategy: {
    mainGoal: string;
    subGoals: string[];
  };
  activeTask: ExecutiveTaskSnapshot;
  targets: SemanticTarget[];
  recentEvents: Array<{ type: string; detail: string; importance: string }>;
}

export interface ExecutiveDecision {
  task: ExecutiveTaskType;
  targetId?: string;
  resource?: ExecutiveResource;
  craftItem?: CraftItem;
  structure?: ExecutiveStructure;
  amount?: number;
  confidence: number;
  source: 'jev' | 'openai' | 'fallback';
  basedOnRevision: number;
  reason?: string;
}

export interface TaskExecutionResult {
  status: 'succeeded' | 'failed' | 'interrupted';
  detail: string;
}

export const EXECUTIVE_TASKS: ExecutiveTaskType[] = [
  'CONTINUE_TASK',
  'NAVIGATE_TARGET',
  'GATHER_RESOURCE',
  'CRAFT_ITEM',
  'BUILD_STRUCTURE',
  'WAIT',
];

export const EXECUTIVE_RESOURCES: ExecutiveResource[] = [
  'none',
  'logs',
  'cobblestone',
  'food',
];

export const EXECUTIVE_STRUCTURES: ExecutiveStructure[] = [
  'none',
  'shelter',
];
