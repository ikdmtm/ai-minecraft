import { attachClientReadiness } from './clientReadiness.js';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vec3 } from 'vec3';
import { executePrimitiveOperation, parseOperation, foodSpec, windowSnapshot, localGridSnapshot } from './primitiveOperations.js';
import { ExperienceMemory, bindProcedureStep } from './experienceMemory.js';
import { WorldMemory } from './worldMemory.js';
import { MinecraftKnowledge } from './minecraftKnowledge.js';
import { SkillExecutor } from './skillExecutor.js';
import { SharedStateBus } from '../cognitive/sharedState.js';
import { TaskExecutor } from './taskExecutor.js';
const registry = require('prismarine-registry')('1.21.4');

function fakeBot(): any {
  const bot: any = new EventEmitter();
  Object.assign(bot, {
    registry, version: '1.21.4', game: { dimension: 'overworld' }, food: 12, health: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0 }, entities: {},
    time: { timeOfDay: 1000 }, currentWindow: null, heldItem: null,
    inventory: { id: 0, type: 'minecraft:inventory', inventoryStart: 9, inventoryEnd: 45,
      slots: Array(46).fill(null), items() { return this.slots.filter(Boolean); } },
    findBlock: jest.fn(() => null), findBlocks: jest.fn(() => []), blockAt: jest.fn(() => null),
    canSeeBlock: jest.fn(() => true), canDigBlock: jest.fn(() => true),
    equip: jest.fn(async (i: any) => { bot.heldItem = i; }),
    transfer: jest.fn(async (args: any) => {
      const w = args.window, src = w.slots[args.sourceStart];
      w.slots[args.destStart] = { ...src, count: (w.slots[args.destStart]?.count ?? 0) + args.count };
      src.count -= args.count; if (!src.count) w.slots[args.sourceStart] = null;
    }),
    consume: jest.fn(async () => { bot.food += 4; }), activateItem: jest.fn(), deactivateItem: jest.fn(),
    setControlState: jest.fn(), closeWindow: jest.fn((w: any) => { if (bot.currentWindow === w) bot.currentWindow = null; }),
    pathfinder: { stop: jest.fn(), setMovements: jest.fn(), goto: jest.fn() },
  });
  return bot;
}
function stack(name: string, count = 1): any { return { name, type: registry.itemsByName[name].id, count, stackSize: 64, metadata: 0, nbt: null }; }
const ctx = { assertActive: () => {} };
function furnace(bot: any): any {
  bot.currentWindow = { id: 7, type: 'minecraft:furnace', inventoryStart: 3, inventoryEnd: 39, slots: Array(39).fill(null) };
  return bot.currentWindow;
}

describe('neutral primitive control adapter', () => {
  test('transfer accepts server-consumed fuel after confirmed source removal', async () => {
    const bot = fakeBot(), w = furnace(bot); w.slots[3] = stack('oak_planks', 2);
    bot.transfer.mockImplementation(async () => { w.slots[3].count--; w.slots[1] = null; });
    await expect(executePrimitiveOperation(bot, { action: 'TRANSFER', windowId: 7, sourceSlot: 3, destinationSlot: 1, count: 1 }, ctx)).resolves.toContain('completed');
  });
  test('a cancelled use does not deactivate the newer action', async () => {
    const bot = fakeBot(); bot.inventory.slots[9] = stack('stick'); let active = true;
    bot.activateItem.mockImplementation(() => { active = false; });
    await expect(executePrimitiveOperation(bot, { action: 'USE', item: 'stick', durationMs: 100 }, {
      assertActive: () => { if (!active) throw new Error('cancelled'); },
    })).rejects.toThrow('cancelled');
    expect(bot.deactivateItem).not.toHaveBeenCalled();
  });
  test('physical grid distinguishes loaded air from unobserved chunks', () => {
    const bot = fakeBot();
    bot.blockAt.mockImplementation((p: Vec3) => p.x < 0 ? null : ({ stateId: 0, name: 'air', boundingBox: 'empty', getProperties: () => ({}) }));
    const grid = localGridSnapshot(bot);
    expect(grid.cells).toHaveLength(125); expect(grid.cells).toContain(-1); expect(grid.cells).toContain(0);
    expect(grid.palette).toEqual([{ name: 'air', boundingBox: 'empty', properties: {} }]);
  });

  test('rejects unknown commands and executable code fields', () => {
    expect(() => parseOperation({ action: 'SHELL', command: 'anything' })).toThrow();
    expect(() => parseOperation({ action: 'MOVE', code: 'eval(x)' })).toThrow();
    expect(() => parseOperation({ action: 'MOVE', position: { x: NaN, y: 64, z: 0 } })).toThrow();
  });
  test('normalizes null optional arguments', () => expect(parseOperation({ action: 'WAIT', position: null })).toEqual({ action: 'WAIT' }));
  test('reads actual versioned food facts by name, not mismatched item IDs', () => {
    const bot = fakeBot();
    expect(registry.itemsByName.apple.foodPoints).toBeUndefined();
    expect(foodSpec(bot, 'apple').foodPoints).toBe(4);
    expect(foodSpec(bot, 'oak_planks')).toBeUndefined();
  });
  test('exposes authoritative furnace slot roles', () => {
    const bot = fakeBot(); furnace(bot);
    expect(windowSnapshot(bot).slots.slice(0, 3).map(s => s.role)).toEqual(['smelted', 'fuel', 'result']);
  });
  test('transfers exactly the requested item and count', async () => {
    const bot = fakeBot(), w = furnace(bot); w.slots[3] = stack('chicken', 4);
    await executePrimitiveOperation(bot, { action: 'TRANSFER', windowId: 7, sourceSlot: 3, destinationSlot: 0, item: 'chicken', count: 2 }, ctx);
    expect(w.slots[0].count).toBe(2); expect(w.slots[3].count).toBe(2);
  });
  test.each([
    [{ windowId: 6, sourceSlot: 3, destinationSlot: 0 }, 'stale_window'],
    [{ windowId: 7, sourceSlot: 3, destinationSlot: 2 }, 'read_only'],
    [{ windowId: 7, sourceSlot: 3, destinationSlot: 0, count: 8 }, 'count_insufficient'],
    [{ windowId: 7, sourceSlot: 3, destinationSlot: 3 }, 'invalid_slots'],
  ])('rejects unsafe/stale slot operation %j', async (params, reason) => {
    const bot = fakeBot(), w = furnace(bot); w.slots[3] = stack('chicken', 4);
    await expect(executePrimitiveOperation(bot, { action: 'TRANSFER', ...params }, ctx)).rejects.toThrow(reason);
    expect(bot.transfer).not.toHaveBeenCalled();
  });
  test('refuses to overwrite an incompatible destination', async () => {
    const bot = fakeBot(), w = furnace(bot); w.slots[3] = stack('chicken'); w.slots[0] = stack('iron_ore');
    await expect(executePrimitiveOperation(bot, { action: 'TRANSFER', windowId: 7, sourceSlot: 3, destinationSlot: 0 }, ctx)).rejects.toThrow('incompatible');
  });
  test('uses the agent-selected carried food', async () => {
    const bot = fakeBot(); bot.inventory.slots[9] = stack('apple');
    await executePrimitiveOperation(bot, { action: 'USE', item: 'apple' }, ctx);
    expect(bot.consume).toHaveBeenCalledTimes(1); expect(bot.heldItem.name).toBe('apple');
  });
  test('cancellation prevents execution', async () => {
    const bot = fakeBot(); bot.inventory.slots[9] = stack('apple');
    await expect(executePrimitiveOperation(bot, { action: 'USE', item: 'apple' }, { assertActive: () => { throw new Error('cancelled'); } })).rejects.toThrow('cancelled');
    expect(bot.equip).not.toHaveBeenCalled();
  });
  test('intentional waiting exits on a world event without another model call', async () => {
    const bot = fakeBot(); bot.time.timeOfDay = 13000;
    setTimeout(() => { bot.time.timeOfDay = 1000; }, 25);
    const result = await executePrimitiveOperation(bot, { action: 'WAIT', until: 'daylight', durationMs: 500 }, ctx);
    expect(result).toBe('condition_satisfied:daylight');
  });
  test('a timeout does not claim the condition occurred', async () => {
    const bot = fakeBot(); bot.time.timeOfDay = 13000;
    expect(await executePrimitiveOperation(bot, { action: 'WAIT', until: 'daylight', durationMs: 100 }, ctx)).toBe('condition_timeout:daylight');
  });
  test('OPEN keeps the window available to the following operation', async () => {
    const bot = fakeBot(); bot.blockAt.mockReturnValue({ name: 'furnace', position: new Vec3(1, 64, 0) });
    bot.openBlock = jest.fn(async () => furnace(bot));
    await executePrimitiveOperation(bot, { action: 'OPEN', position: { x: 1, y: 64, z: 0 } }, ctx);
    expect(bot.currentWindow.id).toBe(7); expect(bot.closeWindow).not.toHaveBeenCalled();
  });
  test('late window-open is closed after cancellation', async () => {
    const bot = fakeBot(); let active = true;
    bot.blockAt.mockReturnValue({ name: 'furnace', position: new Vec3(1, 64, 0) });
    bot.openBlock = jest.fn(async () => { active = false; return furnace(bot); });
    await expect(executePrimitiveOperation(bot, { action: 'OPEN', position: { x: 1, y: 64, z: 0 } }, {
      assertActive: () => { if (!active) throw new Error('cancelled'); },
    })).rejects.toThrow('cancelled');
    expect(bot.currentWindow).toBeNull();
  });
});

describe('evidence-derived reusable procedures', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'autonomy-')); });
  afterEach(() => rmSync(dir, { force: true, recursive: true }));
  function demonstration(mem: ExperienceMemory, overrides: any = {}) {
    const bot = fakeBot();
    const common = { worldId: 'old-world', version: '1.21.4', dimension: 'overworld', status: 'succeeded' as const,
      verified: true, detail: 'observed', effect: 'block placed', origin: { x: 100.5, y: 64, z: 100.5 }, window: windowSnapshot(bot), ...overrides };
    return [
      mem.append({ ...common, operation: { action: 'PLACE', item: 'stone', position: { x: 101, y: 64, z: 100 } } }),
      mem.append({ ...common, operation: { action: 'PLACE', item: 'stone', position: { x: 101, y: 65, z: 100 } } }),
    ];
  }
  test('movement through air retains a relative route instead of binding arbitrary nearby air', () => {
    const mem = new ExperienceMemory();
    const bot = fakeBot();
    const common = { worldId: 'route-world', version: '1.21.4', dimension: 'overworld', status: 'succeeded' as const,
      verified: true, detail: 'arrived', effect: 'moved', origin: { x: 100.5, y: 64, z: 100.5 }, window: windowSnapshot(bot), blockName: 'air' };
    const a = mem.append({ ...common, operation: { action: 'MOVE', position: { x: 101, y: 64, z: 100 } } });
    const b = mem.append({ ...common, operation: { action: 'LOOK', position: { x: 103, y: 65, z: 100 } } });
    const learned = mem.save('relative route', [a.id, b.id]);
    expect(learned.steps.every(step => step.binding?.kind === 'relative')).toBe(true);
    expect(bindProcedureStep(learned.steps[0], bot, new Vec3(500, 70, 500), new Map()).position).toEqual({ x: 501, y: 70, z: 500 });
    expect(bot.findBlock).not.toHaveBeenCalled(); mem.close();
  });
  test('persists across database reopen; never stores absolute target coordinates in learned steps', () => {
    const path = join(dir, 'memory.db'), mem = new ExperienceMemory(path);
    const trace = demonstration(mem); const learned = mem.save('My two-block wall', trace.map(t => t.id)); mem.close();
    const reopened = new ExperienceMemory(path), saved = reopened.get(learned.id)!;
    const op = bindProcedureStep(saved.steps[0], fakeBot(), new Vec3(700, 80, -300), new Map());
    expect(op.position).toEqual({ x: 701, y: 80, z: -300 });
    expect(saved.steps[0].operation.position).toBeUndefined();
    expect(saved.status).toBe('candidate'); expect(reopened.list('1.21.5')).toHaveLength(0); reopened.close();
  });
  test.each([{ verified: false }, { status: 'failed' }])('does not learn an unverified or failed trace %j', overrides => {
    const mem = new ExperienceMemory(); const trace = demonstration(mem, overrides);
    expect(() => mem.save('bad', trace.map(t => t.id))).toThrow('verified_evidence'); mem.close();
  });
  test('rejects invented, repeated and nonconsecutive evidence', () => {
    const mem = new ExperienceMemory(); const a = demonstration(mem), b = demonstration(mem);
    expect(() => mem.save('bad', ['not-real', a[0].id])).toThrow();
    expect(() => mem.save('bad', [a[0].id, a[0].id])).toThrow();
    expect(() => mem.save('bad', [a[0].id, b[0].id])).toThrow('contiguous'); mem.close();
  });
  test('deduplicates repeated save requests and downgrades a failed replay', () => {
    const mem = new ExperienceMemory(); const ids = demonstration(mem).map(t => t.id);
    const p = mem.save('wall', ids); expect(mem.save('renamed', ids).id).toBe(p.id);
    mem.recordReplay(p.id, true); mem.recordReplay(p.id, true); expect(mem.get(p.id)?.status).toBe('verified');
    mem.recordReplay(p.id, false); expect(mem.get(p.id)?.status).toBe('candidate');
    expect(mem.get(p.id)?.evidenceIds).toEqual(ids); mem.close();
  });
  test('rebinds inventory source slots and current window ID', () => {
    const bot = fakeBot(), w = furnace(bot); w.id = 18; w.slots[19] = stack('chicken', 3);
    const op = bindProcedureStep({ operation: { action: 'TRANSFER', item: 'chicken', count: 1, destinationSlot: 0 },
      sourceItem: 'chicken', windowType: 'minecraft:furnace' }, bot, new Vec3(0, 64, 0), new Map());
    expect(op.windowId).toBe(18); expect(op.sourceSlot).toBe(19);
    w.type = 'minecraft:chest'; expect(() => bindProcedureStep({ operation: { action: 'TRANSFER' }, windowType: 'minecraft:furnace' }, bot, new Vec3(0, 0, 0), new Map())).toThrow('window_precondition');
  });
  test('world identity separates spatial memory while experience remains available', () => {
    const path = join(dir, 'world.db'); const mem = new WorldMemory(path, 'A');
    mem.observe({ kind: 'placed_block', key: 'home', label: 'old home', position: { x: 50, y: 64, z: 70 }, retention: 'stable' });
    mem.recordProcedureOutcome({ key: 'try', label: 'observed outcome', success: false, detail: 'failure' });
    const id = mem.startNewWorld(); expect(id).not.toBe('A');
    expect(mem.recall({ includeGlobal: false })).toHaveLength(0);
    expect(mem.recall({ includeWorld: false })[0].metadata.failures).toBe(1); mem.close();
    const reopened = new WorldMemory(path); expect(reopened.getWorldId()).toBe(id);
    expect(reopened.recall({ includeGlobal: false })).toHaveLength(0);
    expect(reopened.recallHistory('A')[0].label).toBe('old home'); reopened.close();
  });
  test('failure counters do not become permanent perfect success after one win', () => {
    const mem = new WorldMemory();
    mem.recordProcedureOutcome({ key: 'try', label: 'try', success: true, detail: 'succeeded' });
    mem.recordProcedureOutcome({ key: 'try', label: 'try', success: false, detail: 'failed' });
    const record = mem.recall({ kind: 'procedure' })[0];
    expect(record.metadata.successRate).toBe(0.5); expect(record.metadata.attempts).toBe(2); mem.close();
  });
  test('knowledge lookup exposes versioned facts and rejects a mismatching recipe export', () => {
    const path = join(dir, 'knowledge.json'); writeFileSync(path, JSON.stringify({ version: '1.21.1', recipes: { chicken: {} } }));
    const result = new MinecraftKnowledge(fakeBot(), path).lookup('chicken');
    expect(result.processingRecipesAvailable).toBe(false);
    expect(JSON.stringify(result.facts)).toContain('foodPoints');
    writeFileSync(path, JSON.stringify({ version: '1.21.4', recipes: { 'minecraft:cooked_chicken': { type: 'minecraft:smelting', ingredient: 'minecraft:chicken' } } }));
    expect(new MinecraftKnowledge(fakeBot(), path).lookup('chicken').processingRecipesAvailable).toBe(true);
  });
});

describe('operation ownership and cancellation', () => {
  test('a succeeding safety skill cannot count as success of the replaced operation', async () => {
    const executor: any = new SkillExecutor(fakeBot(), new SharedStateBus());
    executor.dispatch = () => { executor.current = { id: 1, action: 'OPERATE', status: 'running', detail: '' }; };
    const running = executor.runAndWait({ action: 'OPERATE', operation: { action: 'WAIT' }, source: 'task', confidence: 1 }, null, 'normal', 1000);
    setTimeout(() => { executor.current = { id: 2, action: 'FLEE', status: 'succeeded', detail: 'completed' }; }, 20);
    expect((await running).status).toBe('interrupted');
  });
  test('stopping a task is terminal even when an awaited operation resolves later', async () => {
    const bot = fakeBot(), mem = new WorldMemory(), exp = new ExperienceMemory(), shared = new SharedStateBus();
    let complete: (x: any) => void = () => {};
    const primitive: any = { stop: jest.fn(), snapshot: () => ({}), runAndWait: () => new Promise(resolve => { complete = resolve; }) };
    const sensor: any = { capture: () => ({}) }, semantic: any = {};
    const executor = new TaskExecutor(bot, shared, primitive, sensor, semantic, mem, exp);
    const running = executor.execute({ task: 'EXECUTE_OPERATION', operation: { action: 'WAIT', durationMs: 100 }, source: 'openai', confidence: 1, basedOnRevision: 1 });
    executor.stop(); complete({ action: 'OPERATE', status: 'succeeded', detail: 'wait_elapsed' });
    expect((await running).status).toBe('interrupted'); expect(executor.snapshot().status).toBe('interrupted');
    expect(exp.recent()[0].status).toBe('interrupted'); mem.close(); exp.close();
  });
});


describe('1.21.4 client load handshake', () => {
  function clientBot(version = '1.21.4') {
    const bot: any = new EventEmitter(); bot._client = new EventEmitter(); bot._client.write = jest.fn();
    bot.version = version; bot.entity = { position: new Vec3(0.5, 64, 0.5) };
    bot.blockAt = jest.fn(() => null); attachClientReadiness(bot); return bot;
  }
  test('waits for announcement, real position and loaded column; sends only once', () => {
    const bot = clientBot(); bot._client.emit('login'); bot.emit('spawn');
    bot._client.emit('game_state_change', { reason: 13 }); bot.emit('forcedMove');
    expect(bot._client.write).not.toHaveBeenCalled();
    bot.blockAt.mockReturnValue({ name: 'air' }); bot.emit('chunkColumnLoad');
    bot.emit('forcedMove'); bot.emit('spawn'); bot.emit('chunkColumnLoad');
    expect(bot._client.write).toHaveBeenCalledTimes(1);
    expect(bot._client.write).toHaveBeenCalledWith('player_loaded', {});
    bot.emit('end'); expect(bot._client.listenerCount('game_state_change')).toBe(0);
  });
  test('resets readiness on a new level, without reusing previous location', () => {
    const bot = clientBot(); bot.blockAt.mockReturnValue({ name: 'air' });
    bot._client.emit('game_state_change', { reason: 13 }); bot.emit('forcedMove');
    bot._client.emit('respawn'); bot._client.emit('game_state_change', { reason: 13 });
    expect(bot._client.write).toHaveBeenCalledTimes(1); bot.emit('forcedMove');
    expect(bot._client.write).toHaveBeenCalledTimes(2); bot.emit('end');
  });
  test('does not send a version-specific packet to other versions', () => {
    const bot = clientBot('1.20.4'); bot.blockAt.mockReturnValue({ name: 'air' });
    bot._client.emit('game_state_change', { reason: 13 }); bot.emit('forcedMove');
    expect(bot._client.write).not.toHaveBeenCalled(); bot.emit('end');
  });
});
