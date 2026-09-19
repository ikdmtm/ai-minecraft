import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { inventorySignature, windowSignature, windowSnapshot, type PrimitiveOperation } from './primitiveOperations.js';

export interface EffectAssessment {
  verified: boolean;
  outcome: 'effect_observed' | 'already_satisfied' | 'effect_unconfirmed' | 'condition_timeout';
  reason: string;
}

/** Snapshot values, not mutable entity/slot references. This is evidence about
 * an operation, not a survival policy or proof of causal attribution. */
export function observeOperation(bot: mineflayer.Bot, op: PrimitiveOperation) {
  const inventoryCounts: Record<string, number> = {};
  for (const item of bot.inventory.items()) inventoryCounts[item.name] = (inventoryCounts[item.name] ?? 0) + item.count;
  const b = op.position ? bot.blockAt(new Vec3(op.position.x, op.position.y, op.position.z)) : null;
  const entity = op.entityId != null ? bot.entities[op.entityId] : null;
  const window = windowSnapshot(bot);
  return {
    hp: bot.health, hunger: bot.food,
    inventory: inventorySignature(bot), inventoryCounts,
    window: windowSignature(bot), windowId: window.id, windowType: window.type, windowOpen: window.open,
    slots: window.slots.map(slot => ({ item: slot.item, count: slot.count })),
    block: b ? `${b.name}:${b.stateId}` : null, blockName: b?.name ?? null,
    position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
    yaw: bot.entity.yaw, pitch: bot.entity.pitch,
    held: bot.heldItem?.name, sleeping: bot.isSleeping,
    entityIdentity: entity ? `${entity.id}:${entity.uuid ?? ''}:${entity.name ?? ''}` : null,
    entityMetadata: entity ? JSON.stringify(entity.metadata ?? null) : null,
  };
}
export type OperationObservation = ReturnType<typeof observeOperation>;

const observed = (reason: string): EffectAssessment => ({ verified: true, outcome: 'effect_observed', reason });
const satisfied = (reason: string): EffectAssessment => ({ verified: true, outcome: 'already_satisfied', reason });
const unknown = (reason: string): EffectAssessment => ({ verified: false, outcome: 'effect_unconfirmed', reason });
const air = (name: string | null) => name != null && ['air', 'cave_air', 'void_air'].includes(name);

/** Called only after an adapter reports completion in the same spatial lease.
 * No change/insufficient observation is NOT evidence that the action failed.
 * An already-satisfied postcondition is explicit and does not claim progress. */
export function assessOperationEffect(
  op: PrimitiveOperation, before: OperationObservation, after: OperationObservation,
  targetHurtObserved: boolean, detail: string,
): EffectAssessment {
  const count = (state: OperationObservation) => op.item ? state.inventoryCounts[op.item] ?? 0 : 0;
  const changedBlock = before.block != null && after.block != null && before.block !== after.block;
  switch (op.action) {
    case 'ATTACK':
      return targetHurtObserved ? observed('target_hurt_observed_not_kill') : unknown('target_hurt_not_observed');
    case 'MOVE': {
      const atTarget = (s: OperationObservation) => op.position != null &&
        Math.floor(s.position.x) === Math.floor(op.position.x) &&
        Math.floor(s.position.y) === Math.floor(op.position.y) &&
        Math.floor(s.position.z) === Math.floor(op.position.z);
      if (!atTarget(after)) return unknown('requested_position_not_observed');
      return atTarget(before) ? satisfied('already_at_requested_position') : observed('arrived_at_requested_position');
    }
    case 'LOOK':
      return Math.abs(after.yaw - before.yaw) + Math.abs(after.pitch - before.pitch) > 0.0001
        ? observed('orientation_changed') : unknown('orientation_change_not_observed');
    case 'EQUIP':
      if (!op.item || after.held !== op.item) return unknown('requested_held_item_not_observed');
      return before.held === op.item ? satisfied('requested_item_already_equipped') : observed('requested_item_equipped');
    case 'BREAK':
      // Chunk unloading and an unrelated replacement block do not prove a break.
      return changedBlock && !air(before.blockName) && air(after.blockName)
        ? observed('target_block_removed') : unknown('target_removal_not_observed');
    case 'PLACE':
      // Name-changing placements (for example seeds -> crop) need a separate
      // specification-aware check. Until then retain uncertainty, never a failure.
      return changedBlock && air(before.blockName) && after.blockName === op.item
        ? observed('requested_block_appeared') : unknown('requested_placement_not_observed');
    case 'OPEN':
      return !before.windowOpen && after.windowOpen
        ? observed('window_opened') : unknown('new_window_not_observed');
    case 'CLOSE':
      if (after.windowOpen) return unknown('window_still_open');
      if (!before.windowOpen) return satisfied('window_already_closed');
      return op.windowId == null || op.windowId === before.windowId
        ? observed('requested_window_closed') : unknown('different_window_closed');
    case 'TRANSFER': {
      if (before.windowId !== after.windowId || before.windowType !== after.windowType ||
          before.windowOpen !== after.windowOpen || op.windowId !== before.windowId) return unknown('window_context_changed');
      const source = op.sourceSlot == null ? undefined : before.slots[op.sourceSlot];
      const remaining = op.sourceSlot == null ? undefined : after.slots[op.sourceSlot];
      if (!source?.item || !remaining || (op.item != null && source.item !== op.item)) return unknown('source_not_observed');
      if (remaining.item != null && remaining.item !== source.item) return unknown('source_replaced');
      // The server can immediately consume transferred fuel/input. A source
      // decrement is the conservative confirmation used by the adapter too.
      return source.count - remaining.count >= (op.count ?? 1)
        ? observed('requested_source_decrement_observed') : unknown('requested_transfer_not_observed');
    }
    case 'CRAFT':
      return op.item && count(after) > count(before)
        ? observed('requested_craft_output_increased') : unknown('requested_craft_output_not_observed');
    case 'USE':
      // Generic hunger, HP or unrelated inventory changes are not evidence that
      // the selected item was used. Non-consuming uses can remain unconfirmed.
      return op.item && count(after) < count(before)
        ? observed('selected_item_consumed') : unknown('selected_item_effect_not_observed');
    case 'INTERACT_BLOCK':
      return changedBlock || (before.sleeping !== after.sleeping && after.sleeping === true) ||
        (!before.windowOpen && after.windowOpen)
        ? observed('target_block_interaction_change') : unknown('target_block_interaction_unconfirmed');
    case 'INTERACT_ENTITY':
      return before.entityIdentity != null && before.entityIdentity === after.entityIdentity &&
        before.entityMetadata !== after.entityMetadata
        ? observed('target_entity_metadata_changed') : unknown('target_entity_interaction_unconfirmed');
    case 'WAIT': {
      const condition = op.until ?? 'timeout';
      if (condition === 'timeout' && detail === 'wait_elapsed') return observed('requested_wait_elapsed');
      if (condition !== 'timeout' && detail === `condition_satisfied:${condition}`) return observed(`condition_satisfied:${condition}`);
      if (detail === `condition_timeout:${condition}`) return { verified: false, outcome: 'condition_timeout', reason: 'condition_not_observed_before_deadline' };
      return unknown('wait_condition_unconfirmed');
    }
  }
}
