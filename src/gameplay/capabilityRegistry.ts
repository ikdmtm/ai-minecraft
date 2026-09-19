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
      results.push({
        item: item.name,
        requiresTable: recipes.every(recipe => Boolean(recipe.requiresTable)),
        recipeCount: recipes.length,
        priority: mentioned ? 1000 : 0,
      });
    }

    this.craftCache = results
      .sort((a, b) => b.priority - a.priority || a.item.localeCompare(b.item))
      .slice(0, 96)
      .map(({ item, requiresTable, recipeCount }) => ({
        item,
        requiresTable,
        recipeCount,
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
