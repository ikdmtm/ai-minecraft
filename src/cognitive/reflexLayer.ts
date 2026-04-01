import mineflayer from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { SharedStateBus, ReflexState, CognitiveThreatLevel } from './sharedState.js';
import type { BotSensors, SensedEntity } from '../bot/types.js';
import {
  classifyTimeOfDay,
  classifyWeather,
  categorizeEntity,
  summarizeInventory,
} from '../bot/gameStateCollector.js';
import type { GameState, Position, RecentEvent } from '../types/index.js';

const TICK_MS = 250;
const FLEE_DISTANCE = 5;
const COMBAT_RANGE = 4;
const LOW_HP_THRESHOLD = 8;
const HUNGER_EAT_THRESHOLD = 14;
const FOOD_CRITICAL_THRESHOLD = 4;
const GATHER_RANGE = 5;
const IDLE_LOOK_INTERVAL_MS = 3000;
const NIGHT_RETREAT_TIME = 12500;
const DAWN_TIME = 23500;

const FOOD_ITEMS = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'baked_potato', 'apple',
  'golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'sweet_berries',
  'glow_berries', 'melon_slice', 'dried_kelp', 'mushroom_stew', 'rabbit_stew',
  'beetroot_soup', 'suspicious_stew', 'cookie', 'pumpkin_pie', 'cake',
]);

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman',
  'witch', 'slime', 'phantom', 'drowned', 'husk',
  'stray', 'blaze', 'ghast', 'cave_spider',
  'vindicator', 'evoker', 'pillager', 'ravager',
]);

const VALUABLE_DROPS = new Set([
  'diamond', 'iron_ingot', 'gold_ingot', 'emerald', 'lapis_lazuli',
  'coal', 'raw_iron', 'raw_gold', 'raw_copper',
]);

const FOOD_ANIMALS = new Set([
  'cow', 'pig', 'chicken', 'sheep', 'rabbit',
]);

const RAW_TO_COOKED: Record<string, string> = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  salmon: 'cooked_salmon',
  cod: 'cooked_cod',
};

const WEAPON_ITEMS = new Set([
  'wooden_sword', 'stone_sword', 'iron_sword', 'golden_sword', 'diamond_sword', 'netherite_sword',
  'wooden_axe', 'stone_axe', 'iron_axe', 'golden_axe', 'diamond_axe', 'netherite_axe',
]);

export interface ReflexLayerEvents {
  onDeath: (cause: string) => void;
  onReactiveAction: (event: RecentEvent) => void;
  onStateChange: (from: ReflexState, to: ReflexState) => void;
}

export class ReflexLayer {
  private bot: mineflayer.Bot | null = null;
  private shared: SharedStateBus;
  private events: ReflexLayerEvents | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private currentAction: Promise<void> | null = null;
  private actionAbortController: AbortController | null = null;
  private lastIdleLook = 0;
  private isExecutingAction = false;
  private spectatorPlayer: string | null = null;
  private lastDeathMessage = '';
  private shelterBuilt = false;

  constructor(shared: SharedStateBus) {
    this.shared = shared;
  }

  async connect(
    options: { host: string; port: number; username: string },
    events: ReflexLayerEvents,
  ): Promise<void> {
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
        this.startTickLoop();
        this.setupEventListeners();
        resolve();
      });

      this.bot.once('error', (err) => reject(err));

      this.bot.on('death', () => {
        this.shared.updateEmotion({ valence: -0.8, arousal: 0.9, dominance: -0.5 }, 'death');
        this.events?.onDeath(this.getDeathCause());
      });
    });
  }

  disconnect(): void {
    this.stopTickLoop();
    this.bot?.quit();
    this.bot = null;
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  setupSpectator(clientPlayerName: string): void {
    const bot = this.requireBot();
    this.spectatorPlayer = clientPlayerName;
    setTimeout(() => {
      bot.chat(`/gamemode spectator ${clientPlayerName}`);
    }, 2000);
    setTimeout(() => {
      bot.chat(`/spectate ${bot.username} ${clientPlayerName}`);
    }, 4000);
  }

  getBot(): mineflayer.Bot {
    return this.requireBot();
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
      baseKnown: this.shared.get().worldModel.basePosition !== null,
      baseDistance: this.getBaseDistance(),
    };
  }

  getPartialGameState(): Pick<GameState, 'player' | 'world' | 'base'> {
    const bot = this.requireBot();
    const entities = this.getNearbyEntities();
    const wm = this.shared.get().worldModel;

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
          bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
        ),
      },
      world: {
        timeOfDay: classifyTimeOfDay(bot.time.timeOfDay),
        minecraftTime: bot.time.timeOfDay,
        weather: classifyWeather(bot.isRaining, bot.thunderState > 0),
        lightLevel: bot.blockAt(bot.entity.position)?.light ?? 15,
        nearbyEntities: entities.map(e => ({
          type: e.type,
          distance: e.distance,
          direction: e.direction,
        })),
        nearbyBlocksOfInterest: [],
      },
      base: {
        known: wm.basePosition !== null,
        position: wm.basePosition,
        distance: this.getBaseDistance(),
        hasBed: wm.hasBed,
        hasFurnace: wm.hasFurnace,
        hasCraftingTable: wm.hasCraftingTable,
      },
    };
  }

  interruptCurrentAction(): void {
    this.actionAbortController?.abort();
    try { this.bot?.pathfinder.stop(); } catch { /* ignore */ }
    this.isExecutingAction = false;
  }

  // --- Tick Loop (System 1 core) ---

  private startTickLoop(): void {
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTickLoop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick(): void {
    if (!this.bot) return;

    try {
      this.updateThreatLevel();
      this.shared.decayEmotion(0.01);
      this.shared.cleanupExpired();

      const urgentAction = this.evaluateUrgentActions();
      if (urgentAction) {
        this.executeUrgentAction(urgentAction);
        return;
      }

      if (this.isExecutingAction) return;

      this.executeGoalBehavior();
    } catch {
      // tick errors are non-fatal
    }
  }

  private updateThreatLevel(): void {
    const bot = this.requireBot();
    const hostiles = this.getNearbyEntities().filter(e => e.isHostile);
    const closestHostile = hostiles.length > 0 ? hostiles[0].distance : Infinity;

    let level: CognitiveThreatLevel = 'safe';
    if (bot.health <= 4 || closestHostile < 3) {
      level = 'critical';
    } else if (bot.health <= 8 || closestHostile < 8) {
      level = 'danger';
    } else if (closestHostile < 16 || bot.food < 6) {
      level = 'caution';
    }

    this.shared.setThreatLevel(level);
  }

  private evaluateUrgentActions(): UrgentAction | null {
    const bot = this.requireBot();
    const sensors = this.getSensors();

    const creeper = sensors.nearbyEntities.find(
      e => e.type === 'creeper' && e.distance < FLEE_DISTANCE,
    );
    if (creeper) {
      return { type: 'flee', reason: `クリーパー接近 (${creeper.distance.toFixed(1)}m)` };
    }

    if (sensors.isOnFire) {
      return { type: 'flee', reason: '燃焼中' };
    }

    if (sensors.blockBelow === 'lava' || sensors.blockBelow === 'flowing_lava') {
      return { type: 'flee', reason: '溶岩の上' };
    }

    if (bot.health <= LOW_HP_THRESHOLD && sensors.hasFood) {
      return { type: 'eat', reason: `HP低下 (${bot.health})` };
    }

    const attacker = sensors.nearbyEntities.find(
      e => e.isHostile && e.distance < COMBAT_RANGE,
    );
    if (attacker) {
      const hasWeapon = this.hasWeaponEquipped();
      if (bot.health > LOW_HP_THRESHOLD && hasWeapon) {
        return { type: 'fight', target: attacker.type, reason: `${attacker.type} が接近（武器あり）` };
      }
      return { type: 'flee', reason: `${attacker.type} 接近（${hasWeapon ? '' : '武器なし・'}HP: ${bot.health}）` };
    }

    if (bot.food <= HUNGER_EAT_THRESHOLD && sensors.hasFood && !this.isExecutingAction) {
      return { type: 'eat', reason: `空腹 (${bot.food})` };
    }

    return null;
  }

  private executeUrgentAction(action: UrgentAction): void {
    if (this.isExecutingAction && action.type !== 'flee' && action.type !== 'eat') return;

    this.interruptCurrentAction();

    const prevState = this.shared.get().reflexState;
    const event: RecentEvent = {
      time: 'now',
      event: `reflex_${action.type}`,
      detail: action.reason,
    };
    this.events?.onReactiveAction(event);
    this.shared.pushEvent({ type: `reflex_${action.type}`, detail: action.reason, importance: 'high' });

    switch (action.type) {
      case 'flee':
        this.shared.setReflexState('fleeing');
        this.shared.updateEmotion({ valence: -0.3, arousal: 0.4 }, action.reason);
        this.runAction(() => this.doFlee());
        break;
      case 'eat':
        this.shared.setReflexState('eating');
        this.runAction(() => this.doEat());
        break;
      case 'fight':
        this.shared.setReflexState('combat');
        this.shared.updateEmotion({ arousal: 0.3 }, action.reason);
        this.runAction(() => this.doFight(action.target!));
        break;
    }
  }

  private executeGoalBehavior(): void {
    const bot = this.requireBot();
    const state = this.shared.get();

    // Night safety: retreat to base or build shelter
    const timeOfDay = bot.time.timeOfDay;
    const isNight = timeOfDay >= NIGHT_RETREAT_TIME && timeOfDay < DAWN_TIME;
    if (isNight && state.reflexState !== 'sleeping' && state.reflexState !== 'returning_to_base') {
      if (state.worldModel.basePosition) {
        this.shared.setReflexState('returning_to_base');
        this.shared.pushEvent({ type: 'night_retreat', detail: '夜になったので拠点へ帰還', importance: 'medium' });
        this.runAction(() => this.doReturnToBase());
        return;
      }
      if (!this.shelterBuilt) {
        this.shared.setReflexState('crafting');
        this.shared.pushEvent({ type: 'shelter_build', detail: '夜間・拠点なし：シェルター建設', importance: 'medium' });
        this.runAction(() => this.doBuildShelter());
        return;
      }
    }

    // Critical food shortage: hunt animals
    if (bot.food <= FOOD_CRITICAL_THRESHOLD && !this.hasFood()) {
      const animal = bot.nearestEntity(e => e.name !== undefined && FOOD_ANIMALS.has(e.name!));
      if (animal) {
        this.shared.setReflexState('combat');
        this.shared.pushEvent({ type: 'hunt_food', detail: `食料危機：${animal.name} を狩猟`, importance: 'high' });
        this.runAction(() => this.doHuntAnimal(animal.name!));
        return;
      }
    }

    const goal = state.currentGoal.toLowerCase();
    if (!goal && state.subGoals.length === 0) {
      this.doIdleBehavior();
      return;
    }

    const activeGoal = goal || state.subGoals[0] || '';

    if (activeGoal.includes('木') || activeGoal.includes('log') || activeGoal.includes('伐採')) {
      this.shared.setReflexState('mining');
      this.runAction(() => this.doMineBlock(['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log']));
    } else if (activeGoal.includes('石') || activeGoal.includes('stone') || activeGoal.includes('cobble')) {
      this.shared.setReflexState('mining');
      this.runAction(() => this.doMineBlock(['stone', 'cobblestone']));
    } else if (activeGoal.includes('鉄') || activeGoal.includes('iron')) {
      this.shared.setReflexState('mining');
      this.runAction(() => this.doMineBlock(['iron_ore', 'deepslate_iron_ore']));
    } else if (activeGoal.includes('ダイヤ') || activeGoal.includes('diamond')) {
      this.shared.setReflexState('mining');
      this.runAction(() => this.doMineBlock(['diamond_ore', 'deepslate_diamond_ore']));
    } else if (activeGoal.includes('石炭') || activeGoal.includes('coal')) {
      this.shared.setReflexState('mining');
      this.runAction(() => this.doMineBlock(['coal_ore', 'deepslate_coal_ore']));
    } else if (activeGoal.includes('クラフト') || activeGoal.includes('craft') || activeGoal.includes('作成')) {
      this.shared.setReflexState('crafting');
      this.runAction(() => this.doCraftAdvanced());
    } else if (activeGoal.includes('探索') || activeGoal.includes('explor')) {
      this.shared.setReflexState('exploring');
      this.runAction(() => this.doExplore());
    } else if (activeGoal.includes('拠点') || activeGoal.includes('帰') || activeGoal.includes('base')) {
      this.shared.setReflexState('returning_to_base');
      this.runAction(() => this.doReturnToBase());
    } else if (activeGoal.includes('寝') || activeGoal.includes('sleep') || activeGoal.includes('ベッド')) {
      this.shared.setReflexState('sleeping');
      this.runAction(() => this.doSleep());
    } else if (activeGoal.includes('食料') || activeGoal.includes('food') || activeGoal.includes('狩')) {
      this.shared.setReflexState('gathering');
      this.runAction(() => this.doHuntAnimal(''));
    } else {
      this.shared.setReflexState('exploring');
      this.runAction(() => this.doExplore());
    }
  }

  private doIdleBehavior(): void {
    if (this.isExecutingAction) return;
    this.shared.setReflexState('idle');

    const now = Date.now();
    if (now - this.lastIdleLook > IDLE_LOOK_INTERVAL_MS) {
      this.lastIdleLook = now;
      const bot = this.requireBot();
      const yaw = bot.entity.yaw + (Math.random() - 0.5) * Math.PI * 0.5;
      const pitch = (Math.random() - 0.5) * 0.3;
      bot.look(yaw, pitch, false).catch(() => {});

      this.pickupNearbyItems();
    }
  }

  // --- Action implementations ---

  private async doFlee(): Promise<void> {
    const bot = this.requireBot();
    const dx = -Math.cos(bot.entity.yaw) * 15;
    const dz = -Math.sin(bot.entity.yaw) * 15;
    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    try {
      await bot.pathfinder.goto(new goals.GoalNear(
        bot.entity.position.x + dx, bot.entity.position.y, bot.entity.position.z + dz, 3,
      ));
    } catch { /* best effort */ }
  }

  private async doEat(): Promise<void> {
    const bot = this.requireBot();
    const foodName = this.getBestFood();
    if (!foodName) return;
    const item = bot.inventory.items().find(i => i.name === foodName);
    if (!item) return;
    try {
      await bot.equip(item, 'hand');
      await bot.consume();
      this.shared.updateEmotion({ valence: 0.1 }, 'ate_food');
    } catch { /* full or interrupted */ }
  }

  private async doFight(targetType: string): Promise<void> {
    const bot = this.requireBot();
    const target = bot.nearestEntity(e => e.name === targetType);
    if (!target) return;

    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);

    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2),
      );
      for (let i = 0; i < 5; i++) {
        const freshTarget = bot.nearestEntity(e => e.name === targetType);
        if (!freshTarget || bot.entity.position.distanceTo(freshTarget.position) > 4) break;
        bot.attack(freshTarget);
        await sleep(400);
      }
      this.shared.updateEmotion({ dominance: 0.1 }, `fought_${targetType}`);
    } catch { /* target escaped */ }
  }

  private async doMineBlock(blockTypes: string[]): Promise<void> {
    const bot = this.requireBot();
    const block = bot.findBlock({
      matching: b => blockTypes.includes(b.name),
      maxDistance: 64,
    });
    if (!block) {
      await this.doExplore();
      return;
    }

    this.shared.addResourceLocation(block.name, {
      x: block.position.x, y: block.position.y, z: block.position.z,
    });

    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    await bot.pathfinder.goto(
      new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2),
    );

    const freshBlock = bot.blockAt(block.position);
    if (freshBlock && bot.canDigBlock(freshBlock)) {
      await bot.dig(freshBlock);
      this.shared.updateEmotion({ valence: 0.05, dominance: 0.02 }, `mined_${freshBlock.name}`);
      this.shared.pushEvent({
        type: 'mined',
        detail: freshBlock.name,
        importance: 'low',
      });
      await sleep(200);
      try {
        await bot.pathfinder.goto(new goals.GoalBlock(
          block.position.x, block.position.y, block.position.z,
        ));
      } catch { /* can't reach dropped item */ }
    }
  }

  private async doExplore(): Promise<void> {
    const bot = this.requireBot();
    const angle = Math.random() * Math.PI * 2;
    const dist = 15 + Math.random() * 25;
    const tx = bot.entity.position.x + Math.cos(angle) * dist;
    const tz = bot.entity.position.z + Math.sin(angle) * dist;

    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    try {
      await bot.pathfinder.goto(new goals.GoalXZ(tx, tz));
      this.shared.updateEmotion({ valence: 0.02, arousal: 0.01 }, 'explored');
    } catch {
      const angle2 = angle + Math.PI;
      const tx2 = bot.entity.position.x + Math.cos(angle2) * 10;
      const tz2 = bot.entity.position.z + Math.sin(angle2) * 10;
      try { await bot.pathfinder.goto(new goals.GoalXZ(tx2, tz2)); } catch { /* stuck */ }
    }
  }

  private async doReturnToBase(): Promise<void> {
    const basePos = this.shared.get().worldModel.basePosition;
    if (!basePos) {
      await this.doExplore();
      return;
    }
    const bot = this.requireBot();
    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    await bot.pathfinder.goto(new goals.GoalNear(basePos.x, basePos.y, basePos.z, 3));
  }

  private async doSleep(): Promise<void> {
    const bot = this.requireBot();
    const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 32 });
    if (!bed) return;
    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);
    await bot.pathfinder.goto(
      new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2),
    );
    try { await bot.sleep(bed); } catch { /* not night or occupied */ }
  }

  private async doCraftAdvanced(): Promise<void> {
    const bot = this.requireBot();

    // Step 1: logs → planks
    const logItem = bot.inventory.items().find(i => i.name.includes('_log'));
    if (logItem) {
      const logPrefix = logItem.name.replace('_log', '');
      const planksName = `${logPrefix}_planks`;
      await this.tryCraft(planksName, 4);
    }

    // Step 2: planks → sticks
    const planks = bot.inventory.items().find(i => i.name.includes('_planks'));
    if (planks && planks.count >= 2) {
      await this.tryCraft('stick', 1);
    }

    // Step 3: crafting table if missing
    if (!bot.inventory.items().some(i => i.name === 'crafting_table')) {
      await this.tryCraft('crafting_table', 1);
    }

    // Step 4: tools progression (wooden → stone → iron)
    const hasSword = bot.inventory.items().some(i => i.name.includes('_sword'));
    const hasPickaxe = bot.inventory.items().some(i => i.name.includes('_pickaxe'));
    const hasAxe = bot.inventory.items().some(i => i.name.includes('_axe'));
    const hasFurnace = bot.inventory.items().some(i => i.name === 'furnace');
    const cobble = bot.inventory.items().find(i => i.name === 'cobblestone');
    const sticks = bot.inventory.items().find(i => i.name === 'stick');
    const hasSticks = sticks && sticks.count >= 2;

    const craftingTable = this.findNearbyCraftingTable();

    if (craftingTable && hasSticks) {
      if (!hasPickaxe) {
        if (cobble && cobble.count >= 3) {
          await this.tryCraftAt(craftingTable, 'stone_pickaxe', 1);
        } else {
          await this.tryCraftAt(craftingTable, 'wooden_pickaxe', 1);
        }
      }
      if (!hasSword) {
        if (cobble && cobble.count >= 2) {
          await this.tryCraftAt(craftingTable, 'stone_sword', 1);
        } else {
          await this.tryCraftAt(craftingTable, 'wooden_sword', 1);
        }
      }
      if (!hasAxe) {
        if (cobble && cobble.count >= 3) {
          await this.tryCraftAt(craftingTable, 'stone_axe', 1);
        } else {
          await this.tryCraftAt(craftingTable, 'wooden_axe', 1);
        }
      }
      if (!hasFurnace && cobble && cobble.count >= 8) {
        await this.tryCraftAt(craftingTable, 'furnace', 1);
      }
    } else if (!craftingTable) {
      // Place crafting table if we have one
      const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
      if (tableItem) {
        await this.placeBlockNearby(tableItem);
      }
    }

    // Step 5: smelt raw ores/meat if furnace nearby
    await this.trySmelt();
  }

  private async tryCraft(itemName: string, count: number): Promise<boolean> {
    const bot = this.requireBot();
    const itemId = bot.registry.itemsByName[itemName]?.id;
    if (!itemId) return false;
    const recipes = bot.recipesFor(itemId, null, count, null);
    if (recipes.length > 0) {
      try {
        await bot.craft(recipes[0], count, undefined as any);
        this.shared.pushEvent({ type: 'crafted', detail: itemName, importance: 'low' });
        this.shared.updateEmotion({ valence: 0.05 }, `crafted_${itemName}`);
        return true;
      } catch { return false; }
    }
    return false;
  }

  private async tryCraftAt(table: any, itemName: string, count: number): Promise<boolean> {
    const bot = this.requireBot();
    const itemId = bot.registry.itemsByName[itemName]?.id;
    if (!itemId) return false;
    const recipes = bot.recipesFor(itemId, null, count, table);
    if (recipes.length > 0) {
      try {
        await bot.craft(recipes[0], count, table);
        this.shared.pushEvent({ type: 'crafted', detail: itemName, importance: 'medium' });
        this.shared.updateEmotion({ valence: 0.1, dominance: 0.05 }, `crafted_${itemName}`);
        return true;
      } catch { return false; }
    }
    return false;
  }

  private findNearbyCraftingTable(): any {
    const bot = this.requireBot();
    return bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 8 }) ?? null;
  }

  private async placeBlockNearby(item: any): Promise<void> {
    const bot = this.requireBot();
    const refBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!refBlock) return;
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
    } catch { /* placement failed */ }
  }

  private async trySmelt(): Promise<void> {
    const bot = this.requireBot();
    const furnaceBlock = bot.findBlock({ matching: b => b.name === 'furnace' || b.name === 'lit_furnace', maxDistance: 8 });
    if (!furnaceBlock) {
      const furnaceItem = bot.inventory.items().find(i => i.name === 'furnace');
      if (furnaceItem) {
        await this.placeBlockNearby(furnaceItem);
        return;
      }
      return;
    }

    const rawItems = bot.inventory.items().filter(i =>
      i.name.startsWith('raw_') || Object.keys(RAW_TO_COOKED).includes(i.name),
    );
    if (rawItems.length === 0) return;

    const fuel = bot.inventory.items().find(i =>
      i.name === 'coal' || i.name === 'charcoal' || i.name.includes('_log') || i.name.includes('_planks'),
    );
    if (!fuel) return;

    try {
      const movements = new Movements(bot);
      bot.pathfinder.setMovements(movements);
      await bot.pathfinder.goto(
        new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2),
      );
      const furnace = await (bot as any).openFurnace(furnaceBlock);
      await furnace.putFuel(fuel.type, null, 1);
      await furnace.putInput(rawItems[0].type, null, Math.min(rawItems[0].count, 8));
      await sleep(500);
      furnace.close();
      this.shared.pushEvent({ type: 'smelting', detail: rawItems[0].name, importance: 'low' });
    } catch { /* furnace interaction failed */ }
  }

  private async doHuntAnimal(targetName: string): Promise<void> {
    const bot = this.requireBot();
    const target = targetName
      ? bot.nearestEntity(e => e.name === targetName)
      : bot.nearestEntity(e => e.name !== undefined && FOOD_ANIMALS.has(e.name!));
    if (!target) return;

    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2),
      );
      for (let i = 0; i < 8; i++) {
        const fresh = targetName
          ? bot.nearestEntity(e => e.name === targetName)
          : bot.nearestEntity(e => e.name !== undefined && FOOD_ANIMALS.has(e.name!));
        if (!fresh || bot.entity.position.distanceTo(fresh.position) > 4) break;
        bot.attack(fresh);
        await sleep(350);
      }
      this.shared.pushEvent({ type: 'hunted', detail: target.name ?? 'animal', importance: 'medium' });
    } catch { /* hunt failed */ }
  }

  private async doBuildShelter(): Promise<void> {
    const bot = this.requireBot();
    const dirt = bot.inventory.items().find(i =>
      i.name === 'dirt' || i.name === 'cobblestone' || i.name.includes('_planks'),
    );
    if (!dirt || dirt.count < 12) {
      // Mine dirt from ground
      const dirtBlock = bot.findBlock({ matching: b => b.name === 'dirt' || b.name === 'grass_block', maxDistance: 8 });
      if (dirtBlock) {
        const movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);
        await bot.pathfinder.goto(
          new goals.GoalNear(dirtBlock.position.x, dirtBlock.position.y, dirtBlock.position.z, 2),
        );
        for (let i = 0; i < 16; i++) {
          const block = bot.findBlock({ matching: b => b.name === 'dirt' || b.name === 'grass_block', maxDistance: 4 });
          if (!block || !bot.canDigBlock(block)) break;
          await bot.dig(block);
          await sleep(100);
        }
      }
      return;
    }

    // Build 3x1 walls around current position
    try {
      await bot.equip(dirt, 'hand');
      const pos = bot.entity.position.floored();
      const offsets = [
        { x: -1, z: 0 }, { x: 1, z: 0 }, { x: 0, z: -1 }, { x: 0, z: 1 },
        { x: -1, z: -1 }, { x: 1, z: -1 }, { x: -1, z: 1 }, { x: 1, z: 1 },
      ];
      for (const off of offsets) {
        const target = pos.offset(off.x, 1, off.z);
        const refBlock = bot.blockAt(pos.offset(off.x, 0, off.z));
        if (refBlock && refBlock.name !== 'air') {
          try {
            await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
            await sleep(100);
          } catch { /* can't place */ }
        }
      }
      this.shelterBuilt = true;
      this.shared.pushEvent({ type: 'shelter_built', detail: '簡易シェルター建設', importance: 'medium' });
      this.shared.updateEmotion({ valence: 0.1, dominance: 0.1 }, 'built_shelter');
    } catch { /* shelter building failed */ }
  }

  private hasWeaponEquipped(): boolean {
    const bot = this.requireBot();
    const held = bot.heldItem;
    if (!held) return false;
    return WEAPON_ITEMS.has(held.name);
  }

  private pickupNearbyItems(): void {
    const bot = this.requireBot();
    const item = bot.nearestEntity(e => e.name === 'item' || e.name === 'experience_orb');
    if (item && bot.entity.position.distanceTo(item.position) < GATHER_RANGE) {
      const movements = new Movements(bot);
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.goto(
        new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0),
      ).catch(() => {});
    }
  }

  private runAction(fn: () => Promise<void>): void {
    if (this.isExecutingAction) return;
    this.isExecutingAction = true;
    this.actionAbortController = new AbortController();

    const timeout = setTimeout(() => {
      this.interruptCurrentAction();
    }, 30_000);

    this.currentAction = fn()
      .catch(() => {
        try { this.bot?.pathfinder.stop(); } catch { /* ignore */ }
      })
      .finally(() => {
        clearTimeout(timeout);
        this.isExecutingAction = false;
        this.currentAction = null;
        this.actionAbortController = null;
      });
  }

  // --- Event listeners for world model updates ---

  private setupEventListeners(): void {
    const bot = this.requireBot();

    bot.on('entitySpawn', (entity) => {
      if (entity.name && categorizeEntity(entity.name)) {
        const dist = bot.entity.position.distanceTo(entity.position);
        if (dist < 20) {
          this.shared.pushEvent({
            type: 'hostile_spawn',
            detail: `${entity.name} (${dist.toFixed(0)}m)`,
            importance: dist < 8 ? 'high' : 'medium',
          });
        }
      }
    });

    bot.on('entityHurt', (entity) => {
      if (entity === bot.entity) {
        this.shared.updateEmotion({ valence: -0.2, arousal: 0.3 }, 'took_damage');
        this.shared.pushEvent({
          type: 'took_damage',
          detail: `HP: ${bot.health}`,
          importance: bot.health < 8 ? 'critical' : 'high',
        });
      }
    });

    bot.on('playerCollect', (collector, collected) => {
      if (collector === bot.entity) {
        this.shared.updateEmotion({ valence: 0.03 }, 'collected_item');
      }
    });

    bot.on('messagestr', (message: string) => {
      const username = bot.username;
      if (message.includes(username) && isDeathMessage(message)) {
        this.lastDeathMessage = message;
      }
    });
  }

  // --- Helper methods ---

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
    const foods = bot.inventory.items().filter(i => FOOD_ITEMS.has(i.name));
    return foods.length > 0 ? foods[0].name : null;
  }

  private getBaseDistance(): number | null {
    const base = this.shared.get().worldModel.basePosition;
    if (!base || !this.bot) return null;
    return Math.round(this.bot.entity.position.distanceTo(
      (this.bot as any).vec3(base.x, base.y, base.z) ?? { x: base.x, y: base.y, z: base.z, distanceTo: () => 0 },
    ));
  }

  private getDeathCause(): string {
    if (this.lastDeathMessage) return this.lastDeathMessage;
    return 'unknown';
  }

  private requireBot(): mineflayer.Bot {
    if (!this.bot) throw new Error('Bot is not connected');
    return this.bot;
  }
}

type UrgentAction = {
  type: 'flee' | 'eat' | 'fight';
  reason: string;
  target?: string;
};

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const DEATH_KEYWORDS = [
  'was slain by', 'was shot by', 'was blown up by', 'was killed by',
  'was fireballed by', 'was pummeled by', 'was squashed by',
  'drowned', 'burned to death', 'went up in flames', 'tried to swim in lava',
  'hit the ground too hard', 'fell from', 'fell off', 'fell out of',
  'starved to death', 'suffocated', 'was pricked to death', 'walked into a cactus',
  'was impaled', 'withered away', 'was struck by lightning', 'froze to death',
  'experienced kinetic energy', 'was squished', 'blew up', 'died',
];

export function isDeathMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return DEATH_KEYWORDS.some(kw => lower.includes(kw));
}
