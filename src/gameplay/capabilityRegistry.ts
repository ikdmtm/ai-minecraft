import type mineflayer from 'mineflayer';
import type {
  ExecutiveCapabilitySnapshot,
  SemanticTarget,
} from './executiveTypes.js';

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
      gather,
      craft: this.discoverCraftableItems(strategyText),
      recipes: this.discoverReachableRecipes(gather, strategyText),
      actions: this.discoverDynamicActions(targets),
      entityActions,
      canExcavate: targets.some(target => target.kind === 'excavation_site'),
    };
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
      utility: ExecutiveCapabilitySnapshot['craft'][number]['utility'];
      owned: number;
      strategyRelevant: boolean;
      priority: number;
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
      const mentioned = strategy.includes(item.name.toLowerCase()) || strategy.includes(readable);
      const utility = craftUtility(item.name, item as any);
      const owned = inventoryCount(this.bot, item.name);
      const strategyRelevant = isCraftStrategicallyRelevant(utility, item.name, strategy, mentioned);

      // Do not flood the executive with every decorative/redstone variant just
      // because it is technically craftable. Keep survival-relevant affordances
      // and anything the strategy explicitly asks for.
      if (!strategyRelevant) continue;

      // Workstations/storage/sleep infrastructure should not be duplicated as
      // busywork once one is already carried unless the strategy names it.
      if (
        owned > 0 &&
        !mentioned &&
        (utility === 'workstation' || utility === 'storage' || utility === 'bed')
      ) {
        continue;
      }

      results.push({
        item: item.name,
        requiresTable: recipes.every(recipe => Boolean(recipe.requiresTable)),
        recipeCount: recipes.length,
        utility,
        owned,
        strategyRelevant,
        priority: (mentioned ? 1000 : 0) + craftUtilityPriority(utility),
      });
    }

    this.craftCache = results
      .sort((a, b) => b.priority - a.priority || a.item.localeCompare(b.item))
      .slice(0, 64)
      .map(({ item, requiresTable, recipeCount, utility, owned, strategyRelevant }) => ({
        item,
        requiresTable,
        recipeCount,
        utility,
        owned,
        strategyRelevant,
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
          discovered.set(recipe.item, {
            ...recipe,
            reachableDepth: depth,
          });
        }
      }
      if (!changed) break;
    }

    const strategy = strategyText.toLowerCase();
    return [...discovered.values()]
      .sort((a, b) => {
        const aMentioned = strategy.includes(a.item) || strategy.includes(a.item.replace(/_/g, ' '));
        const bMentioned = strategy.includes(b.item) || strategy.includes(b.item.replace(/_/g, ' '));
        if (aMentioned !== bMentioned) return aMentioned ? -1 : 1;
        return a.reachableDepth - b.reachableDepth || a.item.localeCompare(b.item);
      })
      .slice(0, 128);
  }

  private discoverDynamicActions(
    targets: SemanticTarget[],
  ): ExecutiveCapabilitySnapshot['actions'] {
    const actions: ExecutiveCapabilitySnapshot['actions'] = [];

    for (const target of targets) {
      if (target.kind !== 'entity' || !Boolean(target.metadata.foodAnimal)) continue;
      const entity = stringMeta(target, 'entityName') ?? 'animal';
      actions.push({
        id: `hunt:${target.id}`,
        kind: 'hunt_entity',
        description: `Hunt observed ${entity} and collect nearby drops.`,
        targetId: target.id,
        utilityTags: ['food', 'survival', 'resource'],
        preconditions: {
          visible: true,
          hostile: Boolean(target.metadata.hostile),
          distance: target.distance,
        },
        expectedEffects: {
          mayProduceFood: true,
          entity: entity,
        },
      });
    }

    for (const entry of this.discoverEdibleInventory()) {
      if (this.bot.food >= 20) break;
      actions.push({
        id: `consume:${entry.item}`,
        kind: 'consume_item',
        description: `Consume carried ${entry.item} to restore hunger.`,
        item: entry.item,
        utilityTags: ['food', 'survival', 'recovery'],
        preconditions: {
          inventoryCount: entry.count,
          hunger: this.bot.food,
        },
        expectedEffects: {
          hungerIncreaseApprox: entry.foodPoints,
        },
      });
    }

    for (const entry of this.discoverPlaceableUtilities()) {
      actions.push({
        id: `place:${entry.item}`,
        kind: 'place_item',
        description: `Place carried ${entry.item} nearby so it can be used as ${entry.role} infrastructure.`,
        item: entry.item,
        role: entry.role,
        utilityTags: ['infrastructure', entry.role],
        preconditions: {
          inventoryCount: inventoryCount(this.bot, entry.item),
          onGround: Boolean(this.bot.entity.onGround),
        },
        expectedEffects: {
          facilityAvailable: entry.role,
        },
      });
    }

    const station = this.bot.findBlock({
      matching: block => block.name === 'furnace' || block.name === 'smoker',
      maxDistance: 8,
    });
    for (const entry of this.discoverCookableFood()) {
      if (!station || !entry.fuelAvailable) continue;
      actions.push({
        id: `process:${entry.input}:${entry.output}`,
        kind: 'process_item',
        description: `Cook carried ${entry.input} into ${entry.output} using the nearby ${station.name}.`,
        item: entry.input,
        outputItem: entry.output,
        station: station.name,
        utilityTags: ['food', 'processing', 'survival'],
        preconditions: {
          inputCount: entry.count,
          fuelAvailable: entry.fuelAvailable,
          stationNearby: true,
        },
        expectedEffects: {
          outputItem: entry.output,
          improvesFoodValue: true,
        },
      });
    }

    const bed = this.bot.findBlock({
      matching: block => block.name.endsWith('_bed'),
      maxDistance: 16,
    });
    if (bed && isNight(this.bot)) {
      actions.push({
        id: 'sleep:nearby_bed',
        kind: 'sleep',
        description: 'Sleep in the nearby bed to advance through the night when Minecraft permits it.',
        utilityTags: ['sleep', 'safety', 'time'],
        preconditions: {
          bedNearby: true,
          night: true,
        },
        expectedEffects: {
          advancesToDay: true,
        },
      });
    }

    const shelter = targets.find(target =>
      target.kind === 'known_structure' &&
      target.metadata.structureKind === 'shelter' &&
      target.distance <= 3,
    );
    if (shelter && isNight(this.bot)) {
      actions.push({
        id: 'wait:daylight',
        kind: 'wait_condition',
        description: 'Remain at the known shelter until daylight or until safety/needs require replanning.',
        targetId: shelter.id,
        utilityTags: ['safety', 'time', 'shelter'],
        preconditions: {
          night: true,
          shelterNearby: true,
        },
        expectedEffects: {
          advancesToDay: true,
          avoidsNightExposure: true,
        },
      });
    }

    return actions.slice(0, 40);
  }

  private discoverEdibleInventory(): Array<{ item: string; count: number; foodPoints: number }> {
    return this.bot.inventory.items()
      .map(item => {
        const data = (this.bot.registry.items as any)?.[item.type] ?? {};
        const foodPoints = Number(data.foodPoints ?? data.food_points ?? 0);
        return {
          item: item.name,
          count: item.count,
          foodPoints: Number.isFinite(foodPoints) ? foodPoints : 0,
        };
      })
      .filter(entry => entry.foodPoints > 0 || FALLBACK_EDIBLE_ITEMS.has(entry.item))
      .map(entry => ({
        ...entry,
        foodPoints: entry.foodPoints > 0 ? entry.foodPoints : 2,
      }))
      .sort((a, b) => b.foodPoints - a.foodPoints || b.count - a.count);
  }

  private discoverPlaceableUtilities(): ExecutiveCapabilitySnapshot['place'] {
    const seen = new Set<string>();
    const result: ExecutiveCapabilitySnapshot['place'] = [];
    for (const item of this.bot.inventory.items()) {
      const role = placeableRole(item.name);
      if (!role || seen.has(item.name)) continue;
      seen.add(item.name);
      result.push({ item: item.name, role });
    }
    return result;
  }

  private discoverCookableFood(): ExecutiveCapabilitySnapshot['cook'] {
    const fuelAvailable = this.bot.inventory.items().some(item => isFuelItem(item.name));
    const inventory = new Map(this.bot.inventory.items().map(item => [item.name, item.count]));
    return Object.entries(COOKABLE_FOOD)
      .filter(([input]) => (inventory.get(input) ?? 0) > 0)
      .map(([input, output]) => ({
        input,
        output,
        count: inventory.get(input) ?? 0,
        fuelAvailable,
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

  const names = [...ids]
    .map(id => (bot.registry.items as any)?.[id]?.name as string | undefined)
    .filter((name): name is string => Boolean(name));

  // Never infer "the block drops itself" just because an item with the same
  // registry name exists. Leaves, grass and many special blocks can be broken
  // without yielding themselves. Only advertise drops Minecraft data actually
  // declares; uncertain/probabilistic loot can still appear later as item_drop.
  return names;
}

export function canHarvestBlockNow(bot: mineflayer.Bot, block: any): boolean {
  if (!block?.diggable) return false;
  try {
    if (block.canHarvest(null)) return true;
  } catch {
    // Fall through to held/inventory tools.
  }

  for (const item of bot.inventory.items()) {
    try {
      if (block.canHarvest(item.type)) return true;
    } catch {
      // Ignore malformed block/tool metadata.
    }
  }
  return false;
}


const FALLBACK_EDIBLE_ITEMS = new Set([
  'apple', 'bread', 'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
  'cooked_cod', 'cooked_salmon', 'baked_potato', 'potato', 'carrot', 'golden_carrot',
  'sweet_berries', 'glow_berries', 'melon_slice', 'dried_kelp', 'mushroom_stew',
]);

const COOKABLE_FOOD: Record<string, string> = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp',
};

function inventoryCount(bot: mineflayer.Bot, name: string): number {
  return bot.inventory.items()
    .filter(item => item.name === name)
    .reduce((sum, item) => sum + item.count, 0);
}

function craftUtility(
  name: string,
  data: any,
): ExecutiveCapabilitySnapshot['craft'][number]['utility'] {
  if (Number(data?.foodPoints ?? data?.food_points ?? 0) > 0 || FALLBACK_EDIBLE_ITEMS.has(name)) return 'food';
  if (name.endsWith('_pickaxe') || name.endsWith('_axe') || name.endsWith('_shovel') || name.endsWith('_hoe')) return 'tool';
  if (name.endsWith('_sword') || name === 'bow' || name === 'crossbow' || name === 'shield') return 'weapon';
  if (
    name.endsWith('_helmet') || name.endsWith('_chestplate') ||
    name.endsWith('_leggings') || name.endsWith('_boots')
  ) return 'armor';
  if (name.endsWith('_bed')) return 'bed';
  if (['crafting_table', 'furnace', 'smoker', 'blast_furnace', 'campfire'].includes(name)) return 'workstation';
  if (['chest', 'trapped_chest', 'barrel', 'shulker_box'].includes(name) || name.endsWith('_shulker_box')) return 'storage';
  if (['bucket', 'shears', 'fishing_rod', 'flint_and_steel', 'compass', 'clock'].includes(name)) return 'utility';
  if (name === 'stick' || name.endsWith('_planks') || name === 'torch' || name.endsWith('_door')) return 'material';
  if (
    name.endsWith('_slab') || name.endsWith('_stairs') || name.endsWith('_fence') ||
    name.endsWith('_wall') || name.endsWith('_log') || name === 'cobblestone' || name === 'dirt'
  ) return 'building';
  return 'misc';
}

function craftUtilityPriority(
  utility: ExecutiveCapabilitySnapshot['craft'][number]['utility'],
): number {
  switch (utility) {
    case 'food': return 140;
    case 'tool': return 130;
    case 'weapon': return 120;
    case 'armor': return 115;
    case 'bed': return 110;
    case 'workstation': return 100;
    case 'utility': return 90;
    case 'storage': return 75;
    case 'material': return 70;
    case 'building': return 40;
    default: return 0;
  }
}

function isCraftStrategicallyRelevant(
  utility: ExecutiveCapabilitySnapshot['craft'][number]['utility'],
  name: string,
  strategy: string,
  mentioned: boolean,
): boolean {
  if (mentioned) return true;
  if (['food', 'tool', 'weapon', 'armor', 'bed', 'workstation', 'utility'].includes(utility)) return true;
  if (utility === 'storage') return /(storage|store|cache|chest|barrel|base)/.test(strategy);
  if (utility === 'material') return true;
  if (utility === 'building') return /(build|shelter|base|repair|structure)/.test(strategy);
  // Redstone/decorative/misc items stay hidden unless the current strategy
  // explicitly names them. This preserves open-ended crafting without letting
  // "anything craftable" become fake progress.
  return false;
}

function placeableRole(name: string): ExecutiveCapabilitySnapshot['place'][number]['role'] | null {
  if (['crafting_table', 'furnace', 'smoker', 'blast_furnace', 'campfire'].includes(name)) return 'workstation';
  if (['chest', 'trapped_chest', 'barrel'].includes(name) || name.endsWith('_shulker_box')) return 'storage';
  if (name.endsWith('_bed')) return 'sleep';
  return null;
}

function isFuelItem(name: string): boolean {
  return (
    name === 'coal' ||
    name === 'charcoal' ||
    name === 'stick' ||
    name.endsWith('_log') ||
    name.endsWith('_wood') ||
    name.endsWith('_planks')
  );
}

function isNight(bot: mineflayer.Bot): boolean {
  const time = bot.time.timeOfDay;
  return time >= 12500 && time < 23500;
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
