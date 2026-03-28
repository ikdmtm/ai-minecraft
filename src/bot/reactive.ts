import type { BotSensors, ReactiveAction } from './types.js';

const CREEPER_FLEE_DISTANCE = 5;
const LOW_HP_THRESHOLD = 6;
const LOW_OXYGEN_THRESHOLD = 60;
const HAZARD_BLOCKS = new Set(['lava', 'flowing_lava', 'fire', 'soul_fire']);

/**
 * リアクティブ層: センサー入力からルールベースで即時行動を決定する。
 * 優先度順に評価し、最初にマッチしたルールの行動を返す。
 * どのルールにもマッチしない場合は null を返す（戦略層に委ねる）。
 */
export function evaluateReactiveRules(sensors: BotSensors): ReactiveAction | null {
  return (
    checkCreeperProximity(sensors) ??
    checkVoidOrHazard(sensors) ??
    checkLowHp(sensors) ??
    checkOxygen(sensors) ??
    checkNightReturn(sensors) ??
    checkInventoryFull(sensors)
  );
}

function checkCreeperProximity(s: BotSensors): ReactiveAction | null {
  const creeper = s.nearbyEntities.find(
    (e) => e.type === 'creeper' && e.distance < CREEPER_FLEE_DISTANCE,
  );
  if (!creeper) return null;
  return {
    type: 'flee',
    from: creeper.direction,
    reason: `クリーパーが${creeper.distance.toFixed(1)}ブロック先に接近`,
    priority: 'highest',
  };
}

function checkVoidOrHazard(s: BotSensors): ReactiveAction | null {
  if (s.blockBelow === null) {
    return {
      type: 'stop_and_retreat',
      reason: '足元に空洞を検知',
      priority: 'highest',
    };
  }
  if (HAZARD_BLOCKS.has(s.blockBelow)) {
    return {
      type: 'avoid_hazard',
      direction: 'away',
      reason: `足元が${s.blockBelow}`,
      priority: 'highest',
    };
  }
  if (s.isOnFire) {
    return {
      type: 'avoid_hazard',
      direction: 'water',
      reason: '燃焼中',
      priority: 'highest',
    };
  }
  return null;
}

function checkLowHp(s: BotSensors): ReactiveAction | null {
  if (s.hp > LOW_HP_THRESHOLD) return null;
  if (s.hasFood && s.foodItem) {
    return {
      type: 'eat',
      item: s.foodItem,
      reason: `HP が ${s.hp}/${s.maxHp} まで低下`,
      priority: 'highest',
    };
  }
  return {
    type: 'stop_and_retreat',
    reason: `HP が ${s.hp}/${s.maxHp} で食料なし。退避`,
    priority: 'highest',
  };
}

function checkOxygen(s: BotSensors): ReactiveAction | null {
  if (s.oxygen >= LOW_OXYGEN_THRESHOLD) return null;
  return {
    type: 'surface',
    reason: `酸素残量 ${s.oxygen}/300`,
    priority: 'high',
  };
}

function checkNightReturn(s: BotSensors): ReactiveAction | null {
  if (!s.isNight || !s.baseKnown) return null;
  return {
    type: 'return_to_base',
    reason: '夜になった。拠点に帰還',
    priority: 'high',
  };
}

function checkInventoryFull(s: BotSensors): ReactiveAction | null {
  if (!s.inventoryFull) return null;
  return {
    type: 'discard_items',
    reason: 'インベントリが満杯',
    priority: 'medium',
  };
}
