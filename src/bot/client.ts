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

const ACTION_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[Timeout] ${label}: ${ms}ms`)), ms),
    ),
  ]);
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
  private spectatorPlayer: string | null = null;

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

  /**
   * Minecraft クライアントプレイヤーをスペクテイターモードにし、ボットを追従させる。
   * ボットが OP 権限を持っている必要がある。
   */
  setupSpectator(clientPlayerName: string): void {
    const bot = this.requireBot();
    this.spectatorPlayer = clientPlayerName;
    setTimeout(() => {
      console.log(`[Bot] ${clientPlayerName} をスペクテイターモードに設定...`);
      bot.chat(`/gamemode spectator ${clientPlayerName}`);
    }, 2000);
    setTimeout(() => {
      console.log(`[Bot] ${clientPlayerName} → MineflayerBot を追従`);
      bot.chat(`/spectate ${bot.username} ${clientPlayerName}`);
    }, 4000);
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

  async executeAction(action: MappedAction): Promise<void> {
    const bot = this.requireBot();
    this.lastActionTimestamp = Date.now();

    try {
      switch (action.type) {
        case 'mine_block':
          await withTimeout(this.doMineBlock(bot, action.params.blockType as string), ACTION_TIMEOUT_MS, 'mine_block');
          break;
        case 'explore':
          await withTimeout(this.doExplore(bot), ACTION_TIMEOUT_MS, 'explore');
          break;
        case 'eat_food':
          await withTimeout(this.doEatFood(bot), 5000, 'eat_food');
          break;
        case 'craft_item':
          await withTimeout(this.doCraftBasic(bot), 5000, 'craft_item');
          break;
        case 'move_to_position':
          await withTimeout(this.doExplore(bot), ACTION_TIMEOUT_MS, 'move_to');
          break;
        case 'idle':
          await new Promise((r) => setTimeout(r, 3000));
          break;
        case 'sleep': {
          const bed = bot.findBlock({ matching: (b) => b.name.includes('bed'), maxDistance: 32 });
          if (bed) {
            await withTimeout(
              bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)),
              ACTION_TIMEOUT_MS, 'sleep_pathfind',
            );
            try { await bot.sleep(bed); } catch { /* not night or occupied */ }
          } else {
            console.log('    → ベッドが見つかりません');
          }
          break;
        }
        case 'attack_entity': {
          const target = bot.nearestEntity((e) => e.type === 'hostile' || e.type === 'mob');
          if (target) {
            await withTimeout(
              bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2)),
              ACTION_TIMEOUT_MS, 'attack_pathfind',
            );
            bot.attack(target);
          }
          break;
        }
        default:
          break;
      }
    } catch (e) {
      bot.pathfinder.stop();
      throw e;
    }
  }

  private async doMineBlock(bot: mineflayer.Bot, blockType: string): Promise<void> {
    const LOG_TYPES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log'];
    const targets = blockType === 'oak_log' ? LOG_TYPES : [blockType];

    const block = bot.findBlock({
      matching: (b) => targets.includes(b.name),
      maxDistance: 64,
    });
    if (!block) {
      console.log(`    → ${blockType} が近くに見つかりません`);
      return;
    }

    console.log(`    → ${block.name} (${Math.round(block.position.x)}, ${Math.round(block.position.y)}, ${Math.round(block.position.z)}) に移動`);
    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    await bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2));

    const freshBlock = bot.blockAt(block.position);
    if (freshBlock && bot.canDigBlock(freshBlock)) {
      console.log(`    → ${freshBlock.name} を採掘中...`);
      await bot.dig(freshBlock);
      console.log(`    → 採掘完了`);
      await new Promise((r) => setTimeout(r, 300));
      await bot.pathfinder.goto(new goals.GoalBlock(block.position.x, block.position.y, block.position.z));
    }
  }

  private async doExplore(bot: mineflayer.Bot): Promise<void> {
    const angle = Math.random() * Math.PI * 2;
    const dist = 10 + Math.random() * 20;
    const tx = bot.entity.position.x + Math.cos(angle) * dist;
    const tz = bot.entity.position.z + Math.sin(angle) * dist;
    console.log(`    → (${Math.round(tx)}, ${Math.round(tz)}) 方向に探索`);

    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    try {
      await bot.pathfinder.goto(new goals.GoalXZ(tx, tz));
    } catch {
      console.log('    → 探索パス失敗、別方向を試行');
      const angle2 = angle + Math.PI;
      const tx2 = bot.entity.position.x + Math.cos(angle2) * 10;
      const tz2 = bot.entity.position.z + Math.sin(angle2) * 10;
      try {
        await bot.pathfinder.goto(new goals.GoalXZ(tx2, tz2));
      } catch { /* give up */ }
    }
  }

  private async doEatFood(bot: mineflayer.Bot): Promise<void> {
    const foodName = this.getBestFood();
    if (!foodName) {
      console.log('    → 食料なし');
      return;
    }
    const item = bot.inventory.items().find((i) => i.name === foodName);
    if (!item) return;
    try {
      console.log(`    → ${foodName} を食べる`);
      await bot.equip(item, 'hand');
      await bot.consume();
    } catch {
      console.log('    → 食事失敗（満腹かもしれません）');
    }
  }

  private async doCraftBasic(bot: mineflayer.Bot): Promise<void> {
    const logItem = bot.inventory.items().find((i) => i.name.includes('_log'));
    if (!logItem) {
      console.log('    → 原木なし（クラフト不可）');
      return;
    }

    const logPrefix = logItem.name.replace('_log', '');
    const planksName = `${logPrefix}_planks`;
    const planksId = bot.registry.itemsByName[planksName]?.id;
    if (!planksId) {
      console.log(`    → ${planksName} のレシピが見つかりません`);
      return;
    }

    const recipes = bot.recipesFor(planksId, null, 1, null);
    if (recipes.length > 0) {
      console.log(`    → ${planksName} をクラフト`);
      await bot.craft(recipes[0], 1, undefined as any);
      console.log(`    → クラフト完了`);
    } else {
      console.log(`    → ${planksName} のレシピなし`);
    }
  }

  async executeReactiveBot(action: ReactiveAction): Promise<void> {
    const bot = this.requireBot();
    switch (action.type) {
      case 'flee':
      case 'flee_from_attack':
      case 'stop_and_retreat': {
        const dx = -Math.cos(bot.entity.yaw) * 15;
        const dz = -Math.sin(bot.entity.yaw) * 15;
        const movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);
        try {
          await bot.pathfinder.goto(new goals.GoalNear(
            bot.entity.position.x + dx, bot.entity.position.y, bot.entity.position.z + dz, 3,
          ));
        } catch { /* best effort escape */ }
        break;
      }
      case 'eat': {
        await this.doEatFood(bot);
        break;
      }
      default:
        break;
    }
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
    this.executeReactiveBot(action).catch(() => {});
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
