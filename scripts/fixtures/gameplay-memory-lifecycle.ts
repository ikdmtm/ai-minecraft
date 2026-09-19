/** T04b persistence fixture. Never starts Minecraft, a model, or the normal gameplay CLI. */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { basename, dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Vec3 } from 'vec3';
import { CognitiveOrchestrator } from '../../src/gameplay/jevOrchestrator.js';
import { WorldMemory } from '../../src/gameplay/worldMemory.js';
import { ExperienceMemory, type Evidence } from '../../src/gameplay/experienceMemory.js';
import { TaskExecutor } from '../../src/gameplay/taskExecutor.js';
import { windowSnapshot } from '../../src/gameplay/primitiveOperations.js';

const dimension = 'minecraft:overworld';
const origin = { x: 100.5, y: 64, z: -200.5 };
function physicalFixture(): any {
  return Object.assign(new EventEmitter(), {
    version: '1.21.4', registry: { windows: {} }, game: { dimension: 'overworld' },
    health: 20, food: 20, entity: { position: new Vec3(origin.x, origin.y, origin.z), yaw: 0, pitch: 0 },
    entities: {}, currentWindow: null, heldItem: null, isSleeping: false,
    inventory: { id: 0, type: 'minecraft:inventory', inventoryStart: 9, inventoryEnd: 45,
      slots: Array(46).fill(null), items: () => [] },
    blockAt: () => ({ name: 'air', stateId: 0 }),
  });
}

async function main(): Promise<void> {
  const [mode, inputPath, token = 'world-A', requestedHistory] = process.argv.slice(2);
  assert.equal(process.env.GAMEPLAY_MEMORY_FIXTURE, '1');
  assert.ok(process.send, 'requires test IPC parent');
  const path = resolve(inputPath);
  const directory = realpathSync(dirname(path));
  assert.equal(dirname(directory), realpathSync(tmpdir()), 'only an isolated system temporary directory is allowed');
  assert.ok(basename(directory).startsWith('memory-lifecycle-'));
  assert.equal(basename(path), 'memory.sqlite');
  assert.ok(['seed', 'hold', 'rollback', 'read', 'append', 'rotate', 'resave', 'flood', 'late-stop', 'late-rotate'].includes(mode));
  process.env.GAMEPLAY_WORLD_ID = token;
  delete process.env.GAMEPLAY_WORLD_ID_FILE;
  delete process.env.MC_DEV_DIR;

  // Use the same two database classes and world switching code as the runtime,
  // but never call start(): no network, LLM request or live world is involved.
  const runtime = new CognitiveOrchestrator({
    dbPath: path, mcHost: 'lifecycle-fixture.invalid', mcPort: 25565,
    tacticalModel: 'fixture', strategicModel: 'fixture', botUsername: 'Fixture',
    cameraPlayer: '', voicevoxHost: '', voicevoxSpeakerId: 0,
  });
  const internals = runtime as unknown as {
    memory: WorldMemory; experience: ExperienceMemory; running: boolean; taskExecutor: TaskExecutor | null;
  };
  const { memory, experience } = internals;
  const sourceWorldId = requestedHistory ?? memory.getWorldId();
  const common = (): Omit<Evidence, 'id' | 'sequence' | 'sessionId' | 'createdAt'> => ({
    worldId: memory.getWorldId(), version: '1.21.4', dimension: 'overworld',
    operation: { action: 'WAIT', durationMs: 100 }, status: 'succeeded', verified: true,
    detail: 'fixture-only evidence', effect: 'fixture observed effect', origin,
    window: windowSnapshot(physicalFixture()),
  });
  const demonstration = (name: string) => {
    const traces = [0, 1].map(offset => experience.append({ ...common(),
      operation: { action: 'PLACE', item: 'stone', position: { x: 101, y: 64 + offset, z: -201 } },
    }));
    return experience.save(name, traces.map(trace => trace.id));
  };

  if (['seed', 'hold', 'rollback'].includes(mode)) {
    assert.equal(experience.recent().length, 0, 'seed mode requires an empty fixture database');
    demonstration('fixture candidate');
    const verified = demonstration('fixture verified');
    experience.recordReplay(verified.id, true); experience.recordReplay(verified.id, true);
    const revised = demonstration('fixture with failed replay');
    experience.recordReplay(revised.id, true); experience.recordReplay(revised.id, false);
    const failure = experience.append({ ...common(), status: 'failed', verified: false, detail: 'fixture_failure' });
    experience.append({ ...common(), status: 'interrupted', verified: false, detail: 'fixture_cancelled' });
    experience.append({ ...common(), status: 'succeeded', verified: false, detail: 'fixture_no_confirmed_effect' });
    memory.recordProcedureOutcome({ key: 'fixture-summary', label: 'fixture operation', success: true, detail: 'fixture_success' });
    memory.recordProcedureOutcome({ key: 'fixture-summary', label: 'fixture operation', success: false,
      detail: 'fixture_failure', metadata: { evidenceId: failure.id } });
    memory.observe({ kind: 'life_event', key: 'fixture-life', label: 'fixture life ended', scope: 'global',
      retention: 'stable', confidence: 1, metadata: { sourceWorldId, evidenceId: failure.id } });
    memory.observe({ kind: 'placed_block', key: 'home', label: 'fixture old home', position: origin,
      dimension, scope: 'world', retention: 'stable', confidence: 1 });
  }
  if (mode === 'append') {
    experience.append({ ...common(), status: 'failed', verified: false, detail: 'fixture_after_restart' });
    memory.recordProcedureOutcome({ key: 'fixture-summary', label: 'fixture operation', success: true, detail: 'fixture_after_restart' });
  }
  if (mode === 'resave') {
    for (const p of experience.list()) assert.equal(experience.save('duplicate request', p.evidenceIds).id, p.id);
  }
  if (mode === 'flood') {
    for (let i = 0; i < 80; i++) experience.append({ ...common(), status: 'failed', verified: false, detail: `unrelated fixture ${i}` });
  }
  let lateResult: unknown = null;
  if (mode.startsWith('late-')) {
    let complete!: (value: any) => void;
    const primitive: any = {
      runAndWait: () => new Promise(resolveResult => { complete = resolveResult; }),
      snapshot: () => ({}), stop: () => {},
    };
    const task = new TaskExecutor(physicalFixture(), runtime.getShared(), primitive,
      { capture: () => ({}) } as any, {} as any, memory, experience);
    internals.taskExecutor = task;
    internals.running = true; // exercise actual runtime stop/destroy; physical operation is controlled
    const pending = task.execute({ task: 'EXECUTE_OPERATION', source: 'openai', confidence: 1, basedOnRevision: 1,
      operation: { action: 'PLACE', item: 'stone', position: { x: 101, y: 64, z: -201 } } });
    assert.equal(typeof complete, 'function');
    runtime.destroy();
    if (mode === 'late-rotate') { process.env.GAMEPLAY_WORLD_ID = 'world-B'; runtime.nextGeneration(); }
    complete({ action: 'OPERATE', status: 'succeeded', detail: 'delayed fixture result' });
    lateResult = await pending;
    assert.equal((lateResult as { status: string }).status, 'interrupted');
  }
  if (mode === 'rotate') {
    runtime.stop();
    process.env.GAMEPLAY_WORLD_ID = 'world-B';
    runtime.nextGeneration();
  }

  const procedures = experience.list();
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const snapshot = {
    sessionId: experience.sessionId, worldId: memory.getWorldId(), sourceWorldId,
    generation: runtime.getGeneration(), lateResult,
    global: memory.recall({ includeWorld: false, limit: 64 }).sort((a, b) => a.id.localeCompare(b.id)),
    currentSpatial: memory.recall({ dimension, includeGlobal: false }),
    history: memory.recallHistory(sourceWorldId, 64),
    procedures: procedures.sort((a, b) => a.id.localeCompare(b.id)),
    sourceEvidence: experience.evidence(procedures.flatMap(p => p.evidenceIds)),
    recent: experience.recent(64),
    evidenceRows: db.prepare('SELECT sequence,id,payload FROM autonomy_evidence ORDER BY sequence').all(),
    procedureRows: db.prepare('SELECT id,payload FROM autonomy_procedures ORDER BY id').all(),
    integrity: db.pragma('integrity_check', { simple: true }),
  };
  db.close();
  let transaction: Database.Database | undefined;
  if (mode === 'rollback') {
    transaction = new Database(path);
    transaction.exec('BEGIN IMMEDIATE');
    transaction.prepare('UPDATE autonomy_procedures SET payload=? WHERE id=?').run(
      JSON.stringify({ ...procedures[0], name: 'UNCOMMITTED REPLACEMENT' }), procedures[0].id);
    transaction.prepare('INSERT INTO autonomy_evidence(id,payload) VALUES(?,?)').run('uncommitted-evidence', '{}');
    // Deliberately no COMMIT. The parent terminates this child only after IPC.
  }
  if (mode !== 'hold' && mode !== 'rollback') {
    runtime.destroy(); experience.close(); memory.close();
  }
  await new Promise<void>((done, fail) => process.send!({ kind: 'snapshot', snapshot }, error => error ? fail(error) : done()));
  if (mode === 'hold' || mode === 'rollback') {
    // No shutdown hooks: the test exercises OS process termination and WAL recovery.
    setInterval(() => { void transaction; }, 1000);
  } else {
    process.disconnect();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
