import { didBlockBreak, isFoodItemName, resolveGoalBehavior, shouldForceCraftBootstrap } from './reflexLayer';

describe('resolveGoalBehavior', () => {
  it('prioritizes food gathering over mining keywords in mixed goals', () => {
    expect(resolveGoalBehavior('食料を探しつつ木と石を集める')).toBe('gather_food');
  });

  it('prioritizes crafting when the goal mentions a crafting table or tools', () => {
    expect(resolveGoalBehavior('木を伐採して作業台を作り、石ツール一式を揃える')).toBe('craft');
    expect(resolveGoalBehavior('木製ツールを完成させて石採掘に移行する')).toBe('craft');
  });

  it('falls back to mining when the goal is purely about wood gathering', () => {
    expect(resolveGoalBehavior('木を伐採する')).toBe('mine_logs');
  });
});

describe('didBlockBreak', () => {
  it('treats the dig as failed when the same block remains after digging', () => {
    expect(didBlockBreak('oak_log', 'oak_log')).toBe(false);
  });

  it('treats the dig as successful when the block changes or disappears', () => {
    expect(didBlockBreak('oak_log', 'air')).toBe(true);
    expect(didBlockBreak('oak_log', null)).toBe(true);
  });
});

describe('isFoodItemName', () => {
  it('recognizes raw meat as edible food', () => {
    expect(isFoodItemName('beef')).toBe(true);
    expect(isFoodItemName('chicken')).toBe(true);
    expect(isFoodItemName('salmon')).toBe(true);
  });
});

describe('shouldForceCraftBootstrap', () => {
  it('prioritizes crafting when basic materials exist but no pickaxe is available yet', () => {
    expect(shouldForceCraftBootstrap([
      { name: 'oak_log', count: 3 },
      { name: 'crafting_table', count: 1 },
    ], false)).toBe(true);
  });

  it('prioritizes crafting at a nearby table when sticks and cobblestone are available', () => {
    expect(shouldForceCraftBootstrap([
      { name: 'stick', count: 4 },
      { name: 'cobblestone', count: 12 },
    ], true)).toBe(true);
  });

  it('does not force crafting when no crafting progress is possible', () => {
    expect(shouldForceCraftBootstrap([
      { name: 'dirt', count: 16 },
    ], false)).toBe(false);
  });

  it('does not force bootstrap crafting after a pickaxe is already available', () => {
    expect(shouldForceCraftBootstrap([
      { name: 'stone_pickaxe', count: 1 },
      { name: 'oak_log', count: 3 },
    ], false)).toBe(false);
  });
});
