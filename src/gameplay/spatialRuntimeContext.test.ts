import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { SpatialRuntimeContext } from './spatialRuntimeContext.js';
import { WorldMemory } from './worldMemory.js';
import { ExperienceMemory } from './experienceMemory.js';
import { TaskExecutor } from './taskExecutor.js';
import { SkillExecutor } from './skillExecutor.js';
import { StrategicPlanner } from './strategicPlanner.js';
import { CognitiveOrchestrator } from './jevOrchestrator.js';
import { SharedStateBus } from '../cognitive/sharedState.js';
import { executePrimitiveOperation, windowSnapshot } from './primitiveOperations.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function botFixture(): any {
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(), version: '1.21.4', game: { dimension: 'overworld' },
    registry: { version: { minecraftVersion: '1.21.4' }, foodsByName: { apple: { foodPoints: 4 } } },
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0 }, entities: {},
    health: 20, food: 10, currentWindow: null, heldItem: null,
    inventory: { id: 0, type: 'minecraft:inventory', inventoryStart: 9, inventoryEnd: 45,
      slots: Array(46).fill(null), items() { return this.slots.filter(Boolean); } },
    blockAt: jest.fn(() => ({ name: 'air', stateId: 0 })),
    time: { timeOfDay: 1000, day: 0 },
    stopDigging: jest.fn(), deactivateItem: jest.fn(), clearControlStates: jest.fn(),
    pathfinder: { stop: jest.fn() }, closeWindow: jest.fn(), quit: jest.fn(),
    equip: jest.fn(async () => {}), consume: jest.fn(async () => {}),
  });
  return bot;
}
function arrive(bot: any, dimension = 'overworld') {
  bot.game.dimension = dimension;
  bot.emit('game'); bot.emit('forcedMove'); bot.emit('spawn'); bot.emit('chunkColumnLoad');
}
function transition(bot: any, dimension: string) {
  bot._client.emit('respawn', {}); arrive(bot, dimension);
}
const operationDecision = { task: 'EXECUTE_OPERATION', operation: { action: 'WAIT', durationMs: 100 },
  source: 'openai', confidence: 1, basedOnRevision: 1 } as const;
const complete = { action: 'OPERATE', status: 'succeeded', detail: 'wait_elapsed' };

// No server launch, paid model call, or user's database: actual runtime classes
// with real temporary SQLite; packet events and physical operations are controlled.
describe('T04a-2b runtime spatial leases', () => {
  let directory: string;
  const contexts: SpatialRuntimeContext[] = [];
  const closables: Array<{ close(): void }> = [];
  const runtimes: CognitiveOrchestrator[] = [];
  const planners: StrategicPlanner[] = [];
  let oldWorldId: string | undefined;
  beforeEach(() => {
    jest.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), 'spatial-runtime-'));
    oldWorldId = process.env.GAMEPLAY_WORLD_ID;
    process.env.GAMEPLAY_WORLD_ID = 'transition-fixture';
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const planner of planners.splice(0)) planner.stop();
    for (const runtime of runtimes.splice(0)) {
      runtime.stop(); (runtime as any).memory.close(); (runtime as any).experience.close();
    }
    for (const context of contexts.splice(0)) context.dispose();
    for (const value of closables.splice(0)) value.close();
    if (oldWorldId === undefined) delete process.env.GAMEPLAY_WORLD_ID;
    else process.env.GAMEPLAY_WORLD_ID = oldWorldId;
    jest.restoreAllMocks(); jest.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });
  function context(bot: any, invalidate = jest.fn(), ready = jest.fn()) {
    const value = new SpatialRuntimeContext(bot, () => 'world-A', { invalidate, ready });
    contexts.push(value); return value;
  }
  function stores() {
    const memory = new WorldMemory(join(directory, 'memory.sqlite'), 'world-A');
    const experience = new ExperienceMemory(join(directory, 'experience.sqlite'));
    closables.push(memory, experience); return { memory, experience };
  }
  function runtime() {
    const value = new CognitiveOrchestrator({ mcHost: 'fixture.example', mcPort: 25565,
      dbPath: join(directory, `runtime-${runtimes.length}.sqlite`), tacticalModel: 'fixture',
      strategicModel: 'fixture', botUsername: 'Fixture', cameraPlayer: '', voicevoxHost: '', voicevoxSpeakerId: 0 });
    runtimes.push(value); return value;
  }

  test('readiness requires spawn, a fresh position and a loaded current column', () => {
    const bot = botFixture(), ready = jest.fn(), ctx = context(bot, jest.fn(), ready);
    bot.blockAt.mockReturnValue(null);
    bot.emit('spawn'); expect(ctx.isReady()).toBe(false);
    bot.emit('forcedMove'); expect(ctx.isReady()).toBe(false);
    bot.blockAt.mockReturnValue({ name: 'air', stateId: 0 }); bot.emit('chunkColumnLoad');
    expect(ctx.isReady()).toBe(true); expect(ready).toHaveBeenCalledTimes(1);
    bot._client.emit('respawn', {}); bot.emit('chunkColumnLoad');
    expect(ctx.isReady()).toBe(false);
  });

  test('raw respawn invalidates before ordinary client listeners update the world', () => {
    const bot = botFixture(), invalidate = jest.fn();
    let observedReady: boolean | undefined;
    let ctx!: SpatialRuntimeContext;
    bot._client.on('respawn', () => { observedReady = ctx.isReady(); });
    ctx = context(bot, invalidate); arrive(bot);
    bot._client.emit('respawn', {});
    expect(observedReady).toBe(false); expect(invalidate).toHaveBeenCalledWith('respawn');
  });

  test.each(['overworld', 'the_nether'])('return to same context does not revive the old ticket (%s)', destination => {
    const bot = botFixture(), ctx = context(bot); arrive(bot); const old = ctx.ticket();
    transition(bot, destination); transition(bot, 'overworld');
    expect(ctx.isReady()).toBe(true); expect(ctx.getEpoch()).toBeGreaterThan(old.epoch);
    expect(ctx.matches(old)).toBe(false);
  });

  test('unknown dimension and disconnect stay gated; disposal removes owned listeners', () => {
    const bot = botFixture(), ctx = context(bot);
    arrive(bot, 'unknown'); expect(ctx.isReady()).toBe(false);
    arrive(bot); expect(ctx.isReady()).toBe(true);
    bot.emit('end'); arrive(bot); expect(ctx.isReady()).toBe(false);
    ctx.dispose(); expect(bot._client.listenerCount('respawn')).toBe(0);
    expect(bot.listenerCount('forcedMove')).toBe(0);
  });

  test('a transition-gated executor never invokes a primitive or sensor', async () => {
    const bot = botFixture(), ctx = context(bot), { memory, experience } = stores();
    const primitive: any = { runAndWait: jest.fn(), stop: jest.fn() };
    const sensor: any = { capture: jest.fn() };
    const task = new TaskExecutor(bot, new SharedStateBus(), primitive, sensor, {} as any, memory, experience, ctx);
    expect((await task.execute(operationDecision)).status).toBe('interrupted');
    expect(primitive.runAndWait).not.toHaveBeenCalled(); expect(sensor.capture).not.toHaveBeenCalled();
  });

  test('late source finalizer cannot read an unready destination or write a destination placement', async () => {
    const bot = botFixture(), { memory, experience } = stores(), pending = deferred<any>();
    const primitive: any = { runAndWait: jest.fn(() => pending.promise), snapshot: () => ({}), stop: jest.fn() };
    let task!: TaskExecutor;
    const ctx = context(bot, jest.fn(() => task?.interruptSpatialTransition('respawn'))); arrive(bot);
    task = new TaskExecutor(bot, new SharedStateBus(), primitive, { capture: () => ({}) } as any, {} as any, memory, experience, ctx);
    const work = task.execute({ ...operationDecision, operation: { action: 'PLACE', item: 'stone', position: { x: 3, y: 64, z: 0 } } });
    bot._client.emit('respawn', {}); bot.game.dimension = 'the_nether';
    bot.blockAt.mockImplementation(() => { throw new Error('destination_not_ready'); });
    pending.resolve(complete);
    expect((await work).status).toBe('interrupted');
    expect(primitive.stop).toHaveBeenCalled();
    expect(experience.recent()[0]).toMatchObject({ worldId: 'world-A', dimension: 'overworld', status: 'interrupted', verified: false });
    expect(memory.recallHistory('world-A')).toEqual([]);
    expect(memory.recall({ includeWorld: false })).toEqual([]);
  });

  test('late A->B->A operation keeps its original task ID and cannot finish a newer task', async () => {
    const bot = botFixture(), { memory, experience } = stores();
    const first = deferred<any>(), second = deferred<any>();
    const primitive: any = { runAndWait: jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise), snapshot: () => ({}), stop: jest.fn() };
    let task!: TaskExecutor;
    const ctx = context(bot, jest.fn(() => task?.interruptSpatialTransition('respawn'))); arrive(bot);
    task = new TaskExecutor(bot, new SharedStateBus(), primitive, { capture: () => ({}) } as any, {} as any, memory, experience, ctx);
    const old = task.execute(operationDecision);
    transition(bot, 'the_nether'); transition(bot, 'overworld');
    const fresh = task.execute(operationDecision); const newId = task.snapshot().id;
    first.resolve(complete); expect((await old).status).toBe('interrupted');
    expect(task.snapshot()).toMatchObject({ id: newId, status: 'running' });
    const events = (console.log as jest.Mock).mock.calls.map(([line]) => JSON.parse(line));
    expect(events.find(e => e.kind === 'operation_evidence').task_id).toBe(1);
    second.resolve(complete); expect((await fresh).status).toBe('succeeded');
    expect(experience.recent().map(e => e.status)).toEqual(['interrupted', 'succeeded']);
  });

  test('a learned procedure does not execute its next step after same-dimension respawn', async () => {
    const bot = botFixture(), { memory, experience } = stores();
    const ids = [1, 2].map(() => experience.append({ worldId: 'world-A', version: '1.21.4', dimension: 'overworld',
      operation: { action: 'WAIT', durationMs: 100 }, status: 'succeeded', verified: true,
      detail: 'wait_elapsed', effect: 'fixture', origin: { x: 0, y: 64, z: 0 }, window: windowSnapshot(bot) }).id);
    const procedure = experience.save('fixture sequence', ids), pending = deferred<any>();
    let task!: TaskExecutor;
    const ctx = context(bot, jest.fn(() => task?.interruptSpatialTransition('respawn'))); arrive(bot);
    const primitive: any = { runAndWait: jest.fn(() => pending.promise), snapshot: () => ({}), stop: jest.fn() };
    task = new TaskExecutor(bot, new SharedStateBus(), primitive, { capture: () => ({}) } as any, {} as any, memory, experience, ctx);
    const work = task.execute({ ...operationDecision, task: 'RUN_PROCEDURE', procedureId: procedure.id });
    transition(bot, 'overworld'); pending.resolve(complete);
    expect((await work).status).toBe('interrupted'); expect(primitive.runAndWait).toHaveBeenCalledTimes(1);
    expect(experience.get(procedure.id)).toMatchObject({ successes: 0, failures: 0 });
  });

  test('cooperative adapter cannot consume after an obsolete delayed equip resolves', async () => {
    const bot = botFixture(), ctx = context(bot); arrive(bot); const ticket = ctx.ticket();
    const equip = deferred<void>(); bot.equip.mockImplementation(() => equip.promise);
    bot.inventory.slots[9] = { name: 'apple', count: 1 };
    const result = executePrimitiveOperation(bot, { action: 'USE', item: 'apple' }, {
      assertActive: () => { if (!ctx.matches(ticket)) throw new Error('task_replan:changed'); },
    }).catch(error => error.message);
    transition(bot, 'the_nether'); transition(bot, 'overworld'); equip.resolve();
    expect(await result).toBe('task_replan:changed'); expect(bot.consume).not.toHaveBeenCalled();
  });

  test('real SkillExecutor WAIT is stopped at transition rather than waiting for the full duration', async () => {
    const bot = botFixture(), shared = new SharedStateBus(), primitive = new SkillExecutor(bot, shared);
    const ctx = context(bot, jest.fn(() => primitive.stop())); arrive(bot);
    const work = primitive.runAndWait({ action: 'OPERATE', operation: { action: 'WAIT', durationMs: 60000 }, confidence: 1, source: 'task' }, null);
    bot._client.emit('respawn', {});
    expect(primitive.snapshot().status).toBe('interrupted');
    expect(bot.clearControlStates).toHaveBeenCalled(); expect(bot.pathfinder.stop).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(100);
    expect((await work).status).toBe('interrupted'); ctx.dispose();
  });

  test.each(['response', 'body'])('planner rejects delayed %s after A->B->A and does not create a second timer', async phase => {
    const bot = botFixture(), shared = new SharedStateBus(), changed = jest.fn();
    let planner!: StrategicPlanner;
    const ctx = context(bot, jest.fn(() => planner?.stop()), jest.fn(() => planner?.start())); arrive(bot);
    const state: any = { capabilities: {}, strategy: { mainGoal: 'fixture', subGoals: [] }, targets: [] };
    planner = new StrategicPlanner(shared, 'fixture', 'fixture', () => state, changed, ctx); planners.push(planner);
    const pending = deferred<any>();
    const output = { output_text: JSON.stringify({ main_goal: 'OBSOLETE', sub_goals: [], progress_assessment: '' }) };
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => phase === 'response'
      ? pending.promise : Promise.resolve({ ok: true, json: () => pending.promise } as Response));
    planner.start(); changed.mockClear();
    const work = (planner as any).runCycle() as Promise<void>;
    await Promise.resolve();
    transition(bot, 'the_nether'); transition(bot, 'overworld'); changed.mockClear();
    const scheduled = jest.spyOn(planner as any, 'schedule');
    pending.resolve(phase === 'response' ? { ok: true, json: async () => output } : output);
    await work;
    expect(changed).not.toHaveBeenCalled(); expect(shared.get().currentGoal).not.toBe('OBSOLETE');
    expect(scheduled).not.toHaveBeenCalled();
  });

  test('runtime gates debug observations and immediately stops task/planner/safety on respawn', () => {
    const value: any = runtime(), bot = botFixture(); value.running = true; value.bot = bot;
    value.semantic = { capture: jest.fn() }; value.sensor = { capture: jest.fn() };
    value.taskExecutor = { snapshot: () => ({}), interruptSpatialTransition: jest.fn(), stop: jest.fn() };
    value.primitive = { snapshot: () => ({}), stop: jest.fn() };
    value.planner = { start: jest.fn(), stop: jest.fn() }; value.safety = { start: jest.fn(), stop: jest.fn() };
    const ctx = value.attachSpatialContext(bot); contexts.push(ctx); arrive(bot);
    value.shared.setGoal('old place'); value.shared.setSubGoals(['old coordinate']);
    bot._client.emit('respawn', {});
    expect(value.taskExecutor.interruptSpatialTransition).toHaveBeenCalledWith('respawn');
    expect(value.planner.stop).toHaveBeenCalled(); expect(value.safety.stop).toHaveBeenCalled();
    expect(value.getExecutiveWorldState()).toBeNull(); expect(value.getJevWorldState()).toBeNull();
    expect(value.getGameplaySnapshot()).toBeNull(); expect(value.semantic.capture).not.toHaveBeenCalled();
    expect(value.shared.get().subGoals).toEqual([]);
  });

  test('executive discards ABA reply even when the ordinary semantic revision is identical', async () => {
    const value: any = runtime(), bot = botFixture(), pending = deferred<any>();
    value.running = true; value.bot = bot;
    const ctx = value.attachSpatialContext(bot); contexts.push(ctx); arrive(bot);
    value.semantic = { capture: jest.fn(() => ({ revision: 1 })) };
    const task = { snapshot: () => ({}), execute: jest.fn(), interruptSpatialTransition: jest.fn(), stop: jest.fn() };
    value.taskExecutor = task;
    value.executivePolicy = { decide: jest.fn().mockReturnValueOnce(pending.promise).mockImplementationOnce(async () => {
      value.running = false; return operationDecision;
    }) };
    const loop = value.runExecutiveLoop();
    transition(bot, 'the_nether'); transition(bot, 'overworld');
    pending.resolve(operationDecision); await loop;
    expect(task.execute).not.toHaveBeenCalled();
    expect(value.executivePolicy.decide).toHaveBeenCalledTimes(2);
  });

  test('old executive loop cannot execute on replacement runtime objects', async () => {
    const value: any = runtime(), bot = botFixture(), pending = deferred<any>();
    value.running = true; value.bot = bot;
    const ctx = value.attachSpatialContext(bot); contexts.push(ctx); arrive(bot);
    value.semantic = { capture: jest.fn(() => ({ revision: 1 })) };
    const task = { snapshot: () => ({}), execute: jest.fn(), stop: jest.fn(), interruptSpatialTransition: jest.fn() };
    value.taskExecutor = task; value.executivePolicy = { decide: jest.fn(() => pending.promise) };
    const loop = value.runExecutiveLoop();
    value.stop();
    const replacement = botFixture(); value.running = true; value.bot = replacement;
    const next = value.attachSpatialContext(replacement); contexts.push(next); arrive(replacement);
    const newTask = { snapshot: () => ({}), execute: jest.fn(), stop: jest.fn(), interruptSpatialTransition: jest.fn() };
    value.taskExecutor = newTask;
    pending.resolve(operationDecision); await loop;
    expect(task.execute).not.toHaveBeenCalled(); expect(newTask.execute).not.toHaveBeenCalled();
  });
});
