import mineflayer from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import type { GameState, RecentEvent, Position } from '../types/index.js';
import type { BotSensors, SensedEntity, ReactiveAction, MappedAction } from './types.js';
import { evaluateReactiveRules } from './reactive.js';
import {
  classifyTimeOfDay,
  classifyWeather,
  categorizeEntity,
  summarizeInventory,
} from './gameStateCollector.js';

export interface BotClientOptions {
  host: string;
  port: number;
  username: string;
}

export interface BotEvents {
  onDeath: (cause: string) => void;
  onReactiveAction: (event: RecentEvent) => void;
}

/**
 * Mineflayer Bot のラッパー。
 * 接続・切断・ゲーム状態取得・行動実行を提供する。
 * リアクティブ層はゲームティックごとに自動評価される。
 */
export class BotClient {
  private bot: mineflayer.Bot | null = null;
  private events: BotEvents | null = null;
  private lastActionTimestamp = 0;
  private reactiveCheckInterval: ReturnType<typeof setInterval> | null = null;

  async connect(options: BotClientOptions, events: BotEvents): Promise<void> {
    this.events = events;

    return new Promise((resolve, reject) => {
      this.bot = mineflayer.createBot({
        host: options.host,
        port: options.port,
        username: options.username,
        hideErrors: false,
      });

      this.bot.loadPlugin(pathfinder);

      this.bot.once('spawn', () => {
        this.setupReactiveLoop();
        resolve();
      });

      this.bot.once('error', (err) => reject(err));

      this.bot.on('death', () => {
        this.events?.onDeath(this.getDeathCause());
      });
    });
  }

  disconnect(): void {
    if (this.reactiveCheckInterval) {
      clearInterval(this.reactiveCheckInterval);
      this.reactiveCheckInterval = null;
    }
    this.bot?.quit();
    this.bot = null;
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  getLastActionTimestamp(): number {
    return this.lastActionTimestamp;
  }

  /**
   * 現在のゲーム状態から BotSensors を構築する。
   * リアクティブ層の入力用。
   */
  getSensors(): BotSensors {
    const bot = this.requireBot();
    const entities = this.getNearbyEntities();
    const blockBelow = bot.blockAt(bot.entity.position.offset(0, -1, 0));

    return {
      hp: bot.health,
      maxHp: 20,
      hunger: bot.food,
      oxygen: bot.oxygenLevel ?? 300,
      isOnFire: (bot.entity as any).isOnFire ?? false,
      nearbyEntities: entities,
      blockBelow: blockBelow?.name ?? null,
      hasFood: this.hasFood(),
      foodItem: this.getBestFood(),
      inventoryFull: bot.inventory.emptySlotCount() === 0,
      isNight: classifyTimeOfDay(bot.time.timeOfDay) === 'night',
      baseKnown: false,
      baseDistance: null,
    };
  }

  /**
   * LLM 入力用の GameState を構築する。
   * pacing, previousPlan, memory は orchestrator 側で付与するため、
   * ここでは player, world, base の部分のみ返す。
   */
  getPartialGameState(): Pick<GameState, 'player' | 'world' | 'base'> {
    const bot = this.requireBot();
    const entities = this.getNearbyEntities();

    return {
      player: {
        hp: bot.health,
        maxHp: 20,
        hunger: bot.food,
        position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        biome: bot.blockAt(bot.entity.position)?.biome?.name ?? 'unknown',
        equipment: {
          hand: bot.heldItem?.name ?? null,
          helmet: bot.inventory.slots[5]?.name ?? null,
          chestplate: bot.inventory.slots[6]?.name ?? null,
          leggings: bot.inventory.slots[7]?.name ?? null,
          boots: bot.inventory.slots[8]?.name ?? null,
        },
        inventorySummary: summarizeInventory(
          bot.inventory.items().map((i) => ({ name: i.name, count: i.count })),
        ),
      },
      world: {
        timeOfDay: classifyTimeOfDay(bot.time.timeOfDay),
        minecraftTime: bot.time.timeOfDay,
        weather: classifyWeather(bot.isRaining, bot.thunderState > 0),
        lightLevel: bot.blockAt(bot.entity.position)?.light ?? 15,
        nearbyEntities: entities.map((e) => ({
          type: e.type,
          distance: e.distance,
          direction: e.direction,
        })),
        nearbyBlocksOfInterest: [],
      },
      base: {
        known: false,
        position: null,
        distance: null,
        hasBed: false,
        hasFurnace: false,
        hasCraftingTable: false,
      },
    };
  }

  async moveTo(position: Position): Promise<void> {
    const bot = this.requireBot();
    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);
    await bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 1));
    this.lastActionTimestamp = Date.now();
  }

  private setupReactiveLoop(): void {
    this.reactiveCheckInterval = setInterval(() => {
      if (!this.bot) return;
      try {
        const sensors = this.getSensors();
        const action = evaluateReactiveRules(sensors);
        if (action) {
          this.executeReactiveAction(action);
        }
      } catch {
        // リアクティブ層のエラーは無視して次のティックで再評価
      }
    }, 250);
  }

  private executeReactiveAction(action: ReactiveAction): void {
    this.lastActionTimestamp = Date.now();
    const event: RecentEvent = {
      time: 'now',
      event: `reactive_${action.type}`,
      detail: action.reason,
    };
    this.events?.onReactiveAction(event);
  }

  private getNearbyEntities(): SensedEntity[] {
    const bot = this.requireBot();
    const result: SensedEntity[] = [];
    for (const entity of Object.values(bot.entities)) {
      if (entity === bot.entity) continue;
      if (!entity.name) continue;
      const dist = bot.entity.position.distanceTo(entity.position);
      if (dist > 32) continue;
      const dx = entity.position.x - bot.entity.position.x;
      const dz = entity.position.z - bot.entity.position.z;
      result.push({
        type: entity.name,
        distance: Math.round(dist * 10) / 10,
        direction: getDirection(dx, dz),
        isHostile: categorizeEntity(entity.name),
      });
    }
    return result.sort((a, b) => a.distance - b.distance);
  }

  private hasFood(): boolean {
    return this.getBestFood() !== null;
  }

  private getBestFood(): string | null {
    const bot = this.requireBot();
    const foodItems = bot.inventory.items().filter((i) => i.name.includes('bread') ||
      i.name.includes('cooked') || i.name.includes('apple') ||
      i.name.includes('steak') || i.name.includes('carrot') ||
      i.name.includes('potato') && i.name.includes('baked'));
    return foodItems.length > 0 ? foodItems[0].name : null;
  }

  private getDeathCause(): string {
    return 'unknown';
  }

  private requireBot(): mineflayer.Bot {
    if (!this.bot) throw new Error('Bot is not connected');
    return this.bot;
  }
}

function getDirection(dx: number, dz: number): string {
  const angle = Math.atan2(-dx, dz) * (180 / Math.PI);
  if (angle >= -22.5 && angle < 22.5) return 'south';
  if (angle >= 22.5 && angle < 67.5) return 'southwest';
  if (angle >= 67.5 && angle < 112.5) return 'west';
  if (angle >= 112.5 && angle < 157.5) return 'northwest';
  if (angle >= -67.5 && angle < -22.5) return 'southeast';
  if (angle >= -112.5 && angle < -67.5) return 'east';
  if (angle >= -157.5 && angle < -112.5) return 'northeast';
  return 'north';
}
