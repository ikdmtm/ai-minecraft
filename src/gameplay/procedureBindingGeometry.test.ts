import { Vec3 } from 'vec3';
import { deriveProcedureSteps, bindProcedureStep } from './procedureBindings.js';
import type { Evidence, ProcedureStep } from './experienceMemory.js';

const windowEvidence = { id: 0, type: 'minecraft:inventory', open: false,
  inventoryStart: 9, inventoryEnd: 45, cursor: null, slots: [] };
function evidence(action: 'BREAK' | 'PLACE', index: number): Evidence {
  return { id: `fixture-${index}`, sequence: index, sessionId: 'fixture', worldId: 'old-world',
    version: '1.21.4', dimension: 'overworld', status: 'succeeded', verified: true,
    detail: 'controlled fixture', effect: 'controlled fixture', createdAt: index,
    origin: { x: 100.5, y: 64, z: 100.5 }, window: windowEvidence,
    operation: { action, position: { x: 102, y: 64, z: 100 }, ...(action === 'PLACE' ? { item: 'furnace' } : {}) },
    blockName: action === 'BREAK' ? 'stone' : 'air' };
}
function botAt(position: Vec3, target: Vec3): any {
  return { entity: { position }, findBlocks: () => [target],
    blockAt: (p: Vec3) => ({ name: 'stone', position: p }), canSeeBlock: () => true };
}

test('BREAK then PLACE at the same demonstrated coordinate uses the newly bound position', () => {
  const steps = deriveProcedureSteps([evidence('BREAK', 1), evidence('PLACE', 2)]);
  const anchor = new Vec3(-200, 80, 300), target = new Vec3(-204, 80, 301);
  const bot = botAt(anchor, target), bindings = new Map<string, number>();
  expect(steps[0].binding?.ref).toBe(steps[1].binding?.ref);
  expect(bindProcedureStep(steps[0], bot, anchor, bindings).position).toEqual({ ...target });
  // The source translated coordinate would be (-198,80,300), not the rebound block.
  expect(bindProcedureStep(steps[1], bot, anchor, bindings).position).toEqual({ ...target });
});

test('a first PLACE still uses translated geometry and cannot inherit another replay binding', () => {
  const step: ProcedureStep = { operation: { action: 'PLACE', item: 'stone' },
    binding: { kind: 'relative', ref: 'block:0', offset: { x: 2, y: 0, z: 0 } } };
  const bot = botAt(new Vec3(0, 0, 0), new Vec3(0, 0, 0));
  expect(bindProcedureStep(step, bot, new Vec3(10, 64, 10), new Map()).position).toEqual({ x: 12, y: 64, z: 10 });
  expect(bindProcedureStep(step, bot, new Vec3(-10, 70, 20), new Map()).position).toEqual({ x: -8, y: 70, z: 20 });
});

test('MOVE and LOOK remain geometric waypoints rather than pinning a placed-block identity', () => {
  const a = { ...evidence('BREAK', 1), operation: { action: 'MOVE' as const, position: { x: 102, y: 64, z: 100 } }, blockName: 'air' };
  const b = evidence('PLACE', 2), steps = deriveProcedureSteps([a, b]);
  expect(steps[0].binding?.kind).toBe('relative');
  expect(steps[0].binding?.ref).toBeUndefined();
  expect(steps[1].binding?.ref).toBeDefined();
});
