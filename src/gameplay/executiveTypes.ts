import type { PrimitiveOperation } from './primitiveOperations.js';
import type { CraftItem } from './typedActions.js';
import type { MemoryNoteInput } from './memoryConsolidation.js';

export type ExecutiveTaskType =
  | 'EXECUTE_AFFORDANCE'
  | 'EXECUTE_OPERATION'
  | 'LOOKUP_KNOWLEDGE'
  | 'RECALL_MEMORY'
  | 'CONSOLIDATE_MEMORY'
  | 'SAVE_PROCEDURE'
  | 'RUN_PROCEDURE'
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
  | 'remembered_location'
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

export type DynamicCapabilityKind =
  | 'move_to'
  | 'break_block'
  | 'attack_entity'
  | 'collect_drop'
  | 'use_item'
  | 'place_item'
  | 'craft_recipe'
  | 'process_recipe'
  | 'interact_block'
  | 'wait_condition';

export interface ExecutiveActionCapability {
  id: string;
  kind: DynamicCapabilityKind;
  description: string;
  targetId?: string;
  blockTargetId?: string;
  entityTargetId?: string;
  item?: string;
  outputItem?: string;
  station?: string;
  position?: SemanticPosition;
  preconditions: Record<string, string | number | boolean | null>;
  specification: Record<string, string | number | boolean | null>;
}

export interface ExecutiveMemoryRecord {
  id: string;
  kind: string;
  label: string;
  position?: SemanticPosition;
  confidence: number;
  lastSeenAt: number;
  observations: number;
  scope: 'world' | 'global' | 'stable';
  worldId: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

export interface ExecutiveCapabilitySnapshot {
  itemSpecs: Array<{
    name: string;
    count: number;
    stackSize: number | null;
    foodPoints: number | null;
    saturation: number | null;
    maxDurability: number | null;
    placeableBlock: string | null;
  }>;
  blockSpecs: Array<{
    name: string;
    diggable: boolean;
    hardness: number | null;
    boundingBox: string | null;
    declaredDrops: string[];
  }>;
  gather: Array<{
    resource: string;
    targetIds: string[];
    sourceBlocks: string[];
  }>;
  craft: Array<{
    item: string;
    requiresTable: boolean;
    recipeCount: number;
    owned: number;
  }>;
  actions: ExecutiveActionCapability[];
  recipes: Array<{
    item: string;
    requiresTable: boolean;
    resultCount: number;
    reachableDepth: number;
    ingredients: Array<{ item: string; count: number }>;
  }>;
}

export interface ExecutiveTaskSnapshot {
  id: number;
  task: ExecutiveTaskType | 'NONE';
  targetId: null | string;
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
    smokerNearby: boolean;
    containerNearby: boolean;
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
  memory: ExecutiveMemoryRecord[];
  recentEvents: Array<{ type: string; detail: string; importance: string }>;
  autonomy?: Record<string, unknown>;
}

export interface ExecutiveDecision {
  operation?: PrimitiveOperation;
  knowledgeQuery?: string;
  knowledgeOffset?: number;
  memoryQuery?: string;
  memoryCursor?: string;
  memoryNote?: MemoryNoteInput;
  procedureName?: string;
  evidenceIds?: string[];
  procedureId?: string;
  task: ExecutiveTaskType;
  targetId?: string;
  resource?: ExecutiveResource;
  craftItem?: CraftItem;
  capabilityId?: string;
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
  'EXECUTE_OPERATION', 'LOOKUP_KNOWLEDGE', 'RECALL_MEMORY', 'CONSOLIDATE_MEMORY', 'SAVE_PROCEDURE', 'RUN_PROCEDURE',
  'EXECUTE_AFFORDANCE',
  'WAIT',
];

export const EXECUTIVE_STRUCTURES: ExecutiveStructure[] = [
  'none',
  'shelter',
];
