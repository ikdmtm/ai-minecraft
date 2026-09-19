import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { parseOperation, windowSnapshot, type PrimitiveOperation } from './primitiveOperations.js';
import { normalizeMemoryDimension } from './worldMemory.js';
import type { Evidence, LearnedProcedure, ProcedureStep } from './experienceMemory.js';

/** Missing live preconditions require replanning, not a negative skill lesson. */
export class ProcedureBindingError extends Error {}
const reject = (reason: string): never => { throw new ProcedureBindingError(`procedure_${reason}`); };

export function procedureEnvironmentMatches(
  procedure: Pick<LearnedProcedure, 'version' | 'dimension'>, version: string, dimension: unknown,
): boolean {
  const expected = normalizeMemoryDimension(procedure.dimension);
  return procedure.version === version && expected != null && expected === normalizeMemoryDimension(dimension);
}

/** Preserve relationships with local reference tokens, never source-world IDs.
 * The source evidence is retained unchanged; these are newly saved templates. */
export function deriveProcedureSteps(traces: Evidence[]): ProcedureStep[] {
  const origin = traces[0].origin;
  const blocks = new Map<string, string>(), entities = new Map<string, string>();
  const reference = (map: Map<string, string>, key: string, prefix: string) => {
    if (!map.has(key)) map.set(key, `${prefix}:${map.size}`);
    return map.get(key)!;
  };
  let windowRef: string | undefined, windowSequence = 0;
  return traces.map(trace => {
    const operation = parseOperation(trace.operation);
    const step: ProcedureStep = { operation: { ...operation } };
    delete step.operation.position; delete step.operation.entityId; delete step.operation.windowId;
    if (operation.position) {
      const p = operation.position;
      const ref = reference(blocks, `${Math.floor(p.x)}:${Math.floor(p.y)}:${Math.floor(p.z)}`, 'block');
      if (['PLACE', 'MOVE', 'LOOK'].includes(operation.action) || !trace.blockName) {
        step.binding = { kind: 'relative', offset: {
          x: p.x - Math.floor(origin.x), y: p.y - Math.floor(origin.y), z: p.z - Math.floor(origin.z),
        }, ...(operation.action === 'PLACE' ? { ref } : {}) };
      } else step.binding = { kind: 'block', name: trace.blockName, ref };
    }
    if (operation.entityId != null) {
      if (!trace.entityName) throw new Error('procedure_unknown_entity_binding');
      step.binding = { kind: 'entity', name: trace.entityName,
        ref: reference(entities, `${operation.entityId}:${trace.entityName}`, 'entity') };
    }
    if (operation.action === 'OPEN') {
      windowRef = `window:${windowSequence++}`;
      step.opensWindowRef = windowRef;
    } else if (['TRANSFER', 'CLOSE'].includes(operation.action) ||
        (operation.action === 'WAIT' && operation.until === 'window_changed')) {
      windowRef ??= `window:${windowSequence++}`;
      step.windowBinding = { ref: windowRef, type: String(trace.window.type), open: trace.window.open };
    }
    if (operation.action === 'TRANSFER') {
      step.windowType = String(trace.window.type);
      const source = trace.window.slots[operation.sourceSlot!];
      const destination = trace.window.slots[operation.destinationSlot!];
      if (!source?.item || !destination || (operation.item && operation.item !== source.item)) {
        throw new Error('procedure_missing_slot_evidence');
      }
      // Even an omitted item argument must not later move unrelated container contents.
      step.operation.item = source.item;
      if (source.zone === 'inventory') { step.sourceItem = source.item; delete step.operation.sourceSlot; }
      else step.sourceRole = source.role;
      if (destination.zone === 'inventory') { step.destinationInventory = true; delete step.operation.destinationSlot; }
      else step.destinationRole = destination.role;
    }
    if (operation.action === 'CLOSE') windowRef = undefined;
    if (operation.action === 'WAIT' && (operation.durationMs ?? 5000) > 10000) throw new Error('procedure_wait_too_long');
    return step;
  });
}

type ReplayState = {
  blocks: Map<string, Vec3>;
  entities: Map<string, { id: number; uuid: string | undefined; object: unknown }>;
  windows: Map<string, unknown>;
};
// Keep the public Map argument compatible with existing callers. All identities
// are scoped to that one replay; none of these runtime references are persisted.
const replayStates = new WeakMap<Map<string, number>, ReplayState>();
function stateFor(bindings: Map<string, number>): ReplayState {
  let state = replayStates.get(bindings);
  if (!state) {
    state = { blocks: new Map(), entities: new Map(), windows: new Map() };
    replayStates.set(bindings, state);
  }
  return state;
}
const vec = (p: { x: number; y: number; z: number }) => new Vec3(p.x, p.y, p.z);
const finitePosition = (p: any): boolean => Boolean(p && [p.x, p.y, p.z].every(Number.isFinite));

export function bindProcedureStep(
  step: ProcedureStep, bot: mineflayer.Bot, anchor: Vec3, bindings: Map<string, number>,
): PrimitiveOperation {
  const op = { ...step.operation }, state = stateFor(bindings);
  if (step.binding?.kind === 'relative') {
    if (!finitePosition(anchor) || !finitePosition(step.binding.offset)) reject('relative_position_invalid');
    op.position = anchor.plus(vec(step.binding.offset));
    if (step.binding.ref) state.blocks.set(step.binding.ref, vec(op.position));
  }
  if (step.binding?.kind === 'block') {
    const { name } = step.binding, key = step.binding.ref ?? `legacy:block:${name}`;
    let position = state.blocks.get(key);
    if (!position) {
      // Mineflayer scan predicates may be called without a concrete position.
      // Do visibility checks only after blockAt resolves a concrete candidate.
      const positions = bot.findBlocks({ matching: b => b.name === name, maxDistance: 16, count: 128 });
      const candidates = positions.map(p => bot.blockAt(p)).filter(b => b && b.name === name &&
        finitePosition(b.position) && bot.canSeeBlock(b) &&
        ![...state.blocks.entries()].some(([other, p]) => other !== key && p.equals(b.position)));
      candidates.sort((a, b) => bot.entity.position.distanceTo(a!.position) - bot.entity.position.distanceTo(b!.position));
      const selected = candidates[0];
      if (!selected) reject(`block_precondition_missing:${name}`);
      position = vec(selected!.position); state.blocks.set(key, position);
    }
    const block = bot.blockAt(position!);
    if (!block || block.name !== name || !bot.canSeeBlock(block)) reject(`bound_block_changed_or_unseen:${name}`);
    op.position = { x: position!.x, y: position!.y, z: position!.z };
  }
  if (step.binding?.kind === 'entity') {
    const { name } = step.binding, key = step.binding.ref ?? `legacy:entity:${name}`;
    let selected = state.entities.get(key);
    if (!selected) {
      const reserved = new Set([...state.entities.values()].map(e => e.id));
      const candidates = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.name === name &&
        finitePosition(e.position) && bot.entity.position.distanceTo(e.position) <= 32 && !reserved.has(e.id));
      candidates.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
      const entity = candidates[0];
      if (!entity) reject(`entity_precondition_missing:${name}`);
      selected = { id: entity.id, uuid: entity.uuid, object: entity };
      state.entities.set(key, selected); bindings.set(key, entity.id);
    }
    const current = bot.entities[selected.id];
    if (!current || current === bot.entity || current.name !== name || current.uuid !== selected.uuid ||
        (selected.uuid == null && current !== selected.object) || !finitePosition(current.position)) {
      reject('bound_entity_disappeared_or_replaced');
    }
    op.entityId = selected.id;
  }
  if (step.windowBinding) {
    const win = bot.currentWindow ?? bot.inventory, expected = step.windowBinding;
    if (Boolean(bot.currentWindow) !== expected.open || String(win.type) !== expected.type) reject('window_precondition_changed');
    const bound = state.windows.get(expected.ref);
    if (bound && bound !== win) reject('bound_window_replaced');
    state.windows.set(expected.ref, win);
  }
  if (op.action === 'CLOSE') {
    // Old templates have no close-window evidence. Never close an unrelated UI.
    if (!step.windowBinding && bot.currentWindow) reject('close_window_evidence_missing');
    op.windowId = (bot.currentWindow ?? bot.inventory).id;
  }
  if (op.action === 'TRANSFER') bindTransfer(step, op, bot, state);
  return parseOperation(op);
}

/** Call only after a verified OPEN. This pins the actual window object so a
 * replacement with the same numeric ID/type cannot be silently adopted. */
export function completeProcedureStepBinding(step: ProcedureStep, bot: mineflayer.Bot, bindings: Map<string, number>): void {
  if (!step.opensWindowRef) return;
  if (!bot.currentWindow) reject('opened_window_missing');
  stateFor(bindings).windows.set(step.opensWindowRef, bot.currentWindow);
}

function bindTransfer(step: ProcedureStep, op: PrimitiveOperation, bot: mineflayer.Bot, state: ReplayState): void {
  const win = bot.currentWindow ?? bot.inventory;
  if (String(win.type) !== step.windowType) reject('window_precondition_changed');
  if (!step.windowBinding) {
    const key = `legacy:window:${step.windowType}`;
    const bound = state.windows.get(key);
    if (bound && bound !== win) reject('bound_window_replaced');
    state.windows.set(key, win);
  }
  if ((win as any).selectedItem) reject('cursor_not_empty');
  op.windowId = win.id;
  const count = op.count ?? 1;
  const inInventory = (index: number) => index >= win.inventoryStart && index < win.inventoryEnd;
  if (step.sourceItem) {
    const slot = win.slots.findIndex((item, index) => inInventory(index) && item != null &&
      item.name === step.sourceItem && item.count >= count);
    if (slot < 0) reject('inventory_item_missing');
    op.sourceSlot = slot;
  }
  const source = op.sourceSlot == null ? null : win.slots[op.sourceSlot];
  if (!source || (op.item && source.name !== op.item) || source.count < count) reject('source_item_or_count_changed');
  op.item = source!.name;
  const compatible = (item: any) => !item || (item.type === source!.type && item.metadata === source!.metadata &&
    JSON.stringify(item.nbt) === JSON.stringify(source!.nbt));
  const space = (item: any) => (item?.count ?? 0) + count <= source!.stackSize;
  if (step.destinationInventory) {
    const slot = win.slots.findIndex((item, index) => inInventory(index) && index !== op.sourceSlot && compatible(item) && space(item));
    if (slot < 0) reject('inventory_full');
    op.destinationSlot = slot;
  }
  if (op.destinationSlot == null || op.destinationSlot === op.sourceSlot ||
      op.destinationSlot < 0 || op.destinationSlot >= win.slots.length) reject('destination_slot_invalid');
  const destination = win.slots[op.destinationSlot!];
  if (!compatible(destination) || !space(destination)) reject('destination_incompatible_or_full');
  const snapshot = windowSnapshot(bot);
  if (step.sourceRole != null && snapshot.slots[op.sourceSlot!]?.role !== step.sourceRole) reject('source_slot_role_changed');
  if (step.destinationRole != null && snapshot.slots[op.destinationSlot!]?.role !== step.destinationRole) reject('destination_slot_role_changed');
}
