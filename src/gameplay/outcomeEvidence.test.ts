import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { WorldMemory } from './worldMemory.js';
import { ExperienceMemory } from './experienceMemory.js';
import { SemanticWorldModel } from './semanticWorldModel.js';
import { TaskExecutor } from './taskExecutor.js';
import { SharedStateBus } from '../cognitive/sharedState.js';
import { windowSnapshot, type PrimitiveOperation } from './primitiveOperations.js';

const registry = require('prismarine-registry')('1.21.4');
function stack(name: string, count = 1): any {
  return { name, count, type: registry.itemsByName[name].id, stackSize: 64, metadata: 0, nbt: null };
}
function fakeBot(): any {
  return Object.assign(new EventEmitter(), {
    registry, version: '1.21.4', game: { dimension: 'overworld' }, food: 12, health: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0 }, entities: {},
    time: { timeOfDay: 1000, day: 0 }, isRaining: false, currentWindow: null, heldItem: null,
    inventory: { id: 0, type: 'minecraft:inventory', inventoryStart: 9, inventoryEnd: 45,
      slots: Array(46).fill(null), items() { return this.slots.filter(Boolean); } },
    findBlock: jest.fn(() => null), findBlocks: jest.fn(() => []), blockAt: jest.fn(() => null),
    canSeeBlock: jest.fn(() => true), recipesFor: jest.fn(() => []), recipesAll: jest.fn(() => []),
  });
}

describe('T04c outcome evidence (real temporary SQLite, controlled physical results)', () => {
  let directory: string;
  const closables: Array<{ close(): void }> = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'outcome-evidence-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const c of closables.splice(0)) c.close();
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  function fixture() {
    const path = join(directory, 'memory.sqlite');
    const mem = new WorldMemory(path, 'fixture-world'), exp = new ExperienceMemory(path);
    closables.push(mem, exp);
    const bot = fakeBot(), shared = new SharedStateBus();
    const semantic = new SemanticWorldModel(bot, shared, undefined, mem, exp);
    const primitive: any = { snapshot: () => ({}), stop: jest.fn(), runAndWait: jest.fn() };
    const task = new TaskExecutor(bot, shared, primitive, { capture: () => ({}) } as any, semantic, mem, exp);
    async function run(op: PrimitiveOperation, change: () => void = () => {}, result: Record<string, unknown> = {}) {
      primitive.runAndWait.mockImplementation(async () => {
        change(); return { action: 'OPERATE', status: 'succeeded', detail: `operation_completed:${op.action}`, ...result };
      });
      const completed = await task.execute({ task: 'EXECUTE_OPERATION', operation: op,
        source: 'openai', confidence: 1, basedOnRevision: 1 });
      const evidence = exp.recent(64).at(-1)!;
      return { completed, evidence, effect: JSON.parse(evidence.effect) };
    }
    const statistics = () => mem.recall({ includeWorld: false });
    return { bot, mem, exp, semantic, task, primitive, run, path, statistics };
  }
  function pig(bot: any, id = 21) {
    return bot.entities[id] = { id, uuid: `fixture-${id}`, name: 'pig', type: 'mob',
      metadata: [false], position: new Vec3(3, 64, 0) };
  }
  const target = { x: 3, y: 64, z: 0 };

  test('completed but unconfirmed action retains evidence without a negative lesson', async () => {
    const f = fixture();
    const r = await f.run({ action: 'EQUIP', item: 'stick' });
    expect(r.completed.status).toBe('succeeded'); // adapter completion, not verified achievement
    expect(r.evidence.verified).toBe(false);
    expect(r.effect.outcome).toBe('effect_unconfirmed');
    expect(f.statistics()).toEqual([]);
    f.exp.close(); const reopened = new ExperienceMemory(f.path); closables.push(reopened);
    expect(reopened.evidence([r.evidence.id])[0]).toEqual(r.evidence);
  });
  test('an explicit adapter failure is still recorded as failure', async () => {
    const f = fixture();
    const r = await f.run({ action: 'EQUIP', item: 'stick' }, () => {}, { status: 'failed', detail: 'operation_item_missing:stick' });
    expect(r.completed.status).toBe('failed'); expect(r.effect.outcome).toBe('failed');
    expect(f.statistics()[0].metadata).toMatchObject({ failures: 1, successes: 0, evidenceId: r.evidence.id });
  });
  test.each(['safety', 'stop', 'world'])('%s interruption is not a failed operation', async kind => {
    const f = fixture();
    const r = await f.run({ action: 'PLACE', item: 'stone', position: target }, () => {
      if (kind === 'stop') f.task.stop();
      if (kind === 'world') f.mem.setWorldId('new-world');
    }, kind === 'safety' ? { status: 'interrupted', detail: 'safety_override' } : {});
    expect(r.completed.status).toBe('interrupted'); expect(r.effect.outcome).toBe('interrupted');
    expect(r.evidence).toMatchObject({ worldId: 'fixture-world', status: 'interrupted', verified: false });
    expect(f.statistics()).toEqual([]); expect(f.mem.recallHistory('new-world')).toEqual([]);
  });
  test.each([
    ['condition_timeout:night', false, 'condition_timeout'],
    ['condition_satisfied:daylight', false, 'effect_unconfirmed'],
    ['condition_satisfied:night', true, 'effect_observed'],
  ])('WAIT result %s is classified without pretending the requested condition occurred', async (detail, verified, outcome) => {
    const f = fixture();
    const r = await f.run({ action: 'WAIT', until: 'night', durationMs: 100 }, () => {}, { detail });
    expect(r.evidence.verified).toBe(verified); expect(r.effect.outcome).toBe(outcome);
    expect(f.statistics()).toHaveLength(verified ? 1 : 0);
  });
  test('intentional elapsed WAIT is verified without world state change', async () => {
    const f = fixture();
    const r = await f.run({ action: 'WAIT', until: 'timeout', durationMs: 100 }, () => {}, { detail: 'wait_elapsed' });
    expect(r.evidence.verified).toBe(true); expect(r.effect.outcome).toBe('effect_observed');
  });
  test('already-equipped item is a satisfied postcondition, not progress or failure', async () => {
    const f = fixture(); f.bot.heldItem = stack('stick');
    const r = await f.run({ action: 'EQUIP', item: 'stick' });
    expect(r.evidence.verified).toBe(true); expect(r.effect.outcome).toBe('already_satisfied');
  });
  test('equipping the wrong item does not verify the requested item', async () => {
    const f = fixture();
    const r = await f.run({ action: 'EQUIP', item: 'stick' }, () => { f.bot.heldItem = stack('stone'); });
    expect(r.evidence.verified).toBe(false); expect(f.statistics()).toEqual([]);
  });
  test('MOVE must arrive at the requested cell, not merely change position', async () => {
    const f = fixture();
    const r = await f.run({ action: 'MOVE', position: target }, () => { f.bot.entity.position.x = 1.5; });
    expect(r.evidence.verified).toBe(false); expect(f.statistics()).toEqual([]);
  });
  test('MOVE already at target is explicitly already satisfied', async () => {
    const f = fixture(); f.bot.entity.position = new Vec3(3.5, 64, 0.5);
    const r = await f.run({ action: 'MOVE', position: target });
    expect(r.evidence.verified).toBe(true); expect(r.effect.outcome).toBe('already_satisfied');
  });
  test('CRAFT ignores an unrelated inventory pickup', async () => {
    const f = fixture();
    const r = await f.run({ action: 'CRAFT', item: 'stick' }, () => { f.bot.inventory.slots[9] = stack('dirt'); });
    expect(r.evidence.verified).toBe(false); expect(f.statistics()).toEqual([]);
  });
  test('CRAFT verifies the requested output increase', async () => {
    const f = fixture();
    const r = await f.run({ action: 'CRAFT', item: 'stick' }, () => { f.bot.inventory.slots[9] = stack('stick', 4); });
    expect(r.evidence.verified).toBe(true); expect(f.statistics()[0].metadata.successes).toBe(1);
  });
  test('USE ignores unrelated inventory or hunger changes', async () => {
    const f = fixture(); f.bot.inventory.slots[9] = stack('apple');
    const r = await f.run({ action: 'USE', item: 'apple' }, () => { f.bot.food++; f.bot.inventory.slots[10] = stack('dirt'); });
    expect(r.evidence.verified).toBe(false); expect(f.statistics()).toEqual([]);
  });
  test('USE verifies selected-item consumption', async () => {
    const f = fixture(); f.bot.inventory.slots[9] = stack('apple', 2);
    const r = await f.run({ action: 'USE', item: 'apple' }, () => { f.bot.inventory.slots[9].count--; f.bot.food += 4; });
    expect(r.evidence.verified).toBe(true);
  });
  test('INTERACT_ENTITY observes in-place metadata changes on that target', async () => {
    const f = fixture(), entity = pig(f.bot);
    const r = await f.run({ action: 'INTERACT_ENTITY', entityId: 21 }, () => { entity.metadata[0] = true; });
    expect(r.evidence.verified).toBe(true);
    expect(r.effect.targetMetadataBefore).toBe('[false]'); expect(r.effect.targetMetadataAfter).toBe('[true]');
  });
  test.each(['unrelated', 'disappeared', 'replaced'])('entity %s does not verify an interaction', async kind => {
    const f = fixture(); pig(f.bot); const other = pig(f.bot, 22);
    const r = await f.run({ action: 'INTERACT_ENTITY', entityId: 21 }, () => {
      if (kind === 'unrelated') other.metadata[0] = true;
      if (kind === 'disappeared') delete f.bot.entities[21];
      if (kind === 'replaced') f.bot.entities[21] = { ...f.bot.entities[21], uuid: 'replacement', metadata: [true] };
    });
    expect(r.evidence.verified).toBe(false); expect(f.statistics()).toEqual([]);
  });
  test('ATTACK hit is recorded separately from kill; unrelated hurt is ignored', async () => {
    const f = fixture(), entity = pig(f.bot), other = pig(f.bot, 22);
    const missed = await f.run({ action: 'ATTACK', entityId: 21 }, () => f.bot.emit('entityHurt', other));
    expect(missed.evidence.verified).toBe(false); expect(f.statistics()).toEqual([]);
    const hit = await f.run({ action: 'ATTACK', entityId: 21 }, () => f.bot.emit('entityHurt', entity));
    expect(hit.evidence.verified).toBe(true); expect(hit.effect.assessmentReason).toContain('not_kill');
    expect(f.bot.entities[21]).toBe(entity);
  });
  test.each(['unloaded', 'wrong_block'])('PLACE %s cannot create a confirmed location', async kind => {
    const f = fixture(); f.bot.blockAt.mockReturnValue({ name: 'air', stateId: 0 });
    const r = await f.run({ action: 'PLACE', item: 'stone', position: target }, () => {
      f.bot.blockAt.mockReturnValue(kind === 'unloaded' ? null : { name: 'dirt', stateId: 1 });
    });
    expect(r.evidence.verified).toBe(false); expect(f.mem.recallHistory('fixture-world')).toEqual([]);
    expect(f.statistics()).toEqual([]);
  });
  test('unloaded block after BREAK does not erase a remembered structure', async () => {
    const f = fixture();
    const remembered = f.mem.observe({ kind: 'placed_block', key: 'home', label: 'stone', position: target,
      dimension: 'overworld', retention: 'stable', confidence: 1 });
    f.bot.blockAt.mockReturnValue({ name: 'stone', stateId: 1 });
    const r = await f.run({ action: 'BREAK', position: target }, () => { f.bot.blockAt.mockReturnValue(null); });
    expect(r.evidence.verified).toBe(false); expect(f.mem.recallHistory('fixture-world')[0]).toEqual(remembered);
  });
  test('furnace processing unrelated to selected TRANSFER is not transfer evidence', async () => {
    const f = fixture();
    const w = f.bot.currentWindow = { id: 7, type: 'minecraft:furnace', inventoryStart: 3, inventoryEnd: 39, slots: Array(39).fill(null) };
    w.slots[3] = stack('chicken', 2);
    const r = await f.run({ action: 'TRANSFER', windowId: 7, sourceSlot: 3, destinationSlot: 0, item: 'chicken', count: 1 }, () => {
      w.slots[2] = stack('cooked_chicken');
    });
    expect(r.evidence.verified).toBe(false); expect(f.statistics()).toEqual([]);
  });
  test('TRANSFER accepts source removal when the server consumes fuel immediately', async () => {
    const f = fixture();
    const w = f.bot.currentWindow = { id: 7, type: 'minecraft:furnace', inventoryStart: 3, inventoryEnd: 39, slots: Array(39).fill(null) };
    w.slots[3] = stack('oak_planks', 2);
    const r = await f.run({ action: 'TRANSFER', windowId: 7, sourceSlot: 3, destinationSlot: 1, item: 'oak_planks', count: 1 }, () => { w.slots[3].count--; });
    expect(r.evidence.verified).toBe(true);
  });
  test('unconfirmed procedure step pauses replay without downgrading it or running the next step', async () => {
    const f = fixture();
    const common = { worldId: 'fixture-world', version: '1.21.4', dimension: 'overworld',
      status: 'succeeded' as const, verified: true, detail: 'synthetic fixture', effect: 'fixture',
      origin: { x: 0.5, y: 64, z: 0.5 }, window: windowSnapshot(f.bot) };
    const traces = [1, 2].map(x => f.exp.append({ ...common, operation: { action: 'LOOK', position: { x, y: 65, z: 0 } } }));
    const p = f.exp.save('fixture look sequence', traces.map(t => t.id));
    f.exp.recordReplay(p.id, true); f.exp.recordReplay(p.id, true);
    const saved = f.exp.get(p.id);
    f.primitive.runAndWait.mockResolvedValue({ action: 'OPERATE', status: 'succeeded', detail: 'operation_completed:LOOK' });
    const result = await f.task.execute({ task: 'RUN_PROCEDURE', procedureId: p.id, source: 'openai', confidence: 1, basedOnRevision: 1 });
    expect(result).toEqual({ status: 'interrupted', detail: 'task_replan:procedure_step_effect_unconfirmed' });
    expect(f.primitive.runAndWait).toHaveBeenCalledTimes(1); expect(f.exp.get(p.id)).toEqual(saved);
    expect(f.statistics()).toEqual([]);
    const last = f.exp.recent().at(-1)!;
    expect(last.verified).toBe(false);
    expect(() => f.exp.save('not demonstrated', [traces[1].id, last.id])).toThrow('verified_evidence');
  });
  test('arrival at a remembered animal area does not confirm that an animal is still there', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000000);
    const f = fixture(), p = { x: 4, y: 64, z: 0 };
    const record = f.mem.observe({ kind: 'entity_sighting', key: 'chicken:4:64:0', label: 'chicken', position: p,
      dimension: 'overworld', confidence: 0.6, metadata: { source: 'visual_entity' } });
    now.mockReturnValue(1003000);
    const r = await f.run({ action: 'MOVE', position: p }, () => { f.bot.entity.position = new Vec3(4.5, 64, 0.5); });
    expect(r.evidence.verified).toBe(true);
    const state = f.semantic.capture(f.task.snapshot());
    expect(state.targets.some(t => t.kind === 'entity')).toBe(false);
    expect(state.targets.find(t => t.metadata.memoryId === record.id)?.kind).toBe('remembered_location');
    expect(f.mem.recallHistory('fixture-world')[0]).toEqual(record);
    // Actual entity observation, not the arrival, updates the old sighting.
    now.mockReturnValue(1006000);
    f.bot.entities[30] = { id: 30, name: 'chicken', type: 'mob', position: new Vec3(4, 64, 0) };
    f.semantic.capture(f.task.snapshot());
    const seen = f.mem.recallHistory('fixture-world')[0];
    expect(seen.id).toBe(record.id); expect(seen.lastSeenAt).toBe(1006000);
    expect(seen.observations).toBe(record.observations + 1);
  });
  test('resource recollection needs a loaded visible block, not merely the coordinate', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000000);
    const f = fixture(), p = new Vec3(4, 64, 0);
    const record = f.mem.observe({ kind: 'resource_site', key: 'oak_log:4:64:0', label: 'oak_log', position: p,
      dimension: 'overworld', confidence: 0.6, metadata: { resource: 'oak_log', blockName: 'oak_log', source: 'visible_block' } });
    f.bot.findBlocks.mockReturnValue([p]); now.mockReturnValue(1003000);
    expect((f.semantic as any).findResourceSources()).toEqual([]); // unloaded
    f.bot.blockAt.mockReturnValue({ name: 'oak_log', position: p, diggable: true,
      drops: [registry.itemsByName.oak_log.id], canHarvest: () => true });
    f.bot.canSeeBlock.mockReturnValue(false);
    expect((f.semantic as any).findResourceSources()).toEqual([]); // occluded
    expect(f.mem.recallHistory('fixture-world')[0]).toEqual(record);
    f.bot.canSeeBlock.mockReturnValue(true);
    expect((f.semantic as any).findResourceSources()).toHaveLength(1);
    const seen = f.mem.recallHistory('fixture-world')[0];
    expect(seen.id).toBe(record.id); expect(seen.lastSeenAt).toBe(1003000);
    expect(seen.observations).toBe(record.observations + 1);
  });
});
