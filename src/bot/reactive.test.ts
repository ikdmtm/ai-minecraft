import { evaluateReactiveRules } from './reactive';
import type { BotSensors, SensedEntity } from './types';

function baseSensors(overrides: Partial<BotSensors> = {}): BotSensors {
  return {
    hp: 20,
    maxHp: 20,
    hunger: 20,
    oxygen: 300,
    isOnFire: false,
    nearbyEntities: [],
    blockBelow: 'stone',
    hasFood: true,
    foodItem: 'bread',
    inventoryFull: false,
    isNight: false,
    baseKnown: false,
    baseDistance: null,
    ...overrides,
  };
}

function hostile(type: string, distance: number, direction = 'north'): SensedEntity {
  return { type, distance, direction, isHostile: true };
}

function passive(type: string, distance: number, direction = 'east'): SensedEntity {
  return { type, distance, direction, isHostile: false };
}

describe('Reactive Layer', () => {
  describe('Highest priority: Creeper proximity', () => {
    it('triggers flee when creeper is within 5 blocks', () => {
      const action = evaluateReactiveRules(baseSensors({
        nearbyEntities: [hostile('creeper', 4, 'north')],
      }));
      expect(action).not.toBeNull();
      expect(action!.type).toBe('flee');
      expect(action!.priority).toBe('highest');
    });

    it('does NOT trigger when creeper is beyond 5 blocks', () => {
      const action = evaluateReactiveRules(baseSensors({
        nearbyEntities: [hostile('creeper', 6, 'north')],
      }));
      expect(action?.type).not.toBe('flee');
    });

    it('flees from the direction of the creeper', () => {
      const action = evaluateReactiveRules(baseSensors({
        nearbyEntities: [hostile('creeper', 3, 'south')],
      }));
      expect(action!.type).toBe('flee');
      if (action!.type === 'flee') {
        expect(action!.from).toBe('south');
      }
    });
  });

  describe('Highest priority: Low HP', () => {
    it('triggers eat when HP <= 6 and has food', () => {
      const action = evaluateReactiveRules(baseSensors({
        hp: 6,
        hasFood: true,
        foodItem: 'bread',
      }));
      expect(action).not.toBeNull();
      expect(action!.type).toBe('eat');
      expect(action!.priority).toBe('highest');
    });

    it('triggers stop_and_retreat when HP <= 6 and no food', () => {
      const action = evaluateReactiveRules(baseSensors({
        hp: 4,
        hasFood: false,
        foodItem: null,
      }));
      expect(action).not.toBeNull();
      expect(action!.type).toBe('stop_and_retreat');
      expect(action!.priority).toBe('highest');
    });

    it('does NOT trigger at HP 7', () => {
      const action = evaluateReactiveRules(baseSensors({ hp: 7 }));
      expect(action).toBeNull();
    });
  });

  describe('Highest priority: Void detection', () => {
    it('triggers stop_and_retreat when no block below', () => {
      const action = evaluateReactiveRules(baseSensors({
        blockBelow: null,
      }));
      expect(action).not.toBeNull();
      expect(action!.type).toBe('stop_and_retreat');
      expect(action!.priority).toBe('highest');
    });
  });

  describe('Highest priority: Lava/fire', () => {
    it('triggers avoid_hazard when on fire', () => {
      const action = evaluateReactiveRules(baseSensors({
        isOnFire: true,
      }));
      expect(action).not.toBeNull();
      expect(action!.type).toBe('avoid_hazard');
      expect(action!.priority).toBe('highest');
    });

    it('triggers avoid_hazard when standing on lava', () => {
      const action = evaluateReactiveRules(baseSensors({
        blockBelow: 'lava',
      }));
      expect(action).not.toBeNull();
      expect(action!.type).toBe('avoid_hazard');
      expect(action!.priority).toBe('highest');
    });
  });

  describe('High priority: Night + base known', () => {
    it('triggers return_to_base when night and base is known', () => {
      const action = evaluateReactiveRules(baseSensors({
        isNight: true,
        baseKnown: true,
        baseDistance: 30,
      }));
      expect(action).not.toBeNull();
      expect(action!.type).toBe('return_to_base');
      expect(action!.priority).toBe('high');
    });

    it('does NOT trigger when night but base unknown', () => {
      const action = evaluateReactiveRules(baseSensors({
        isNight: true,
        baseKnown: false,
      }));
      expect(action).toBeNull();
    });

    it('does NOT trigger during day', () => {
      const action = evaluateReactiveRules(baseSensors({
        isNight: false,
        baseKnown: true,
        baseDistance: 30,
      }));
      expect(action).toBeNull();
    });
  });

  describe('High priority: Underwater oxygen', () => {
    it('triggers surface when oxygen is low (< 60)', () => {
      const action = evaluateReactiveRules(baseSensors({
        oxygen: 50,
      }));
      expect(action).not.toBeNull();
      expect(action!.type).toBe('surface');
      expect(action!.priority).toBe('high');
    });

    it('does NOT trigger at normal oxygen', () => {
      const action = evaluateReactiveRules(baseSensors({
        oxygen: 200,
      }));
      expect(action).toBeNull();
    });
  });

  describe('Medium priority: Inventory full', () => {
    it('triggers discard_items when inventory is full', () => {
      const action = evaluateReactiveRules(baseSensors({
        inventoryFull: true,
      }));
      expect(action).not.toBeNull();
      expect(action!.type).toBe('discard_items');
      expect(action!.priority).toBe('medium');
    });
  });

  describe('Priority ordering', () => {
    it('creeper takes priority over low HP', () => {
      const action = evaluateReactiveRules(baseSensors({
        hp: 4,
        hasFood: true,
        foodItem: 'bread',
        nearbyEntities: [hostile('creeper', 3, 'north')],
      }));
      expect(action!.type).toBe('flee');
    });

    it('low HP takes priority over night return', () => {
      const action = evaluateReactiveRules(baseSensors({
        hp: 5,
        hasFood: true,
        foodItem: 'bread',
        isNight: true,
        baseKnown: true,
        baseDistance: 50,
      }));
      expect(action!.type).toBe('eat');
    });

    it('void detection takes priority over everything except creeper', () => {
      const action = evaluateReactiveRules(baseSensors({
        blockBelow: null,
        isNight: true,
        baseKnown: true,
        baseDistance: 10,
        inventoryFull: true,
      }));
      expect(action!.type).toBe('stop_and_retreat');
    });
  });

  describe('No action needed', () => {
    it('returns null when everything is safe', () => {
      const action = evaluateReactiveRules(baseSensors());
      expect(action).toBeNull();
    });

    it('returns null with passive mobs nearby', () => {
      const action = evaluateReactiveRules(baseSensors({
        nearbyEntities: [passive('cow', 5), passive('sheep', 8)],
      }));
      expect(action).toBeNull();
    });
  });
});
