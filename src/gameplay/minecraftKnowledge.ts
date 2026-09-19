import type mineflayer from 'mineflayer';
import { readFileSync } from 'fs';

/** Exact registry/JAR facts. Unknown metadata stays unknown, never invented as a recipe. */
export class MinecraftKnowledge {
  private exported: any = null;
  constructor(private readonly bot: mineflayer.Bot, path = process.env.GAMEPLAY_KNOWLEDGE_FILE ?? './data/minecraft-knowledge.json') {
    try { this.exported = JSON.parse(readFileSync(path, 'utf8')); } catch { /* Registry queries still work. */ }
  }
  lookup(raw: string, offset = 0): Record<string, unknown> {
    const query = raw.trim().toLowerCase().replace(/^minecraft:/, '');
    if (!query || query.length > 128 || !Number.isInteger(offset) || offset < 0) throw new Error('knowledge_invalid_query');
    const r = this.bot.registry as any;
    const facts: unknown[] = [];
    for (const name of Object.keys(r.itemsByName ?? {})) {
      if (!name.includes(query)) continue;
      facts.push({ kind: 'item', data: r.itemsByName[name], food: r.foodsByName?.[name] ?? null });
    }
    for (const [name, data] of Object.entries(r.blocksByName ?? {})) if (name.includes(query)) facts.push({ kind: 'block', data });
    for (const [name, data] of Object.entries(r.entitiesByName ?? {})) if (name.includes(query)) facts.push({ kind: 'entity', data, loot: r.entityLoot?.[name] ?? null });
    for (const [name, data] of Object.entries(r.windows ?? {})) if (name.includes(query) || query === 'windows') facts.push({ kind: 'window', data });
    const version = r.version?.minecraftVersion ?? this.bot.version;
    const exportMatches = this.exported?.version === version;
    if (exportMatches) {
      for (const [name, data] of Object.entries(this.exported.recipes ?? {})) {
        if (name.includes(query) || JSON.stringify(data).includes(query)) facts.push({ kind: 'recipe', id: name, data });
      }
      for (const [name, data] of Object.entries(this.exported.tags ?? {})) if (name.includes(query)) facts.push({ kind: 'tag', id: name, data });
    }
    return { query, offset, total: facts.length, nextOffset: offset + 12 < facts.length ? offset + 12 : null,
      facts: facts.slice(offset, offset + 12), version, source: 'minecraft-data + matching vanilla server JAR',
      processingRecipesAvailable: exportMatches,
      limitation: exportMatches ? 'Server datapack overrides are not included in the vanilla export.' : 'No matching server-JAR recipe export; processing specifications are unavailable, not inferred.' };
  }
}
