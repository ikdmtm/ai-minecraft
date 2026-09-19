import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { ExperienceMemory, bindProcedureStep, completeProcedureStepBinding, procedureEnvironmentMatches, type ProcedureStep } from './experienceMemory.js';
import { WorldMemory } from './worldMemory.js';
import { TaskExecutor } from './taskExecutor.js';
import { SharedStateBus } from '../cognitive/sharedState.js';
import { windowSnapshot, type PrimitiveOperation } from './primitiveOperations.js';

const registry = require('prismarine-registry')('1.21.4');
const stack = (name: string, count = 1, metadata = 0, nbt?: unknown): any => ({
  name, count, type: registry.itemsByName[name].id, metadata, nbt, stackSize: 64,
});
function fakeBot(): any {
  const blocks = new Map<string, any>();
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.21.4', game: { dimension: 'overworld' }, food: 20, health: 20,
    entity: { id: 0, position: new Vec3(100.5, 64, 100.5), yaw: 0, pitch: 0 }, entities: {},
    time: { timeOfDay: 1000, day: 0 }, isSleeping: false, currentWindow: null, heldItem: null,
    inventory: { id: 0, type: 'minecraft:inventory', inventoryStart: 9, inventoryEnd: 45,
      slots: Array(46).fill(null), items() { return this.slots.filter(Boolean); } },
    blocks,
    blockAt: jest.fn((p: Vec3) => blocks.get(p.floored().toString()) ?? { name: 'air', stateId: 0, position: p.floored() }),
    findBlocks: jest.fn((options: any) => [...blocks.values()].filter(b => options.matching(b)).map(b => b.position)),
    canSeeBlock: jest.fn((block: any) => { if (!block.position) throw new Error('visibility_requires_concrete_block'); return true; }),
  });
  return bot;
}
function block(bot: any, name: string, p: Vec3) {
  const result = { name, stateId: registry.blocksByName[name]?.minStateId ?? 1, position: p.clone() };
  bot.blocks.set(p.floored().toString(), result); return result;
}
function furnace(bot: any, id = 8, sourceSlot = 18): any {
  const win = { id, type: 'minecraft:furnace', inventoryStart: 3, inventoryEnd: 39, slots: Array(39).fill(null) };
  win.slots[sourceSlot] = stack('chicken', 4); bot.currentWindow = win; return win;
}
function pig(bot: any, id: number, distance: number, uuid: string | undefined = `pig-${id}`): any {
  return bot.entities[id] = { id, name: 'pig', uuid, position: bot.entity.position.offset(distance, 0, 0), metadata: [] };
}
const at = new Vec3(0, 64, 0);
const entityStep = (ref = 'entity:0'): ProcedureStep => ({ operation: { action: 'ATTACK' }, binding: { kind: 'entity', name: 'pig', ref } });
const blockStep = (ref = 'block:0'): ProcedureStep => ({ operation: { action: 'OPEN' }, binding: { kind: 'block', name: 'furnace', ref } });
const transferStep = (): ProcedureStep => ({ operation: { action: 'TRANSFER', item: 'chicken', count: 2, destinationSlot: 0 },
  windowType: 'minecraft:furnace', sourceItem: 'chicken', windowBinding: { ref: 'window:0', type: 'minecraft:furnace', open: true } });

describe('T05b procedure rebinding (real executor/memory; controlled physical outcomes)', () => {
  let directory: string;
  const closables: Array<{ close(): void }> = [];
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'procedure-rebinding-')); jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { for (const c of closables.splice(0)) c.close(); jest.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
  function memories(world = 'source-world', path = join(directory, 'memory.sqlite')) {
    const memory = new WorldMemory(path, world), experience = new ExperienceMemory(path);
    closables.push(memory, experience); return { memory, experience, path };
  }
  function fixture(bot: any, memory: WorldMemory, experience: ExperienceMemory, implementation: (op: PrimitiveOperation) => Promise<unknown>) {
    const primitive: any = { snapshot: () => ({}), stop: jest.fn(), runAndWait: jest.fn((d: any) => implementation(d.operation)) };
    const task = new TaskExecutor(bot, new SharedStateBus(), primitive, { capture: () => ({}) } as any, {} as any, memory, experience);
    const run = (operation: PrimitiveOperation) => task.execute({ task: 'EXECUTE_OPERATION', operation, source: 'openai', confidence: 1, basedOnRevision: 1 });
    const replay = (procedureId: string) => task.execute({ task: 'RUN_PROCEDURE', procedureId, source: 'openai', confidence: 1, basedOnRevision: 1 });
    return { primitive, task, run, replay };
  }
  function trace(exp: ExperienceMemory, bot: any, op: PrimitiveOperation, extra: any = {}) {
    return exp.append({ worldId: 'source-world', version: '1.21.4', dimension: 'overworld',
      status: 'succeeded', verified: true, detail: 'fixture evidence', effect: 'fixture effect',
      origin: { ...bot.entity.position }, window: windowSnapshot(bot), operation: op, ...extra });
  }

  test('actual executor evidence saves then replays after DB reopen in another world with new positions and window/slot IDs', async () => {
    const first = memories(), source = fakeBot();
    const implementation = (bot: any, id: number, slot: number) => async (op: PrimitiveOperation) => {
      if (op.action === 'PLACE') block(bot, op.item!, new Vec3(op.position!.x, op.position!.y, op.position!.z));
      if (op.action === 'OPEN') furnace(bot, id, slot);
      if (op.action === 'TRANSFER') {
        const win = bot.currentWindow, item = win.slots[op.sourceSlot!];
        win.slots[op.destinationSlot!] = { ...item, count: op.count ?? 1 };
        item.count -= op.count ?? 1;
      }
      if (op.action === 'CLOSE') bot.currentWindow = null;
      return { action: 'OPERATE', status: 'succeeded', detail: `operation_completed:${op.action}` };
    };
    const a = fixture(source, first.memory, first.experience, implementation(source, 7, 14));
    const p = { x: 101, y: 64, z: 100 };
    for (const op of [
      { action: 'PLACE', item: 'furnace', position: p }, { action: 'OPEN', position: p },
      { action: 'TRANSFER', windowId: 7, sourceSlot: 14, destinationSlot: 0, item: 'chicken', count: 1 },
      { action: 'CLOSE', windowId: 7 },
    ] as PrimitiveOperation[]) expect((await a.run(op)).status).toBe('succeeded');
    const evidence = first.experience.recent(), before = JSON.stringify(evidence);
    expect(evidence.every(e => e.verified)).toBe(true);
    const saved = first.experience.save('tested fixture operations', evidence.map(e => e.id));
    expect(saved.steps.every(s => s.operation.position == null && s.operation.entityId == null && s.operation.windowId == null)).toBe(true);
    expect(saved.steps[0].binding?.ref).toBe(saved.steps[1].binding?.ref);
    first.memory.close(); first.experience.close();
    const second = memories('new-world-same-seed', first.path), destination = fakeBot();
    destination.entity.position = new Vec3(-199.5, 80, 300.5);
    block(destination, 'furnace', new Vec3(-200, 80, 300)); // nearer distractor; must not replace the placed target
    const b = fixture(destination, second.memory, second.experience, implementation(destination, 31, 29));
    expect((await b.replay(saved.id)).status).toBe('succeeded');
    const ops = b.primitive.runAndWait.mock.calls.map((args: any[]) => args[0].operation);
    expect(ops[0].position).toEqual({ x: -199, y: 80, z: 300 });
    expect(ops[1].position).toEqual(ops[0].position);
    expect(ops[2]).toMatchObject({ windowId: 31, sourceSlot: 29, destinationSlot: 0, item: 'chicken' });
    expect(ops[3]).toMatchObject({ windowId: 31 });
    expect(JSON.stringify(second.experience.evidence(saved.evidenceIds))).toBe(before);
    expect(second.experience.get(saved.id)).toMatchObject({ successes: 1, failures: 0, status: 'candidate' });
    expect(second.experience.recent().slice(-4).every(e => e.worldId === 'new-world-same-seed' && e.verified)).toBe(true);
    expect(second.memory.recall({ dimension: 'overworld', includeGlobal: false })[0].position).toEqual(ops[0].position);
    expect(second.memory.recallHistory('source-world')[0].position).toEqual(p);
  });

  test('distinct demonstrated pigs remain distinct, repeated strikes stay bound despite nearest-target changes', () => {
    const { experience } = memories(), source = fakeBot();
    const ids = [9901, 9902, 9901].map(entityId => trace(experience, source, { action: 'ATTACK', entityId }, { entityName: 'pig' }).id);
    const saved = experience.save('two distinct targets', ids), bot = fakeBot(), bindings = new Map<string, number>();
    pig(bot, 51, 1); pig(bot, 52, 2);
    expect(bindProcedureStep(saved.steps[0], bot, at, bindings).entityId).toBe(51);
    expect(bindProcedureStep(saved.steps[1], bot, at, bindings).entityId).toBe(52);
    bot.entities[52].position = bot.entity.position.offset(0.1, 0, 0);
    expect(bindProcedureStep(saved.steps[2], bot, at, bindings).entityId).toBe(51);
    expect(JSON.stringify(saved.steps)).not.toMatch(/9901|9902/);
    const other = fakeBot(); pig(other, 73, 1);
    expect(bindProcedureStep(saved.steps[0], other, at, new Map()).entityId).toBe(73);
  });
  test.each(['deleted', 'uuid', 'name', 'object_without_uuid'])('does not retarget when bound entity is %s', mode => {
    const bot = fakeBot(), bindings = new Map<string, number>();
    const original = pig(bot, 1, 1); if (mode === 'object_without_uuid') delete original.uuid;
    pig(bot, 2, 2); bindProcedureStep(entityStep(), bot, at, bindings);
    if (mode === 'deleted') delete bot.entities[1];
    if (mode === 'uuid') bot.entities[1] = { ...original, uuid: 'replacement' };
    if (mode === 'name') bot.entities[1] = { ...original, name: 'cow' };
    if (mode === 'object_without_uuid') bot.entities[1] = { ...original };
    expect(() => bindProcedureStep(entityStep(), bot, at, bindings)).toThrow('bound_entity_disappeared_or_replaced');
  });
  test('out-of-range or missing entity is not a usable binding', () => {
    const bot = fakeBot(); pig(bot, 1, 100);
    expect(() => bindProcedureStep(entityStep(), bot, at, new Map())).toThrow('entity_precondition_missing');
  });
  test('block scan performs visibility only on concrete candidates and keeps a repeated target pinned', () => {
    const bot = fakeBot(), bindings = new Map<string, number>();
    const p = new Vec3(101, 64, 100); block(bot, 'furnace', p); block(bot, 'furnace', new Vec3(104, 64, 100));
    bot.findBlocks.mockImplementation((options: any) => {
      expect(options.matching({ name: 'furnace' })).toBe(true);
      return [...bot.blocks.values()].map((b: any) => b.position);
    });
    expect(bindProcedureStep(blockStep(), bot, at, bindings).position).toEqual({ ...p });
    bot.entity.position = new Vec3(104.5, 64, 100.5);
    expect(bindProcedureStep(blockStep(), bot, at, bindings).position).toEqual({ ...p });
    expect(bindProcedureStep(blockStep('block:1'), bot, at, bindings).position).toEqual({ x: 104, y: 64, z: 100 });
  });
  test.each(['unloaded', 'replaced', 'occluded'])('a bound block that becomes %s is not silently replaced', mode => {
    const bot = fakeBot(), bindings = new Map<string, number>(), p = new Vec3(101, 64, 100);
    block(bot, 'furnace', p); block(bot, 'furnace', new Vec3(102, 64, 100));
    bindProcedureStep(blockStep(), bot, at, bindings);
    if (mode === 'unloaded') bot.blockAt.mockReturnValue(null);
    if (mode === 'replaced') block(bot, 'chest', p);
    if (mode === 'occluded') bot.canSeeBlock.mockReturnValue(false);
    expect(() => bindProcedureStep(blockStep(), bot, at, bindings)).toThrow('bound_block_changed_or_unseen');
  });
  test('relative MOVE/LOOK retains the original anchor, not an accumulating offset', () => {
    const { experience } = memories(), bot = fakeBot(); bot.entity.position = new Vec3(-100.2, 64, 100.8);
    const a = trace(experience, bot, { action: 'MOVE', position: { x: -99, y: 64, z: 100 } });
    bot.entity.position = new Vec3(-98.5, 64, 100.5);
    const b = trace(experience, bot, { action: 'LOOK', position: { x: -98.5, y: 65, z: 101.5 } });
    const saved = experience.save('relative route', [a.id, b.id]), bindings = new Map<string, number>();
    const anchor = new Vec3(200, 80, -300);
    expect(bindProcedureStep(saved.steps[0], bot, anchor, bindings).position).toEqual({ x: 202, y: 80, z: -300 });
    expect(bindProcedureStep(saved.steps[1], bot, anchor, bindings).position).toEqual({ x: 202.5, y: 81, z: -298.5 });
  });
  test('a same-name block cannot stand in for two distinct demonstrated blocks', () => {
    const bot = fakeBot(), bindings = new Map<string, number>(); block(bot, 'furnace', new Vec3(101, 64, 100));
    bindProcedureStep(blockStep(), bot, at, bindings);
    expect(() => bindProcedureStep(blockStep('block:1'), bot, at, bindings)).toThrow('block_precondition_missing');
  });
  test('window object is pinned immediately after verified OPEN, not just numeric ID/type', () => {
    const bot = fakeBot(), bindings = new Map<string, number>(); furnace(bot, 12);
    completeProcedureStepBinding({ operation: { action: 'OPEN' }, opensWindowRef: 'window:0' }, bot, bindings);
    furnace(bot, 12);
    expect(() => bindProcedureStep(transferStep(), bot, at, bindings)).toThrow('bound_window_replaced');
  });
  test.each(['closed', 'different_type', 'cursor'])('changed window precondition %s rejects transfer', mode => {
    const bot = fakeBot(), win = furnace(bot);
    if (mode === 'closed') bot.currentWindow = null;
    if (mode === 'different_type') win.type = 'minecraft:chest';
    if (mode === 'cursor') win.selectedItem = stack('stone');
    expect(() => bindProcedureStep(transferStep(), bot, at, new Map())).toThrow(mode === 'cursor' ? 'cursor_not_empty' : 'window_precondition_changed');
  });
  test('source inventory slot is rebound by item and count, not a saved slot index', () => {
    const bot = fakeBot(), win = furnace(bot, 21, 30);
    win.slots[5] = stack('chicken', 1); win.slots[8] = stack('stone', 8);
    expect(bindProcedureStep(transferStep(), bot, at, new Map())).toMatchObject({ windowId: 21, sourceSlot: 30, destinationSlot: 0, count: 2 });
  });
  test('container source is identified from evidence even if the demonstrated TRANSFER omitted item', () => {
    const { experience } = memories(), bot = fakeBot(), win = furnace(bot); win.slots[2] = stack('cooked_chicken', 2);
    const a = trace(experience, bot, { action: 'TRANSFER', windowId: win.id, sourceSlot: 2, destinationSlot: 10, count: 1 });
    const b = trace(experience, bot, { action: 'CLOSE', windowId: win.id });
    const saved = experience.save('output retrieval', [a.id, b.id]);
    expect(saved.steps[0].operation.item).toBe('cooked_chicken');
    win.slots[2] = stack('iron_ingot');
    expect(() => bindProcedureStep(saved.steps[0], bot, at, new Map())).toThrow('source_item_or_count_changed');
  });
  test.each(['missing', 'count'])('missing or insufficient inventory source: %s', mode => {
    const bot = fakeBot(), win = furnace(bot); win.slots[18] = mode === 'missing' ? null : stack('chicken', 1);
    expect(() => bindProcedureStep(transferStep(), bot, at, new Map())).toThrow('inventory_item_missing');
  });
  test('destination rebinding respects metadata, NBT, capacity and the inventory zone', () => {
    const bot = fakeBot(), win = furnace(bot); win.slots[0] = stack('stone', 4, 1, { a: 1 });
    for (let i = win.inventoryStart; i < win.inventoryEnd; i++) win.slots[i] = stack('stone', 64, 1, { a: 1 });
    win.slots[3] = stack('stone', 1, 0, { a: 1 });
    win.slots[4] = stack('stone', 1, 1, { a: 2 });
    win.slots[5] = stack('stone', 62, 1, { a: 1 });
    const step: ProcedureStep = { operation: { action: 'TRANSFER', sourceSlot: 0, item: 'stone', count: 2 },
      windowType: 'minecraft:furnace', destinationInventory: true };
    expect(bindProcedureStep(step, bot, at, new Map()).destinationSlot).toBe(5);
    win.slots[5].count = 63;
    expect(() => bindProcedureStep(step, bot, at, new Map())).toThrow('inventory_full');
  });
  test.each(['full', 'incompatible'])('fixed destination %s is refused before an operation', mode => {
    const bot = fakeBot(), win = furnace(bot);
    win.slots[0] = mode === 'full' ? stack('chicken', 64) : stack('stone');
    expect(() => bindProcedureStep(transferStep(), bot, at, new Map())).toThrow('destination_incompatible_or_full');
  });
  test('CLOSE requires the demonstrated window context and leaves replacement UIs alone', () => {
    const bot = fakeBot(), bindings = new Map<string, number>(); furnace(bot, 22);
    const step: ProcedureStep = { operation: { action: 'CLOSE' }, windowBinding: { ref: 'window:0', type: 'minecraft:furnace', open: true } };
    expect(bindProcedureStep(step, bot, at, bindings).windowId).toBe(22);
    furnace(bot, 22); expect(() => bindProcedureStep(step, bot, at, bindings)).toThrow('bound_window_replaced');
    expect(() => bindProcedureStep({ operation: { action: 'CLOSE' } }, bot, at, new Map())).toThrow('close_window_evidence_missing');
    expect(bot.currentWindow.id).toBe(22);
  });
  test.each([
    ['1.21.4', 'minecraft:overworld', true], ['1.21.4', 'the_nether', false],
    ['1.21.5', 'overworld', false], ['1.21.4', 'unknown', false],
  ])('environment %s/%s compatible=%s', (version, dimension, expected) => {
    expect(procedureEnvironmentMatches({ version: '1.21.4', dimension: 'overworld' }, version, dimension)).toBe(expected);
  });
  test('compatible listing filters before 64-row display limit and normalizes dimension aliases', () => {
    const { experience } = memories(), bot = fakeBot();
    const pair = (version: string, dimension: string) => [0, 1].map(() => trace(experience, bot, { action: 'WAIT', durationMs: 100 }, { version, dimension }).id);
    const old = experience.save('older compatible', pair('1.21.4', 'overworld'));
    for (let i = 0; i < 65; i++) experience.save(`other ${i}`, pair('1.21.5', 'the_nether'));
    expect(experience.list('1.21.4', 'minecraft:overworld').map(p => p.id)).toEqual([old.id]);
    expect(experience.list('1.21.4', 'unknown')).toEqual([]);
    expect(experience.get(old.id)?.status).toBe('candidate');
  });
  test('incompatible RUN rejects before physical execution without adding a replay failure', async () => {
    const { memory, experience } = memories(), bot = fakeBot();
    const saved = experience.save('other version', [0, 1].map(() => trace(experience, bot, { action: 'WAIT', durationMs: 100 }, { version: '1.21.5' }).id));
    const f = fixture(bot, memory, experience, async () => { throw new Error('must not execute'); });
    expect(await f.replay(saved.id)).toEqual({ status: 'failed', detail: 'procedure_environment_mismatch' });
    expect(f.primitive.runAndWait).not.toHaveBeenCalled(); expect(experience.get(saved.id)?.failures).toBe(0);
  });
  test('missing live binding interrupts without the next step or a negative replay lesson', async () => {
    const { memory, experience } = memories(), bot = fakeBot();
    const saved = experience.save('needs pig', [0, 1].map(() => trace(experience, bot, { action: 'ATTACK', entityId: 9901 }, { entityName: 'pig' }).id));
    const f = fixture(bot, memory, experience, async () => { throw new Error('must not execute'); });
    expect((await f.replay(saved.id)).status).toBe('interrupted');
    expect(f.primitive.runAndWait).not.toHaveBeenCalled(); expect(experience.get(saved.id)).toMatchObject({ successes: 0, failures: 0 });
  });
  test('a genuine adapter failure still stops replay and counts once', async () => {
    const { memory, experience } = memories(), bot = fakeBot(); pig(bot, 1, 1);
    const saved = experience.save('attempt', [0, 1].map(() => trace(experience, bot, { action: 'ATTACK', entityId: 9901 }, { entityName: 'pig' }).id));
    const f = fixture(bot, memory, experience, async () => ({ action: 'OPERATE', status: 'failed', detail: 'fixture_adapter_failure' }));
    expect((await f.replay(saved.id)).status).toBe('failed');
    expect(f.primitive.runAndWait).toHaveBeenCalledTimes(1); expect(experience.get(saved.id)?.failures).toBe(1);
  });
});
