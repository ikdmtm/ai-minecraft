import type mineflayer from 'mineflayer';
import type {
  ExecutiveCapabilitySnapshot,
  SemanticTarget,
} from './executiveTypes.js';

export class CapabilityRegistry {
  private craftCacheKey = '';
  private craftCache: ExecutiveCapabilitySnapshot['craft'] = [];

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

  if (names.length > 0) return names;
  return bot.registry.itemsByName[block?.name]?.name ? [block.name] : [];
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
