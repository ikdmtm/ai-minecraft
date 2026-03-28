import {
  classifyTimeOfDay,
  classifyWeather,
  categorizeEntity,
  summarizeInventory,
  classifyActionCategory,
} from './gameStateCollector';

describe('classifyTimeOfDay', () => {
  it('returns day for 1000', () => expect(classifyTimeOfDay(1000)).toBe('day'));
  it('returns day for 11000', () => expect(classifyTimeOfDay(11000)).toBe('day'));
  it('returns dusk for 12000', () => expect(classifyTimeOfDay(12000)).toBe('dusk'));
  it('returns night for 14000', () => expect(classifyTimeOfDay(14000)).toBe('night'));
  it('returns night for 18000', () => expect(classifyTimeOfDay(18000)).toBe('night'));
  it('returns dawn for 22500', () => expect(classifyTimeOfDay(22500)).toBe('dawn'));
  it('returns day for 23500', () => expect(classifyTimeOfDay(23500)).toBe('day'));
  it('returns day for 0', () => expect(classifyTimeOfDay(0)).toBe('day'));
});

describe('classifyWeather', () => {
  it('returns clear when not raining', () => {
    expect(classifyWeather(false, false)).toBe('clear');
  });
  it('returns rain when raining but no thunder', () => {
    expect(classifyWeather(true, false)).toBe('rain');
  });
  it('returns thunder when thundering', () => {
    expect(classifyWeather(true, true)).toBe('thunder');
  });
});

describe('categorizeEntity', () => {
  it('marks zombie as hostile', () => {
    expect(categorizeEntity('zombie')).toBe(true);
  });
  it('marks skeleton as hostile', () => {
    expect(categorizeEntity('skeleton')).toBe(true);
  });
  it('marks creeper as hostile', () => {
    expect(categorizeEntity('creeper')).toBe(true);
  });
  it('marks enderman as hostile', () => {
    expect(categorizeEntity('enderman')).toBe(true);
  });
  it('marks cow as not hostile', () => {
    expect(categorizeEntity('cow')).toBe(false);
  });
  it('marks pig as not hostile', () => {
    expect(categorizeEntity('pig')).toBe(false);
  });
  it('marks villager as not hostile', () => {
    expect(categorizeEntity('villager')).toBe(false);
  });
});

describe('summarizeInventory', () => {
  it('groups and counts items', () => {
    const items = [
      { name: 'cobblestone', count: 64 },
      { name: 'cobblestone', count: 32 },
      { name: 'iron_ingot', count: 3 },
    ];
    const summary = summarizeInventory(items);
    expect(summary).toContain('cobblestone x96');
    expect(summary).toContain('iron_ingot x3');
  });

  it('returns empty array for empty inventory', () => {
    expect(summarizeInventory([])).toEqual([]);
  });
});

describe('classifyActionCategory', () => {
  it('classifies mining actions', () => {
    expect(classifyActionCategory('mine_block')).toBe('mining');
  });
  it('classifies crafting actions', () => {
    expect(classifyActionCategory('craft_item')).toBe('crafting');
  });
  it('classifies movement actions', () => {
    expect(classifyActionCategory('move_to_position')).toBe('moving');
  });
  it('classifies exploration actions', () => {
    expect(classifyActionCategory('explore')).toBe('exploring');
  });
  it('classifies combat actions', () => {
    expect(classifyActionCategory('attack_entity')).toBe('combat');
  });
  it('classifies eating as farming', () => {
    expect(classifyActionCategory('eat_food')).toBe('farming');
  });
  it('classifies idle as waiting', () => {
    expect(classifyActionCategory('idle')).toBe('waiting');
  });
  it('classifies sleep as waiting', () => {
    expect(classifyActionCategory('sleep')).toBe('waiting');
  });
});
