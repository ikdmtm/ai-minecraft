import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { Movements, goals } from 'mineflayer-pathfinder';
import { z } from 'zod';
import type { WorldProvenance } from './worldProvenance.js';

/** Game controls, not goals or recipes for surviving a particular world. */
export const PRIMITIVE_VERBS = [
  'MOVE', 'LOOK', 'BREAK', 'PLACE', 'ATTACK', 'EQUIP', 'USE',
  'INTERACT_BLOCK', 'INTERACT_ENTITY', 'OPEN', 'CLOSE', 'TRANSFER', 'CRAFT', 'WAIT',
] as const;
const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
const operationSchema = z.object({
  action: z.enum(PRIMITIVE_VERBS),
  position: positionSchema.nullable().optional(),
  entityId: z.number().int().nonnegative().nullable().optional(),
  item: z.string().regex(/^[a-z0-9_:.\/-]+$/).max(128).nullable().optional(),
  count: z.number().int().min(1).max(64).nullable().optional(),
  sourceSlot: z.number().int().min(0).max(255).nullable().optional(),
  destinationSlot: z.number().int().min(0).max(255).nullable().optional(),
  windowId: z.number().int().min(0).max(255).nullable().optional(),
  durationMs: z.number().int().min(100).max(60000).nullable().optional(),
  until: z.enum(['timeout', 'daylight', 'night', 'inventory_changed', 'window_changed']).nullable().optional(),
}).strict();
export type PrimitiveOperation = {
  action: typeof PRIMITIVE_VERBS[number];
  position?: { x: number; y: number; z: number };
  entityId?: number;
  item?: string;
  count?: number;
  sourceSlot?: number;
  destinationSlot?: number;
  windowId?: number;
  durationMs?: number;
  until?: 'timeout' | 'daylight' | 'night' | 'inventory_changed' | 'window_changed';
};
export function parseOperation(value: unknown): PrimitiveOperation {
  const parsed = operationSchema.parse(value);
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value != null)) as PrimitiveOperation;
}
/** All fields required + null is intentional for strict model structured output. */
export const OPERATION_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: [...PRIMITIVE_VERBS] },
    position: { anyOf: [{ type: 'object', additionalProperties: false, properties: {
      x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
    }, required: ['x', 'y', 'z'] }, { type: 'null' }] },
    entityId: { type: ['integer', 'null'] }, item: { type: ['string', 'null'] },
    count: { type: ['integer', 'null'] }, sourceSlot: { type: ['integer', 'null'] },
    destinationSlot: { type: ['integer', 'null'] }, windowId: { type: ['integer', 'null'] },
    durationMs: { type: ['integer', 'null'] }, until: { type: ['string', 'null'],
      enum: ['timeout', 'daylight', 'night', 'inventory_changed', 'window_changed', null] },
  },
  required: ['action', 'position', 'entityId', 'item', 'count', 'sourceSlot', 'destinationSlot', 'windowId', 'durationMs', 'until'],
};

export function foodSpec(bot: mineflayer.Bot, name: string): any | undefined {
  // foods may inherit older numeric IDs; names are the stable lookup key.
  return (bot.registry as any).foodsByName?.[name];
}
export function windowSnapshot(bot: mineflayer.Bot) {
  const win = bot.currentWindow ?? bot.inventory;
  const registryWindow = (bot.registry as any).windows?.[win.type] ??
    (/furnace|smoker/.test(String(win.type)) ? (bot.registry as any).windows?.['minecraft:furnace'] : undefined);
  return {
    id: win.id, type: win.type, open: Boolean(bot.currentWindow),
    inventoryStart: win.inventoryStart, inventoryEnd: win.inventoryEnd,
    cursor: (win as any).selectedItem ? { name: (win as any).selectedItem.name, count: (win as any).selectedItem.count } : null,
    slots: win.slots.map((item, index) => ({
      index, zone: index >= win.inventoryStart && index < win.inventoryEnd ? 'inventory' : 'container',
      role: registryWindow?.slots?.find((entry: any) => entry.index === index)?.name ?? null,
      item: item?.name ?? null, count: item?.count ?? 0,
    })),
  };
}
export function inventorySignature(bot: mineflayer.Bot): string {
  return bot.inventory.items().map(i => `${i.name}:${i.count}`).sort().join('|');
}
export function windowSignature(bot: mineflayer.Bot): string {
  const w = bot.currentWindow ?? bot.inventory;
  return `${w.id}:${w.type}:` + w.slots.map(i => i ? `${i.name}:${i.count}` : '-').join('|');
}
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`operation_missing:${name}`);
  return value;
}
function asVec(pos: { x: number; y: number; z: number }): Vec3 { return new Vec3(pos.x, pos.y, pos.z); }
function stackCount(bot: mineflayer.Bot, name: string): number {
  return bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
}

export interface OperationContext {
  assertActive: () => void;
  provenance?: WorldProvenance;
}
/** All sequences are AI-selected. Adapter invariants do not choose a survival plan. */
export async function executePrimitiveOperation(
  bot: mineflayer.Bot, value: unknown, context: OperationContext,
): Promise<string> {
  const op = parseOperation(value);
  const check = context.assertActive;
  const cleanupIfOwned = (fn: () => void) => { try { check(); fn(); } catch { /* the replacing action owns controls now */ } };
  const step = async <T>(promise: Promise<T>): Promise<T> => { check(); const result = await promise; check(); return result; };
  const target = () => asVec(need(op.position, 'position')).floored();
  const block = () => {
    const b = bot.blockAt(target());
    if (!b || /^(air|cave_air|void_air)$/.test(b.name)) throw new Error('operation_target_missing_or_unloaded');
    return b;
  };
  const reach = (p: Vec3) => {
    if (bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.5) {
      throw new Error('operation_out_of_reach:move_first');
    }
  };
  const item = () => {
    const found = bot.inventory.items().find(i => i.name === need(op.item, 'item'));
    if (!found) throw new Error(`operation_item_missing:${op.item}`);
    return found;
  };
  check();
  switch (op.action) {
    case 'MOVE': {
      const p = target();
      if (p.distanceTo(bot.entity.position) > 64) throw new Error('operation_move_segment_too_long');
      if (!bot.blockAt(p)) throw new Error('operation_move_target_unloaded');
      const movement = new Movements(bot);
      movement.canDig = false;
      movement.allow1by1towers = false;
      movement.allowParkour = false;
      movement.scafoldingBlocks = [];
      bot.pathfinder.setMovements(movement);
      await step(bot.pathfinder.goto(new goals.GoalBlock(p.x, p.y, p.z)));
      if (!bot.entity.position.floored().equals(p)) throw new Error('operation_move_not_arrived');
      break;
    }
    case 'LOOK': await step(bot.lookAt(asVec(need(op.position, 'position')), true)); break;
    case 'EQUIP': await step(bot.equip(item(), 'hand')); break;
    case 'BREAK': {
      const b = block(); reach(b.position);
      if (!bot.canSeeBlock(b) || !bot.canDigBlock(b)) throw new Error('operation_block_not_diggable_or_visible');
      const feet = bot.entity.position;
      if (b.position.y === Math.floor(feet.y) - 1 &&
          Math.abs(feet.x - (b.position.x + 0.5)) < 0.8 && Math.abs(feet.z - (b.position.z + 0.5)) < 0.8) {
        throw new Error('operation_removes_current_support:reposition_first');
      }
      await step(bot.dig(b));
      if (bot.blockAt(b.position)?.stateId === b.stateId) throw new Error('operation_break_unconfirmed');
      context.provenance?.forget(b.position);
      break;
    }
    case 'PLACE': {
      const held = item(); const p = target(); reach(p);
      const old = bot.blockAt(p);
      if (!old || old.boundingBox !== 'empty' || /water|lava|bubble_column/.test(old.name)) throw new Error('operation_place_occupied_or_unloaded');
      const e = bot.entity.position;
      if (p.x + 1 > e.x - 0.3 && p.x < e.x + 0.3 && p.z + 1 > e.z - 0.3 && p.z < e.z + 0.3 && p.y + 1 > e.y && p.y < e.y + 1.8) {
        throw new Error('operation_place_intersects_player');
      }
      await step(bot.equip(held, 'hand'));
      const offsets = [new Vec3(0, -1, 0), new Vec3(-1, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(0, 1, 0)];
      let placed = false;
      const failures: string[] = [];
      for (const offset of offsets) {
        check(); const reference = bot.blockAt(p.plus(offset));
        if (!reference || reference.boundingBox !== 'block' || !bot.canSeeBlock(reference)) continue;
        try {
          bot.setControlState('sneak', true);
          await step(bot.placeBlock(reference, offset.scaled(-1)));
          const current = bot.blockAt(p);
          if (current && current.stateId !== old.stateId) { placed = true; break; }
        } catch (error) {
          check(); failures.push(`${reference.position}: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally { cleanupIfOwned(() => bot.setControlState('sneak', false)); }
      }
      if (!placed) throw new Error(`operation_place_unconfirmed:target=${p}:player=${bot.entity.position}:held=${bot.heldItem?.name ?? 'none'}:faces=${failures.join(';') || 'no_visible_solid_reference'}`);
      context.provenance?.markPlaced(p, 'utility');
      break;
    }
    case 'ATTACK':
    case 'INTERACT_ENTITY': {
      const entity = bot.entities[need(op.entityId, 'entityId')];
      if (!entity || entity === bot.entity) throw new Error('operation_entity_missing');
      if (bot.entity.position.distanceTo(entity.position) > 3.5) throw new Error('operation_entity_out_of_reach');
      if (op.action === 'INTERACT_ENTITY') await step(bot.activateEntity(entity));
      else { bot.attack(entity); await step(sleep(650)); }
      // Sending an attack is not evidence of a kill; outcome snapshots record the actual result.
      break;
    }
    case 'USE': {
      const held = item(); await step(bot.equip(held, 'hand'));
      if (foodSpec(bot, held.name)) {
        if (bot.food >= 20 && !held.name.includes('golden_apple') && held.name !== 'chorus_fruit') throw new Error('operation_food_bar_full');
        await step(bot.consume());
      } else {
        bot.activateItem();
        try { await step(sleep(Math.min(op.durationMs ?? 500, 5000))); }
        finally { cleanupIfOwned(() => bot.deactivateItem()); }
      }
      break;
    }
    case 'OPEN': {
      if (bot.currentWindow) throw new Error('operation_window_already_open:close_first');
      const b = block(); reach(b.position);
      if (!bot.canSeeBlock(b)) throw new Error('operation_block_not_visible');
      const opening = bot.openBlock(b);
      // A late windowOpen after cancellation must not leak a stale interface into the next action.
      opening.then(w => { try { check(); } catch { if (bot.currentWindow === w) bot.closeWindow(w); } }, () => {});
      await step(opening);
      if (!bot.currentWindow) throw new Error('operation_window_not_opened');
      break;
    }
    case 'CLOSE': {
      if (bot.currentWindow) {
        if (op.windowId != null && bot.currentWindow.id !== op.windowId) throw new Error('operation_stale_window');
        await step(Promise.resolve(bot.closeWindow(bot.currentWindow)));
      }
      break;
    }
    case 'INTERACT_BLOCK': {
      const b = block(); reach(b.position);
      if (!bot.canSeeBlock(b)) throw new Error('operation_block_not_visible');
      if (b.name.endsWith('_bed')) {
        if (String(bot.game.dimension).includes('nether') || String(bot.game.dimension).includes('end')) throw new Error('operation_bed_explodes_in_dimension');
        await step(bot.sleep(b));
      } else await step(bot.activateBlock(b));
      break;
    }
    case 'TRANSFER': {
      const w = bot.currentWindow ?? bot.inventory;
      if (need(op.windowId, 'windowId') !== w.id) throw new Error('operation_stale_window');
      const source = need(op.sourceSlot, 'sourceSlot'), destination = need(op.destinationSlot, 'destinationSlot');
      if (source === destination || source >= w.slots.length || destination >= w.slots.length) throw new Error('operation_invalid_slots');
      if ((w as any).selectedItem) throw new Error('operation_cursor_not_empty');
      const sourceItem = w.slots[source];
      if (!sourceItem || (op.item && sourceItem.name !== op.item)) throw new Error('operation_source_item_changed');
      const count = op.count ?? 1; if (count > sourceItem.count) throw new Error('operation_source_count_insufficient');
      const dst = w.slots[destination];
      if (dst && (dst.type !== sourceItem.type || dst.metadata !== sourceItem.metadata || JSON.stringify(dst.nbt) !== JSON.stringify(sourceItem.nbt))) throw new Error('operation_destination_incompatible');
      if ((dst?.count ?? 0) + count > sourceItem.stackSize) throw new Error('operation_destination_full');
      const role = windowSnapshot(bot).slots[destination].role;
      if (role === 'result' || role === 'output') throw new Error('operation_destination_read_only');
      const before = dst?.count ?? 0, sourceBefore = sourceItem.count;
      await step(bot.transfer({ window: w, itemType: sourceItem.type, metadata: sourceItem.metadata,
        sourceStart: source, sourceEnd: source + 1, destStart: destination, destEnd: destination + 1, count }));
      if ((bot.currentWindow ?? bot.inventory) !== w) throw new Error('operation_window_changed_during_transfer');
      // Fuel/input can be consumed by the server immediately after transfer.
      const removed = sourceBefore - (w.slots[source]?.count ?? 0);
      if ((w.slots[destination]?.count ?? 0) < before + count && removed < count) throw new Error('operation_transfer_unconfirmed');
      break;
    }
    case 'CRAFT': {
      if (bot.currentWindow) throw new Error('operation_close_window_before_craft');
      const name = need(op.item, 'item'); const id = bot.registry.itemsByName[name]?.id;
      if (id == null) throw new Error('operation_unknown_recipe_item');
      const table = bot.findBlock({ matching: b => b.name === 'crafting_table' && bot.canSeeBlock(b), maxDistance: 4 });
      const recipes = bot.recipesFor(id, null, 1, table);
      if (!recipes.length) throw new Error('operation_recipe_not_executable');
      const before = stackCount(bot, name);
      // Exactly one craft invocation. The agent chooses repetitions rather than an implicit resource plan.
      if ((op.count ?? 1) > 16) throw new Error('operation_craft_batch_too_large');
      await step(bot.craft(recipes[0], op.count ?? 1, table ?? undefined));
      if (stackCount(bot, name) <= before) throw new Error('operation_craft_unconfirmed');
      break;
    }
    case 'WAIT': {
      const initialInventory = inventorySignature(bot), initialWindow = windowSignature(bot);
      const initialHp = bot.health, initialHunger = bot.food;
      const until = op.until ?? 'timeout';
      const deadline = Date.now() + (op.durationMs ?? 5000);
      while (Date.now() < deadline) {
        check();
        if (bot.health < initialHp || (bot.food < initialHunger && bot.food <= 6)) throw new Error('operation_wait_needs_replan');
        const night = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay < 23500;
        if ((until === 'daylight' && !night) || (until === 'night' && night) ||
            (until === 'inventory_changed' && initialInventory !== inventorySignature(bot)) ||
            (until === 'window_changed' && initialWindow !== windowSignature(bot))) return `condition_satisfied:${until}`;
        await sleep(100);
      }
      return until === 'timeout' ? 'wait_elapsed' : `condition_timeout:${until}`;
    }
  }
  return `operation_completed:${op.action}`;
}

/** Compact physical observation: local occupancy is not a pre-solved construction plan. */
export function localGridSnapshot(bot: mineflayer.Bot) {
  const origin = bot.entity.position.floored().offset(-2, -1, -2);
  const palette: Array<{ name: string; boundingBox: string; properties: unknown }> = [];
  const states = new Map<number, number>();
  const cells: number[] = [];
  for (let y = 0; y < 5; y++) for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) {
    const block = bot.blockAt(origin.offset(x, y, z));
    if (!block) { cells.push(-1); continue; }
    let index = states.get(block.stateId);
    if (index == null) {
      index = palette.length; states.set(block.stateId, index);
      palette.push({ name: block.name, boundingBox: block.boundingBox, properties: block.getProperties() });
    }
    cells.push(index);
  }
  return { origin, size: [5, 5, 5], indexing: 'cells[(dy*5+dz)*5+dx]; -1=unloaded', palette, cells };
}
