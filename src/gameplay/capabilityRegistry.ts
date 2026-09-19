import type mineflayer from 'mineflayer';
import type {
  ExecutiveCapabilitySnapshot,
  ExecutiveActionCapability,
  SemanticTarget,
} from './executiveTypes.js';

const PROCESSING_TYPES = new Set(['furnace', 'smoker']);

export class CapabilityRegistry {
  private craftCacheKey = '';
  private craftCache: ExecutiveCapabilitySnapshot['craft'] = [];
  private recipeGraph: Array<{
    item: string;
    requiresTable: boolean;
    resultCount: number;
    ingredients: Array<{ item: string; count: number }>;
  }> | null = null;

  constructor(private readonly bot: mineflayer.Bot) {}

  capture(
    targets: SemanticTarget[],
    strategyText: string,
  ): ExecutiveCapabilitySnapshot {
    const gatherByResource = new Map<string, {
      resource: string;
      targetIds: string[];
      sourceBlocks: string[];
    }>();

    for (const target of targets) {
      if (target.kind !== 'resource_source') continue;
      const resource = stringMeta(target, 'resource');
      const blockName = stringMeta(target, 'blockName');
      if (!resource || !blockName) continue;
      const entry = gatherByResource.get(resource) ?? {
        resource,
        targetIds: [],
        sourceBlocks: [],
      };
      if (!entry.targetIds.includes(target.id)) entry.targetIds.push(target.id);
      if (!entry.sourceBlocks.includes(blockName)) entry.sourceBlocks.push(blockName);
      gatherByResource.set(resource, entry);
    }

    const gather = [...gatherByResource.values()]
      .sort((a, b) => a.resource.localeCompare(b.resource))
      .slice(0, 40);
    const craft = this.discoverCraftableItems(strategyText);
    const recipes = this.discoverReachableRecipes(gather, strategyText);

    const entityActions = targets
      .filter(target => target.kind === 'entity')
      .map(target => ({
        targetId: target.id,
        entity: stringMeta(target, 'entityName') ?? 'unknown',
        hostile: Boolean(target.metadata.hostile),
        actions: ['NAVIGATE_TARGET', 'ATTACK_TARGET'] as const,
      }))
      .slice(0, 20);

    return {
      itemSpecs: this.discoverItemSpecs(),
      blockSpecs: this.discoverBlockSpecs(),
      gather,
      craft,
      recipes,
      actions: this.discoverAffordances(targets, craft, recipes),
      entityActions,
      canExcavate: targets.some(target => target.kind === 'excavation_site'),
    };
  }

  private discoverItemSpecs(): ExecutiveCapabilitySnapshot['itemSpecs'] {
    return this.bot.inventory.items()
      .map(item => {
        const data = (this.bot.registry.items as any)?.[item.type] ?? {};
        const placeable = (this.bot.registry.blocksByName as any)?.[item.name];
        const foodPoints = Number(data.foodPoints ?? data.food_points);
        const saturation = Number(data.saturation ?? data.saturationModifier);
        const maxDurability = Number(data.maxDurability ?? data.max_durability);
        const stackSize = Number(data.stackSize ?? data.stack_size);
        return {
          name: item.name,
          count: item.count,
          stackSize: Number.isFinite(stackSize) ? stackSize : null,
          foodPoints: Number.isFinite(foodPoints) && foodPoints > 0 ? foodPoints : null,
          saturation: Number.isFinite(saturation) ? saturation : null,
          maxDurability: Number.isFinite(maxDurability) && maxDurability > 0 ? maxDurability : null,
          placeableBlock: placeable?.name ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private discoverBlockSpecs(): ExecutiveCapabilitySnapshot['blockSpecs'] {
    let positions: any[] = [];
    try {
      positions = this.bot.findBlocks({
        matching: block => block.name !== 'air',
        maxDistance: 10,
        count: 160,
      }) as any[];
    } catch {
      return [];
    }

    const byName = new Map<string, ExecutiveCapabilitySnapshot['blockSpecs'][number]>();
    for (const pos of positions) {
      const block = this.bot.blockAt(pos);
      if (!block || byName.has(block.name)) continue;
      byName.set(block.name, {
        name: block.name,
        diggable: Boolean(block.diggable),
        hardness: Number.isFinite(Number(block.hardness)) ? Number(block.hardness) : null,
        boundingBox: typeof block.boundingBox === 'string' ? block.boundingBox : null,
        declaredDrops: blockDropNames(this.bot, block),
      });
      if (byName.size >= 48) break;
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private discoverCraftableItems(strategyText: string): ExecutiveCapabilitySnapshot['craft'] {
    const nearbyTable = this.bot.findBlock({
      matching: block => block.name === 'crafting_table',
      maxDistance: 8,
    });
    const tableInInventory = this.bot.inventory.items().some(item => item.name === 'crafting_table');
    const inventoryKey = this.bot.inventory.items()
      .map(item => `${item.name}:${item.count}`)
      .sort()
      .join(',');
    const cacheKey = `${inventoryKey}|table=${Boolean(nearbyTable || tableInInventory)}|${strategyText}`;
    if (cacheKey === this.craftCacheKey) return this.craftCache;

    const tableAccess: any = nearbyTable ?? (tableInInventory ? true : null);
    const strategy = strategyText.toLowerCase();
    const results: Array<{
      item: string;
      requiresTable: boolean;
      recipeCount: number;
      owned: number;
      mentioned: boolean;
    }> = [];

    const itemsByName = this.bot.registry.itemsByName as Record<string, { id: number; name: string }>;
    for (const item of Object.values(itemsByName)) {
      let recipes: any[] = [];
      try {
        recipes = this.bot.recipesFor(item.id, null, 1, tableAccess);
      } catch {
        continue;
      }
      if (recipes.length === 0) continue;
      const readable = item.name.replace(/_/g, ' ');
      results.push({
        item: item.name,
        requiresTable: recipes.every(recipe => Boolean(recipe.requiresTable)),
        recipeCount: recipes.length,
        owned: inventoryCount(this.bot, item.name),
        mentioned: strategy.includes(item.name.toLowerCase()) || strategy.includes(readable),
      });
    }

    this.craftCache = results
      .sort((a, b) => Number(b.mentioned) - Number(a.mentioned) || a.item.localeCompare(b.item))
      .slice(0, 96)
      .map(({ item, requiresTable, recipeCount, owned }) => ({
        item,
        requiresTable,
        recipeCount,
        owned,
      }));
    this.craftCacheKey = cacheKey;
    return this.craftCache;
  }

  private discoverReachableRecipes(
    gather: ExecutiveCapabilitySnapshot['gather'],
    strategyText: string,
  ): ExecutiveCapabilitySnapshot['recipes'] {
    const graph = this.getRecipeGraph();
    const reachable = new Map<string, number>();
    for (const item of this.bot.inventory.items()) reachable.set(item.name, 0);
    for (const source of gather) reachable.set(source.resource, 0);

    const discovered = new Map<string, ExecutiveCapabilitySnapshot['recipes'][number]>();
    for (let depth = 1; depth <= 4; depth++) {
      let changed = false;
      for (const recipe of graph) {
        if (recipe.ingredients.length === 0) continue;
        if (!recipe.ingredients.every(ingredient => reachable.has(ingredient.item))) continue;
        const existingDepth = reachable.get(recipe.item);
        if (existingDepth == null || depth < existingDepth) {
          reachable.set(recipe.item, depth);
          changed = true;
        }
        const known = discovered.get(recipe.item);
        if (!known || depth < known.reachableDepth) {
          discovered.set(recipe.item, { ...recipe, reachableDepth: depth });
        }
      }
      if (!changed) break;
    }

    const strategy = strategyText.toLowerCase();
    return [...discovered.values()]
      .sort((a, b) => {
        const am = strategy.includes(a.item) || strategy.includes(a.item.replace(/_/g, ' '));
        const bm = strategy.includes(b.item) || strategy.includes(b.item.replace(/_/g, ' '));
        if (am !== bm) return am ? -1 : 1;
        return a.reachableDepth - b.reachableDepth || a.item.localeCompare(b.item);
      })
      .slice(0, 128);
  }

  private discoverAffordances(
    targets: SemanticTarget[],
    craft: ExecutiveCapabilitySnapshot['craft'],
    recipes: ExecutiveCapabilitySnapshot['recipes'],
  ): ExecutiveActionCapability[] {
    const actions: ExecutiveActionCapability[] = [];

    for (const target of targets) {
      if (
        target.distance > 1.5 &&
        target.kind !== 'entity' &&
        target.kind !== 'resource_source' &&
        target.kind !== 'item_drop'
      ) {
        actions.push({
          id: `move:${target.id}`,
          kind: 'move_to',
          description: `Move to semantic target ${target.id}.`,
          targetId: target.id,
          position: { ...target.position },
          preconditions: {
            distance: target.distance,
            risk: target.risk,
          },
          specification: {
            targetKind: target.kind,
          },
        });
      }

      if (target.kind === 'resource_source') {
        const blockTargetId = stringMeta(target, 'blockTargetId');
        const blockName = stringMeta(target, 'blockName');
        if (blockTargetId && blockName) {
          actions.push({
            id: `break:${blockTargetId}`,
            kind: 'break_block',
            description: `Break visible harvestable block ${blockName}.`,
            targetId: target.id,
            blockTargetId,
            position: { ...target.position },
            preconditions: {
              visible: true,
              harvestableNow: Boolean(target.metadata.harvestableNow),
              distance: target.distance,
            },
            specification: {
              blockName,
              declaredDrops: blockDropNamesAt(this.bot, target.position).join(','),
            },
          });
        }
      }

      if (target.kind === 'entity') {
        const entityTargetId = target.id;
        const entityName = stringMeta(target, 'entityName') ?? 'unknown';
        actions.push({
          id: `attack:${entityTargetId}`,
          kind: 'attack_entity',
          description: `Attack currently observed entity ${entityName}.`,
          targetId: target.id,
          entityTargetId,
          position: { ...target.position },
          preconditions: {
            distance: target.distance,
            hostile: Boolean(target.metadata.hostile),
          },
          specification: {
            entityName,
            entityKind: target.metadata.entityKind ?? null,
          },
        });
      }

      if (target.kind === 'item_drop') {
        actions.push({
          id: `collect:${target.id}`,
          kind: 'collect_drop',
          description: 'Move to the observed dropped item so normal pickup mechanics can collect it.',
          targetId: target.id,
          position: { ...target.position },
          preconditions: {
            distance: target.distance,
          },
          specification: {
            itemName: target.metadata.itemName ?? null,
          },
        });
      }
    }

    for (const item of this.bot.inventory.items()) {
      const data = (this.bot.registry.items as any)?.[item.type] ?? {};
      const foodPoints = Number(data.foodPoints ?? data.food_points ?? 0);
      if (foodPoints > 0) {
        actions.push({
          id: `use:${item.name}`,
          kind: 'use_item',
          description: `Use carried item ${item.name}.`,
          item: item.name,
          preconditions: {
            inventoryCount: item.count,
          },
          specification: {
            foodPoints,
            saturation: Number(data.saturation ?? data.saturationModifier ?? 0) || 0,
          },
        });
      }

      const placeableBlock = (this.bot.registry.blocksByName as any)?.[item.name];
      if (placeableBlock) {
        for (const position of this.findPlacementPositions().slice(0, 6)) {
          actions.push({
            id: `place:${item.name}:${position.x}:${position.y}:${position.z}`,
            kind: 'place_item',
            description: `Place carried block item ${item.name} at the specified reachable position.`,
            item: item.name,
            position,
            preconditions: {
              inventoryCount: item.count,
              reachable: true,
            },
            specification: {
              blockName: placeableBlock.name ?? item.name,
              hardness: Number(placeableBlock.hardness ?? 0) || 0,
            },
          });
        }
      }
    }

    const recipeByItem = new Map(recipes.map(recipe => [recipe.item, recipe]));
    for (const entry of craft) {
      const recipe = recipeByItem.get(entry.item);
      actions.push({
        id: `craft:${entry.item}`,
        kind: 'craft_recipe',
        description: `Craft ${entry.item} using an executable Minecraft recipe.`,
        item: entry.item,
        preconditions: {
          requiresTable: entry.requiresTable,
          recipeCount: entry.recipeCount,
        },
        specification: {
          owned: entry.owned,
          ingredients: recipe ? recipe.ingredients.map(i => `${i.item}:${i.count}`).join(',') : null,
          resultCount: recipe?.resultCount ?? null,
        },
      });
    }

    actions.push(...this.discoverBreakBlockAffordances());
    actions.push(...this.discoverProcessingAffordances());
    actions.push(...this.discoverInteractionAffordances());

    const time = this.bot.time.timeOfDay;
    if (time >= 12500 && time < 23500) {
      actions.push({
        id: 'wait:daylight',
        kind: 'wait_condition',
        description: 'Wait until Minecraft daylight, while allowing safety interruptions.',
        preconditions: { isNight: true },
        specification: { condition: 'daylight' },
      });
    } else {
      actions.push({
        id: 'wait:night',
        kind: 'wait_condition',
        description: 'Wait until Minecraft night, while allowing safety interruptions.',
        preconditions: { isNight: false },
        specification: { condition: 'night' },
      });
    }

    return dedupeAffordances(actions).slice(0, 96);
  }

  private findPlacementPositions(): Array<{ x: number; y: number; z: number }> {
    const base = this.bot.entity.position.floored();
    const candidates: Array<{ x: number; y: number; z: number; distance: number }> = [];
    for (let dy = -1; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const target = base.offset(dx, dy, dz);
          const block = this.bot.blockAt(target);
          if (!block || (block.name !== 'air' && block.boundingBox !== 'empty')) continue;
          const hasReference = [
            target.offset(1, 0, 0), target.offset(-1, 0, 0),
            target.offset(0, 1, 0), target.offset(0, -1, 0),
            target.offset(0, 0, 1), target.offset(0, 0, -1),
          ].some(pos => {
            const neighbor = this.bot.blockAt(pos);
            return Boolean(neighbor && neighbor.boundingBox === 'block');
          });
          if (!hasReference) continue;
          const distance = this.bot.entity.position.distanceTo(target);
          if (distance > 4.5) continue;
          candidates.push({
            x: target.x,
            y: target.y,
            z: target.z,
            distance,
          });
        }
      }
    }
    return candidates
      .sort((a, b) => a.distance - b.distance)
      .map(({ x, y, z }) => ({ x, y, z }));
  }

  private discoverBreakBlockAffordances(): ExecutiveActionCapability[] {
    let positions: any[] = [];
    try {
      positions = this.bot.findBlocks({
        matching: block =>
          Boolean(block?.diggable) &&
          block.name !== 'air' &&
          block.name !== 'water' &&
          block.name !== 'lava',
        maxDistance: 8,
        count: 120,
      }) as any[];
    } catch {
      return [];
    }

    const player = this.bot.entity.position;
    return positions
      .map(pos => this.bot.blockAt(pos))
      .filter((block): block is any => Boolean(block && block.diggable && this.bot.canSeeBlock(block)))
      .map(block => {
        const distance = player.distanceTo(block.position);
        const horizontal = Math.hypot(
          player.x - (block.position.x + 0.5),
          player.z - (block.position.z + 0.5),
        );
        const supportingPlayer =
          horizontal <= 0.9 &&
          block.position.y === Math.floor(player.y) - 1;
        return {
          id: `break:block:${block.name}:${block.position.x}:${block.position.y}:${block.position.z}`,
          kind: 'break_block' as const,
          description: `Break visible diggable block ${block.name}.`,
          blockTargetId: `block:${block.name}:${block.position.x}:${block.position.y}:${block.position.z}`,
          position: {
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
          },
          preconditions: {
            visible: true,
            distance: Math.round(distance * 10) / 10,
            supportingPlayer,
            canHarvestDropsNow: canHarvestBlockNow(this.bot, block),
          },
          specification: {
            blockName: block.name,
            hardness: Number.isFinite(Number(block.hardness)) ? Number(block.hardness) : null,
            declaredDrops: blockDropNames(this.bot, block).join(','),
          },
        };
      })
      .sort((a, b) => Number(a.preconditions.distance) - Number(b.preconditions.distance))
      .slice(0, 28);
  }

  private discoverProcessingAffordances(): ExecutiveActionCapability[] {
    const result: ExecutiveActionCapability[] = [];
    const rawRecipes = (this.bot.registry as any)?.recipes;
    if (!rawRecipes || typeof rawRecipes !== 'object') return result;

    const nearbyStations = new Map<string, any>();
    for (const type of PROCESSING_TYPES) {
      const block = this.bot.findBlock({
        matching: candidate => candidate.name === type,
        maxDistance: 8,
      });
      if (block) nearbyStations.set(type, block);
    }
    if (nearbyStations.size === 0) return result;

    const inventory = new Map(this.bot.inventory.items().map(item => [item.name, item.count]));
    for (const raw of Object.values(rawRecipes)) {
      const recipes = Array.isArray(raw) ? raw : [raw];
      for (const recipe of recipes as any[]) {
        const type = typeof recipe?.type === 'string' ? recipe.type : '';
        if (!PROCESSING_TYPES.has(type) || !nearbyStations.has(type)) continue;
        const inputIds = recipeItemIds(recipe?.input ?? recipe?.ingredients);
        const outputIds = recipeItemIds(recipe?.output ?? recipe?.result);
        for (const inputId of inputIds) {
          const inputName = (this.bot.registry.items as any)?.[inputId]?.name as string | undefined;
          if (!inputName || (inventory.get(inputName) ?? 0) <= 0) continue;
          const outputName = outputIds
            .map(id => (this.bot.registry.items as any)?.[id]?.name as string | undefined)
            .find(Boolean);
          result.push({
            id: `process:${type}:${inputName}:${outputName ?? 'unknown'}`,
            kind: 'process_recipe',
            description: `Process ${inputName} using nearby ${type} according to Minecraft recipe data.`,
            item: inputName,
            outputItem: outputName,
            station: type,
            position: nearbyStations.get(type)?.position,
            preconditions: {
              inputCount: inventory.get(inputName) ?? 0,
              stationNearby: true,
            },
            specification: {
              recipeType: type,
              outputItem: outputName ?? null,
            },
          });
        }
      }
    }
    return result;
  }

  private discoverInteractionAffordances(): ExecutiveActionCapability[] {
    let positions: any[] = [];
    try {
      positions = this.bot.findBlocks({
        matching: block => isInteractiveBlockName(block.name),
        maxDistance: 10,
        count: 24,
      }) as any[];
    } catch {
      return [];
    }

    return positions
      .map(pos => this.bot.blockAt(pos))
      .filter((block): block is any => Boolean(block && this.bot.canSeeBlock(block)))
      .map(block => ({
        id: `interact:${block.name}:${block.position.x}:${block.position.y}:${block.position.z}`,
        kind: 'interact_block' as const,
        description: `Interact with visible block ${block.name}.`,
        position: {
          x: block.position.x,
          y: block.position.y,
          z: block.position.z,
        },
        preconditions: {
          distance: Math.round(this.bot.entity.position.distanceTo(block.position) * 10) / 10,
          visible: true,
        },
        specification: {
          blockName: block.name,
        },
      }));
  }

  private getRecipeGraph(): Array<{
    item: string;
    requiresTable: boolean;
    resultCount: number;
    ingredients: Array<{ item: string; count: number }>;
  }> {
    if (this.recipeGraph) return this.recipeGraph;
    const recipes: Array<{
      item: string;
      requiresTable: boolean;
      resultCount: number;
      ingredients: Array<{ item: string; count: number }>;
    }> = [];
    const seen = new Set<string>();
    const itemsByName = this.bot.registry.itemsByName as Record<string, { id: number; name: string }>;

    for (const item of Object.values(itemsByName)) {
      let known: any[] = [];
      try {
        known = this.bot.recipesAll(item.id, null, true);
      } catch {
        continue;
      }
      for (const recipe of known) {
        const ingredients = recipeIngredients(this.bot, recipe);
        if (ingredients.length === 0) continue;
        const resultCount = Math.max(1, Number(recipe?.result?.count) || 1);
        const key = [
          item.name,
          recipe.requiresTable ? 'table' : 'inventory',
          resultCount,
          ingredients.map(entry => `${entry.item}:${entry.count}`).join(','),
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        recipes.push({
          item: item.name,
          requiresTable: Boolean(recipe.requiresTable),
          resultCount,
          ingredients,
        });
      }
    }
    this.recipeGraph = recipes;
    return recipes;
  }
}

export function blockDropNames(bot: mineflayer.Bot, block: any): string[] {
  const drops = Array.isArray(block?.drops)
    ? block.drops
    : Array.isArray((bot.registry.blocks as any)?.[block?.type]?.drops)
      ? (bot.registry.blocks as any)[block.type].drops
      : [];
  const ids = new Set<number>();
  for (const raw of drops) {
    const id = dropId(raw);
    if (id != null && id > 0) ids.add(id);
  }
  return [...ids]
    .map(id => (bot.registry.items as any)?.[id]?.name as string | undefined)
    .filter((name): name is string => Boolean(name));
}

export function canHarvestBlockNow(bot: mineflayer.Bot, block: any): boolean {
  if (!block?.diggable) return false;
  try {
    if (block.canHarvest(null)) return true;
  } catch {
    // Fall through.
  }
  for (const item of bot.inventory.items()) {
    try {
      if (block.canHarvest(item.type)) return true;
    } catch {
      // Ignore malformed metadata.
    }
  }
  return false;
}

function blockDropNamesAt(
  bot: mineflayer.Bot,
  position: { x: number; y: number; z: number },
): string[] {
  return blockDropNames(bot, bot.blockAt(position as any));
}

function inventoryCount(bot: mineflayer.Bot, name: string): number {
  return bot.inventory.items()
    .filter(item => item.name === name)
    .reduce((sum, item) => sum + item.count, 0);
}

function recipeIngredients(
  bot: mineflayer.Bot,
  recipe: any,
): Array<{ item: string; count: number }> {
  const byName = new Map<string, number>();
  const delta = Array.isArray(recipe?.delta) ? recipe.delta : [];
  for (const part of delta) {
    const count = Number(part?.count) || 0;
    const id = Number(part?.id);
    if (!Number.isFinite(id) || count >= 0) continue;
    const name = (bot.registry.items as any)?.[id]?.name as string | undefined;
    if (!name) continue;
    byName.set(name, (byName.get(name) ?? 0) + Math.abs(count));
  }
  return [...byName.entries()]
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => a.item.localeCompare(b.item));
}

function recipeItemIds(raw: any): number[] {
  if (raw == null) return [];
  if (typeof raw === 'number') return [raw];
  if (Array.isArray(raw)) return raw.flatMap(recipeItemIds);
  if (typeof raw === 'object') {
    if (typeof raw.id === 'number') return [raw.id];
    if (typeof raw.type === 'number') return [raw.type];
  }
  return [];
}

function isInteractiveBlockName(name: string): boolean {
  return (
    name === 'crafting_table' ||
    name === 'furnace' ||
    name === 'smoker' ||
    name === 'blast_furnace' ||
    name === 'chest' ||
    name === 'trapped_chest' ||
    name === 'barrel' ||
    name.endsWith('_bed') ||
    name.endsWith('_door') ||
    name.endsWith('_button') ||
    name.endsWith('_lever')
  );
}

function dedupeAffordances(actions: ExecutiveActionCapability[]): ExecutiveActionCapability[] {
  const seen = new Set<string>();
  return actions.filter(action => {
    if (seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  });
}

function dropId(raw: any): number | null {
  if (typeof raw === 'number') return raw;
  if (!raw || typeof raw !== 'object') return null;
  const drop = raw.drop;
  if (typeof drop === 'number') return drop;
  if (drop && typeof drop === 'object' && typeof drop.id === 'number') return drop.id;
  if (typeof raw.id === 'number') return raw.id;
  return null;
}

function stringMeta(target: SemanticTarget, key: string): string | null {
  const value = target.metadata[key];
  return typeof value === 'string' && value ? value : null;
}
