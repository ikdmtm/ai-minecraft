/**
 * リアクティブ層が評価するセンサー入力。
 * Mineflayer の Bot オブジェクトから gameStateCollector が生成する。
 */
export interface BotSensors {
  hp: number;
  maxHp: number;
  hunger: number;
  oxygen: number;
  isOnFire: boolean;
  nearbyEntities: SensedEntity[];
  blockBelow: string | null;
  hasFood: boolean;
  foodItem: string | null;
  inventoryFull: boolean;
  isNight: boolean;
  baseKnown: boolean;
  baseDistance: number | null;
}

export interface SensedEntity {
  type: string;
  distance: number;
  direction: string;
  isHostile: boolean;
}

export type ReactivePriority = 'highest' | 'high' | 'medium';

export type ReactiveAction =
  | { type: 'flee'; from: string; reason: string; priority: 'highest' }
  | { type: 'eat'; item: string; reason: string; priority: 'highest' }
  | { type: 'stop_and_retreat'; reason: string; priority: 'highest' }
  | { type: 'avoid_hazard'; direction: string; reason: string; priority: 'highest' }
  | { type: 'fight'; target: string; reason: string; priority: 'high' }
  | { type: 'flee_from_attack'; attacker: string; reason: string; priority: 'high' }
  | { type: 'return_to_base'; reason: string; priority: 'high' }
  | { type: 'surface'; reason: string; priority: 'high' }
  | { type: 'discard_items'; reason: string; priority: 'medium' };

/**
 * LLM の steps をパースした結果のアクション種別。
 */
export type MappedActionType =
  | 'move_to_position'
  | 'move_to_block'
  | 'mine_block'
  | 'place_block'
  | 'craft_item'
  | 'smelt_item'
  | 'eat_food'
  | 'sleep'
  | 'attack_entity'
  | 'explore'
  | 'idle';

export interface MappedAction {
  type: MappedActionType;
  params: Record<string, unknown>;
  originalStep: string;
}
