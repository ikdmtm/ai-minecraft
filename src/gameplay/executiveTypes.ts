import type { CraftItem } from './typedActions.js';

export type ExecutiveTaskType =
  | 'CONTINUE_TASK'
  | 'NAVIGATE_TARGET'
  | 'GATHER_RESOURCE'
  | 'EXCAVATE_TARGET'
  | 'ATTACK_TARGET'
  | 'CRAFT_ITEM'
  | 'BUILD_STRUCTURE'
  | 'WAIT';

export type ExecutiveResource = string;
export type ExecutiveStructure = 'none' | 'shelter';

export type SemanticTargetKind =
  | 'land'
  | 'shelter_site'
  | 'excavation_site'
  | 'tree_cluster'
  | 'stone_source'
  | 'food_source'
  | 'item_drop'
  | 'resource_source'
  | 'entity'
  | 'known_structure';

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

export interface ExecutiveCapabilitySnapshot {
  gather: Array<{
    resource: string;
    targetIds: string[];
    sourceBlocks: string[];
  }>;
  craft: Array<{
    item: string;
    requiresTable: boolean;
    recipeCount: number;
  }>;
  recipes: Array<{
    item: string;
    requiresTable: boolean;
    resultCount: number;
    reachableDepth: number;
    ingredients: Array<{ item: string; count: number }>;
  }>;
  entityActions: Array<{
    targetId: string;
    entity: string;
    hostile: boolean;
    actions: readonly ['NAVIGATE_TARGET', 'ATTACK_TARGET'];
  }>;
  canExcavate: boolean;
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
  facilities: {
    craftingTableNearby: boolean;
    furnaceNearby: boolean;
    bedNearby: boolean;
    shelterNearby: boolean;
  };
  capabilities: ExecutiveCapabilitySnapshot;
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
  'EXCAVATE_TARGET',
  'ATTACK_TARGET',
  'CRAFT_ITEM',
  'BUILD_STRUCTURE',
  'WAIT',
];

export const EXECUTIVE_STRUCTURES: ExecutiveStructure[] = [
  'none',
  'shelter',
];
