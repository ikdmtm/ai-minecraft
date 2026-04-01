import mineflayer from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { SharedStateBus, ReflexState, CognitiveThreatLevel } from './sharedState.js';
import { ActionFailureGuard } from './actionFailureGuard.js';
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
const BLOCKED_TARGET_COOLDOWN_MS = 90_000;
const ACTION_STALL_THRESHOLD_MS = 10_000;
const GOAL_CHANGE_INTERRUPT_THRESHOLD_MS = 8_000;
const NO_PROGRESS_BLOCK_COOLDOWN_MS = 15_000;

const FOOD_ITEMS = new Set([
  'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'salmon', 'cod',
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

export type GoalBehavior =
  | 'mine_logs'
  | 'mine_stone'
  | 'mine_iron'
  | 'mine_diamond'
  | 'mine_coal'
  | 'craft'
  | 'explore'
  | 'return_to_base'
  | 'sleep'
  | 'gather_food';

export interface InventorySnapshotItem {
  name: string;
  count: number;
}

export interface ReflexLayerEvents {
  onDeath: (cause: string) => void;
  onDisconnect: (reason: string) => void;
  onReactiveAction: (event: RecentEvent) => void;
  onStateChange: (from: ReflexState, to: ReflexState) => void;
}

export interface ReflexRuntimeDiagnostics {
  reflexState: ReflexState;
  currentGoal: string;
  threatLevel: CognitiveThreatLevel;
  currentActionLabel: string | null;
  currentActionAgeMs: number | null;
  lastTickAgeMs: number | null;
  maxTickDriftMs: number;
  lastPacketAgeMs: number | null;
  lastKeepAliveAgeMs: number | null;
  lastPhysicsTickAgeMs: number | null;
  lastMoveAgeMs: number | null;
  hp: number | null;
  hunger: number | null;
  position: Position | null;
}

interface ActionExecutionResult {
  progress: boolean;
  reason?: string;
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
  private disconnecting = false;
  private currentActionLabel: string | null = null;
  private currentActionInitialGoal = '';
  private currentActionStartedAt = 0;
  private currentActionToken = 0;
  private lastTickStartedAt = 0;
  private nextExpectedTickAt = 0;
  private maxTickDriftMs = 0;
  private lastPacketAt = 0;
  private lastKeepAliveAt = 0;
  private lastPhysicsTickAt = 0;
  private lastMoveAt = 0;
  private readonly miningFailureGuard = new ActionFailureGuard({
    failureThreshold: 3,
    failureWindowMs: 30_000,
    cooldownMs: BLOCKED_TARGET_COOLDOWN_MS,
  });
  private readonly noProgressGuard = new ActionFailureGuard({
    failureThreshold: 4,
    failureWindowMs: 20_000,
    cooldownMs: NO_PROGRESS_BLOCK_COOLDOWN_MS,
  });

  constructor(shared: SharedStateBus) {
    this.shared = shared;
  }

  async connect(
    options: { host: string; port: number; username: string },
    events: ReflexLayerEvents,
  ): Promise<void> {
    this.events = events;
    this.disconnecting = false;
    this.resetRuntimeDiagnostics();

    return new Promise((resolve, reject) => {
      const bot = mineflayer.createBot({
        host: options.host,
        port: options.port,
        username: options.username,
        hideErrors: false,
      });
      this.bot = bot;
      this.attachRuntimeDiagnostics(bot);

      bot.loadPlugin(pathfinder);
      let spawned = false;
      let disconnectHandled = false;

      const handleDisconnect = (reason: unknown) => {
        if (disconnectHandled) return;
        disconnectHandled = true;
        const message = describeDisconnectReason(reason, this.getRuntimeDiagnostics(bot));
        const planned = this.disconnecting;
        this.cleanupConnection(bot);

        if (!spawned) {
          reject(reason instanceof Error ? reason : new Error(message));
          return;
        }

        if (!planned) {
          this.events?.onDisconnect(message);
        }
      };

      bot.once('spawn', () => {
        if (disconnectHandled) return;
        spawned = true;
        this.startTickLoop();
        this.setupEventListeners();
        resolve();
      });

      bot.on('error', (err) => {
        if (!spawned) {
          handleDisconnect(err);
          return;
        }

        handleDisconnect(err);
      });
      bot.once('end', (reason) => handleDisconnect(reason));
      bot.once('kicked', (reason) => handleDisconnect(reason));

      bot.on('death', () => {
        this.shared.updateEmotion({ valence: -0.8, arousal: 0.9, dominance: -0.5 }, 'death');
        this.events?.onReactiveAction({
          time: 'now',
          event: 'bot_death_context',
          detail: formatRuntimeDiagnostics(this.getRuntimeDiagnostics(bot)),
        });
        this.events?.onDeath(this.getDeathCause());
      });
    });
  }

  disconnect(): void {
    this.disconnecting = true;
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

  interruptCurrentAction(reason?: string): void {
    const interruptedAction = this.currentActionLabel;
    const interruptedAgeMs = toAgeMs(this.currentActionStartedAt);
    this.actionAbortController?.abort();
    try { this.bot?.pathfinder.stop(); } catch { /* ignore */ }

    if (interruptedAction) {
      const detail = reason
        ? `${interruptedAction} interrupted (${formatAgeMs(interruptedAgeMs)}): ${reason}`
        : `${interruptedAction} interrupted (${formatAgeMs(interruptedAgeMs)})`;
      this.events?.onReactiveAction({ time: 'now', event: 'action_interrupted', detail });
      this.shared.pushEvent({ type: 'action_interrupted', detail, importance: 'medium' });
    }

    this.currentActionToken += 1;
    this.currentAction = null;
    this.currentActionLabel = null;
    this.currentActionInitialGoal = '';
    this.currentActionStartedAt = 0;
    this.actionAbortController = null;
    this.isExecutingAction = false;
  }

  // --- Tick Loop (System 1 core) ---

  private startTickLoop(): void {
    this.nextExpectedTickAt = Date.now() + TICK_MS;
    this.tickTimer = setInterval(() => {
      const now = Date.now();
      const drift = Math.max(0, now - this.nextExpectedTickAt);
      this.maxTickDriftMs = Math.max(this.maxTickDriftMs, drift);
      this.lastTickStartedAt = now;
      this.nextExpectedTickAt = now + TICK_MS;
      this.tick();
    }, TICK_MS);
  }

  private stopTickLoop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.nextExpectedTickAt = 0;
  }

  private cleanupConnection(bot: mineflayer.Bot): void {
    this.stopTickLoop();
    this.interruptCurrentAction();
    if (this.bot === bot) {
      this.bot = null;
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

      if (this.isExecutingAction) {
        this.detectActionStall();
        this.detectGoalChangeInterrupt();
        return;
      }

      this.executeGoalBehavior();
    } catch {
      // tick errors are non-fatal
    }
  }

  private detectActionStall(): void {
    if (!this.currentActionLabel) return;

    const actionAgeMs = toAgeMs(this.currentActionStartedAt);
    if (actionAgeMs === null || actionAgeMs < ACTION_STALL_THRESHOLD_MS) {
      return;
    }

    const moveAgeMs = toAgeMs(this.lastMoveAt);
    if (moveAgeMs !== null && moveAgeMs < ACTION_STALL_THRESHOLD_MS) {
      return;
    }

    const detail = `${this.currentActionLabel} stalled (${Math.round(actionAgeMs / 1000)}s no movement)`;
    this.events?.onReactiveAction({ time: 'now', event: 'action_stalled', detail });
    this.shared.pushEvent({ type: 'action_stalled', detail, importance: 'high' });
    this.shared.updateEmotion({ arousal: -0.05, dominance: -0.05 }, 'action_stalled');
    this.interruptCurrentAction('stalled');
  }

  private detectGoalChangeInterrupt(): void {
    if (!this.currentActionLabel || !this.currentActionInitialGoal) return;
    if (this.currentActionLabel === 'flee' || this.currentActionLabel === 'eat') return;
    if (this.currentActionLabel.startsWith('fight:')) return;

    const latestGoal = this.shared.get().currentGoal;
    if (!latestGoal || latestGoal === this.currentActionInitialGoal) {
      return;
    }

    const actionAgeMs = toAgeMs(this.currentActionStartedAt);
    if (actionAgeMs === null || actionAgeMs < GOAL_CHANGE_INTERRUPT_THRESHOLD_MS) {
      return;
    }

    const reason = `goal_changed "${this.currentActionInitialGoal}" -> "${latestGoal}"`;
    this.interruptCurrentAction(reason);
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

    this.interruptCurrentAction(`urgent_${action.type}`);

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
        this.runAction('flee', () => this.doFlee());
        break;
      case 'eat':
        this.shared.setReflexState('eating');
        this.runAction('eat', () => this.doEat());
        break;
      case 'fight':
        this.shared.setReflexState('combat');
        this.shared.updateEmotion({ arousal: 0.3 }, action.reason);
        this.runAction(`fight:${action.target!}`, () => this.doFight(action.target!));
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
        this.runAction('return_to_base', () => this.doReturnToBase());
        return;
      }
      if (!this.shelterBuilt) {
        this.shared.setReflexState('crafting');
        this.shared.pushEvent({ type: 'shelter_build', detail: '夜間・拠点なし：シェルター建設', importance: 'medium' });
        this.runAction('build_shelter', () => this.doBuildShelter());
        return;
      }
    }

    // Critical food shortage: hunt animals
    if (bot.food <= FOOD_CRITICAL_THRESHOLD && !this.hasFood()) {
      const animal = bot.nearestEntity(e => e.name !== undefined && FOOD_ANIMALS.has(e.name!));
      if (animal) {
        this.shared.setReflexState('combat');
        this.shared.pushEvent({ type: 'hunt_food', detail: `食料危機：${animal.name} を狩猟`, importance: 'high' });
        this.runAction(`hunt:${animal.name!}`, () => this.doHuntAnimal(animal.name!));
        return;
      }
    }

    if (shouldForceCraftBootstrap(
      bot.inventory.items().map(item => ({ name: item.name, count: item.count })),
      this.findNearbyCraftingTable() !== null,
    )) {
      this.shared.setReflexState('crafting');
      if (this.isActionSuppressed('craft_bootstrap')) {
        this.runSuppressedActionFallback('craft_bootstrap');
        return;
      }
      this.runAction('craft_bootstrap', () => this.doCraftAdvanced());
      return;
    }

    const goal = state.currentGoal.toLowerCase();
    if (!goal && state.subGoals.length === 0) {
      this.doIdleBehavior();
      return;
    }

    const activeGoal = goal || state.subGoals[0] || '';

    switch (resolveGoalBehavior(activeGoal)) {
      case 'mine_logs':
      this.shared.setReflexState('mining');
      if (this.isActionSuppressed('mine_logs')) {
        this.runSuppressedActionFallback('mine_logs');
        break;
      }
      this.runAction('mine_logs', () => this.doMineBlock(['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log']));
      break;
      case 'mine_stone':
      this.shared.setReflexState('mining');
      if (this.isActionSuppressed('mine_stone')) {
        this.runSuppressedActionFallback('mine_stone');
        break;
      }
      this.runAction('mine_stone', () => this.doMineBlock(['stone', 'cobblestone']));
      break;
      case 'mine_iron':
      this.shared.setReflexState('mining');
      if (this.isActionSuppressed('mine_iron')) {
        this.runSuppressedActionFallback('mine_iron');
        break;
      }
      this.runAction('mine_iron', () => this.doMineBlock(['iron_ore', 'deepslate_iron_ore']));
      break;
      case 'mine_diamond':
      this.shared.setReflexState('mining');
      if (this.isActionSuppressed('mine_diamond')) {
        this.runSuppressedActionFallback('mine_diamond');
        break;
      }
      this.runAction('mine_diamond', () => this.doMineBlock(['diamond_ore', 'deepslate_diamond_ore']));
      break;
      case 'mine_coal':
      this.shared.setReflexState('mining');
      if (this.isActionSuppressed('mine_coal')) {
        this.runSuppressedActionFallback('mine_coal');
        break;
      }
      this.runAction('mine_coal', () => this.doMineBlock(['coal_ore', 'deepslate_coal_ore']));
      break;
      case 'craft':
      this.shared.setReflexState('crafting');
      if (this.isActionSuppressed('craft')) {
        this.runSuppressedActionFallback('craft');
        break;
      }
      this.runAction('craft', () => this.doCraftAdvanced());
      break;
      case 'return_to_base':
      this.shared.setReflexState('returning_to_base');
      this.runAction('return_to_base', () => this.doReturnToBase());
      break;
      case 'sleep':
      this.shared.setReflexState('sleeping');
      this.runAction('sleep', () => this.doSleep());
      break;
      case 'gather_food':
      this.shared.setReflexState('gathering');
      if (this.isActionSuppressed('gather_food')) {
        this.runSuppressedActionFallback('gather_food');
        break;
      }
      this.runAction('gather_food', () => this.doHuntAnimal(''));
      break;
      case 'explore':
      default:
      this.shared.setReflexState('exploring');
      this.runAction('explore', () => this.doExplore());
      break;
    }
  }

  private isActionSuppressed(label: string): boolean {
    return this.noProgressGuard.isBlocked(label);
  }

  private runSuppressedActionFallback(label: string): void {
    const detail = `${label} temporarily suppressed after repeated no-progress; fallback explore`;
    this.events?.onReactiveAction({ time: 'now', event: 'action_suppressed', detail });
    this.shared.pushEvent({ type: 'action_suppressed', detail, importance: 'medium' });
    this.shared.setReflexState('exploring');
    this.runAction('explore', () => this.doExplore());
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

  private async doFlee(): Promise<ActionExecutionResult> {
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
      return { progress: true, reason: 'moved_away_from_threat' };
    } catch { /* best effort */ }
    return { progress: false, reason: 'flee_path_unreachable' };
  }

  private async doEat(): Promise<ActionExecutionResult> {
    const bot = this.requireBot();
    const foodName = this.getBestFood();
    if (!foodName) return { progress: false, reason: 'no_food_available' };
    const item = bot.inventory.items().find(i => i.name === foodName);
    if (!item) return { progress: false, reason: 'food_item_missing' };
    try {
      await bot.equip(item, 'hand');
      await bot.consume();
      this.shared.updateEmotion({ valence: 0.1 }, 'ate_food');
      return { progress: true, reason: `ate_${foodName}` };
    } catch { /* full or interrupted */ }
    return { progress: false, reason: 'consume_failed_or_interrupted' };
  }

  private async doFight(targetType: string): Promise<ActionExecutionResult> {
    const bot = this.requireBot();
    const target = bot.nearestEntity(e => e.name === targetType);
    if (!target) return { progress: false, reason: `target_missing:${targetType}` };

    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);

    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2),
      );
      let attackCount = 0;
      for (let i = 0; i < 5; i++) {
        const freshTarget = bot.nearestEntity(e => e.name === targetType);
        if (!freshTarget || bot.entity.position.distanceTo(freshTarget.position) > 4) break;
        bot.attack(freshTarget);
        attackCount++;
        await sleep(400);
      }
      if (attackCount <= 0) return { progress: false, reason: `target_out_of_range:${targetType}` };
      this.shared.updateEmotion({ dominance: 0.1 }, `fought_${targetType}`);
      return { progress: true, reason: `attacked_${targetType}_${attackCount}` };
    } catch { /* target escaped */ }
    return { progress: false, reason: `fight_failed:${targetType}` };
  }

  private async doMineBlock(blockTypes: string[]): Promise<ActionExecutionResult> {
    const bot = this.requireBot();
    const block = bot.findBlock({
      matching: (b) => {
        // mineflayer's matcher can receive null for unloaded chunk positions.
        if (!b || typeof b.name !== 'string') return false;
        if (!hasBlockPosition(b)) return false;
        if (!blockTypes.includes(b.name)) return false;
        return !this.miningFailureGuard.isBlocked(this.getBlockActionKey(b));
      },
      maxDistance: 64,
    });
    if (!block) {
      await this.doExplore();
      return { progress: false, reason: `target_not_found:${blockTypes.join('|')}` };
    }
    if (!hasBlockPosition(block)) {
      await this.doExplore();
      return { progress: false, reason: 'target_without_position' };
    }

    this.shared.addResourceLocation(block.name, {
      x: block.position.x, y: block.position.y, z: block.position.z,
    });

    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    const actionKey = this.getBlockActionKey(block);

    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2),
      );

      const freshBlock = bot.blockAt(block.position);
      if (!freshBlock || !bot.canDigBlock(freshBlock)) {
        this.handleMiningFailure(actionKey, block.name);
        await this.doExplore();
        return { progress: false, reason: `cannot_dig:${block.name}` };
      }

      await bot.dig(freshBlock);
      await sleep(250);
      const afterDig = bot.blockAt(block.position);
      if (!didBlockBreak(freshBlock.name, afterDig?.name ?? null)) {
        this.handleMiningFailure(actionKey, block.name);
        await this.doExplore();
        return { progress: false, reason: `dig_no_break:${freshBlock.name}` };
      }

      this.miningFailureGuard.recordSuccess(actionKey);
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
      return { progress: true, reason: `mined:${freshBlock.name}` };
    } catch {
      this.handleMiningFailure(actionKey, block.name);
      await this.doExplore();
      return { progress: false, reason: `mine_failed:${block.name}` };
    }
  }

  private async doExplore(): Promise<ActionExecutionResult> {
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
      return { progress: true, reason: 'explore_primary' };
    } catch {
      const angle2 = angle + Math.PI;
      const tx2 = bot.entity.position.x + Math.cos(angle2) * 10;
      const tz2 = bot.entity.position.z + Math.sin(angle2) * 10;
      try {
        await bot.pathfinder.goto(new goals.GoalXZ(tx2, tz2));
        return { progress: true, reason: 'explore_recovery' };
      } catch { /* stuck */ }
      return { progress: false, reason: 'explore_path_unreachable' };
    }
  }

  private async doReturnToBase(): Promise<ActionExecutionResult> {
    const basePos = this.shared.get().worldModel.basePosition;
    if (!basePos) {
      await this.doExplore();
      return { progress: false, reason: 'base_unknown' };
    }
    const bot = this.requireBot();
    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    await bot.pathfinder.goto(new goals.GoalNear(basePos.x, basePos.y, basePos.z, 3));
    return { progress: true, reason: 'returned_to_base' };
  }

  private async doSleep(): Promise<ActionExecutionResult> {
    const bot = this.requireBot();
    const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 32 });
    if (!bed) return { progress: false, reason: 'bed_not_found' };
    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);
    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2),
      );
    } catch {
      return { progress: false, reason: 'bed_unreachable' };
    }
    try {
      await bot.sleep(bed);
      return { progress: true, reason: 'slept' };
    } catch {
      return { progress: false, reason: 'sleep_unavailable' };
    }
  }

  private async doCraftAdvanced(): Promise<ActionExecutionResult> {
    const bot = this.requireBot();
    let progressed = false;

    // Step 1: logs → planks
    const logItem = bot.inventory.items().find(i => i.name.includes('_log'));
    if (logItem) {
      const logPrefix = logItem.name.replace('_log', '');
      const planksName = `${logPrefix}_planks`;
      progressed = (await this.tryCraft(planksName, 4)) || progressed;
    }

    // Step 2: planks → sticks
    const planks = bot.inventory.items().find(i => i.name.includes('_planks'));
    if (planks && planks.count >= 2) {
      progressed = (await this.tryCraft('stick', 1)) || progressed;
    }

    // Step 3: crafting table if missing
    if (!bot.inventory.items().some(i => i.name === 'crafting_table')) {
      progressed = (await this.tryCraft('crafting_table', 1)) || progressed;
    }

    // Step 4: tools progression (wooden → stone → iron)
    const hasSword = bot.inventory.items().some(i => i.name.includes('_sword'));
    const hasPickaxe = bot.inventory.items().some(i => i.name.includes('_pickaxe'));
    const hasAxe = bot.inventory.items().some(i => i.name.includes('_axe'));
    const hasFurnace = bot.inventory.items().some(i => i.name === 'furnace');
    const cobble = bot.inventory.items().find(i => i.name === 'cobblestone');
    const sticks = bot.inventory.items().find(i => i.name === 'stick');
    const hasSticks = sticks && sticks.count >= 2;

    let craftingTable = this.findNearbyCraftingTable();

    if (craftingTable && hasSticks) {
      if (!hasPickaxe) {
        if (cobble && cobble.count >= 3) {
          progressed = (await this.tryCraftAt(craftingTable, 'stone_pickaxe', 1)) || progressed;
        } else {
          progressed = (await this.tryCraftAt(craftingTable, 'wooden_pickaxe', 1)) || progressed;
        }
      }
      if (!hasSword) {
        if (cobble && cobble.count >= 2) {
          progressed = (await this.tryCraftAt(craftingTable, 'stone_sword', 1)) || progressed;
        } else {
          progressed = (await this.tryCraftAt(craftingTable, 'wooden_sword', 1)) || progressed;
        }
      }
      if (!hasAxe) {
        if (cobble && cobble.count >= 3) {
          progressed = (await this.tryCraftAt(craftingTable, 'stone_axe', 1)) || progressed;
        } else {
          progressed = (await this.tryCraftAt(craftingTable, 'wooden_axe', 1)) || progressed;
        }
      }
      if (!hasFurnace && cobble && cobble.count >= 8) {
        progressed = (await this.tryCraftAt(craftingTable, 'furnace', 1)) || progressed;
      }
    } else if (!craftingTable) {
      // Place crafting table if we have one
      const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
      if (tableItem) {
        const placed = await this.placeBlockNearby(tableItem);
        progressed = placed || progressed;
        if (placed) {
          craftingTable = this.findNearbyCraftingTable();
          if (craftingTable && hasSticks) {
            if (!hasPickaxe) {
              progressed = (await this.tryCraftAt(craftingTable, cobble && cobble.count >= 3 ? 'stone_pickaxe' : 'wooden_pickaxe', 1)) || progressed;
            }
            if (!hasSword) {
              progressed = (await this.tryCraftAt(craftingTable, cobble && cobble.count >= 2 ? 'stone_sword' : 'wooden_sword', 1)) || progressed;
            }
            if (!hasAxe) {
              progressed = (await this.tryCraftAt(craftingTable, cobble && cobble.count >= 3 ? 'stone_axe' : 'wooden_axe', 1)) || progressed;
            }
          }
        }
      }
    }

    // Step 5: smelt raw ores/meat if furnace nearby
    progressed = (await this.trySmelt()) || progressed;
    if (progressed) return { progress: true, reason: 'crafted_or_prepared' };
    return { progress: false, reason: 'craft_no_recipe_or_material' };
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
      } catch {
        this.shared.pushEvent({ type: 'craft_failed', detail: itemName, importance: 'medium' });
        return false;
      }
    }
    this.shared.pushEvent({ type: 'craft_unavailable', detail: itemName, importance: 'low' });
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
      } catch {
        this.shared.pushEvent({ type: 'craft_failed', detail: itemName, importance: 'medium' });
        return false;
      }
    }
    this.shared.pushEvent({ type: 'craft_unavailable', detail: itemName, importance: 'low' });
    return false;
  }

  private findNearbyCraftingTable(): any {
    const bot = this.requireBot();
    return bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 8 }) ?? null;
  }

  private async placeBlockNearby(item: any): Promise<boolean> {
    const bot = this.requireBot();
    const refBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!refBlock) return false;
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
      this.shared.pushEvent({ type: 'placed', detail: item.name, importance: 'low' });
      return true;
    } catch {
      this.shared.pushEvent({ type: 'placement_failed', detail: item.name, importance: 'medium' });
      return false;
    }
  }

  private async trySmelt(): Promise<boolean> {
    const bot = this.requireBot();
    const furnaceBlock = bot.findBlock({ matching: b => b.name === 'furnace' || b.name === 'lit_furnace', maxDistance: 8 });
    if (!furnaceBlock) {
      const furnaceItem = bot.inventory.items().find(i => i.name === 'furnace');
      if (furnaceItem) {
        return this.placeBlockNearby(furnaceItem);
      }
      return false;
    }

    const rawItems = bot.inventory.items().filter(i =>
      i.name.startsWith('raw_') || Object.keys(RAW_TO_COOKED).includes(i.name),
    );
    if (rawItems.length === 0) return false;

    const fuel = bot.inventory.items().find(i =>
      i.name === 'coal' || i.name === 'charcoal' || i.name.includes('_log') || i.name.includes('_planks'),
    );
    if (!fuel) return false;

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
      return true;
    } catch { /* furnace interaction failed */ }
    return false;
  }

  private async doHuntAnimal(targetName: string): Promise<ActionExecutionResult> {
    const bot = this.requireBot();
    const target = targetName
      ? bot.nearestEntity(e => e.name === targetName)
      : bot.nearestEntity(e => e.name !== undefined && FOOD_ANIMALS.has(e.name!));
    if (!target) return { progress: false, reason: 'hunt_target_not_found' };

    const movements = new Movements(bot);
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2),
      );
      let attackCount = 0;
      for (let i = 0; i < 8; i++) {
        const fresh = targetName
          ? bot.nearestEntity(e => e.name === targetName)
          : bot.nearestEntity(e => e.name !== undefined && FOOD_ANIMALS.has(e.name!));
        if (!fresh || bot.entity.position.distanceTo(fresh.position) > 4) break;
        bot.attack(fresh);
        attackCount++;
        await sleep(350);
      }
      if (attackCount <= 0) return { progress: false, reason: 'hunt_target_out_of_range' };
      await sleep(500);
      await this.collectNearbyDrops();
      this.shared.pushEvent({ type: 'hunted', detail: target.name ?? 'animal', importance: 'medium' });
      return { progress: true, reason: `hunted_${target.name ?? 'animal'}_${attackCount}` };
    } catch { /* hunt failed */ }
    return { progress: false, reason: 'hunt_failed' };
  }

  private async doBuildShelter(): Promise<ActionExecutionResult> {
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
      return { progress: false, reason: 'collecting_shelter_materials' };
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
      return { progress: true, reason: 'shelter_built' };
    } catch { /* shelter building failed */ }
    return { progress: false, reason: 'shelter_build_failed' };
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

  private runAction(label: string, fn: () => Promise<ActionExecutionResult>): void {
    if (this.isExecutingAction) return;
    this.isExecutingAction = true;
    const actionToken = ++this.currentActionToken;
    this.currentActionLabel = label;
    this.currentActionInitialGoal = this.shared.get().currentGoal;
    this.currentActionStartedAt = Date.now();
    const startedAt = this.currentActionStartedAt;
    this.actionAbortController = new AbortController();
    this.events?.onReactiveAction({ time: 'now', event: 'action_start', detail: label });
    this.shared.pushEvent({ type: 'action_start', detail: label, importance: 'low' });

    const timeout = setTimeout(() => {
      this.interruptCurrentAction('timeout_30s');
    }, 30_000);

    let failed = false;
    let failureReason: string | null = null;
    let result: ActionExecutionResult = { progress: false, reason: 'unknown' };
    this.currentAction = fn()
      .then((r) => {
        result = r;
      })
      .catch((error: unknown) => {
        failed = true;
        failureReason = formatActionError(error);
        try { this.bot?.pathfinder.stop(); } catch { /* ignore */ }
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.currentActionToken !== actionToken) {
          return;
        }
        const durationMs = Math.max(0, Date.now() - startedAt);
        if (failed) {
          const detail = failureReason
            ? `${label} failed (${durationMs}ms): ${failureReason}`
            : `${label} failed (${durationMs}ms)`;
          this.events?.onReactiveAction({ time: 'now', event: 'action_failed', detail });
          this.shared.pushEvent({ type: 'action_failed', detail, importance: 'medium' });
          this.noProgressGuard.recordFailure(label);
        } else if (result.progress) {
          this.noProgressGuard.recordSuccess(label);
          const detail = result.reason
            ? `${label} done (${durationMs}ms): ${result.reason}`
            : `${label} done (${durationMs}ms)`;
          this.events?.onReactiveAction({ time: 'now', event: 'action_done', detail });
          this.shared.pushEvent({ type: 'action_done', detail, importance: 'low' });
        } else {
          const failure = this.noProgressGuard.recordFailure(label);
          const detail = result.reason
            ? `${label} no_progress (${durationMs}ms): ${result.reason}`
            : `${label} no_progress (${durationMs}ms)`;
          this.events?.onReactiveAction({ time: 'now', event: 'action_no_progress', detail });
          this.shared.pushEvent({ type: 'action_no_progress', detail, importance: 'medium' });

          if (failure.blocked) {
            const blockDetail = `${label} blocked for ${Math.round(NO_PROGRESS_BLOCK_COOLDOWN_MS / 1000)}s due to repeated no-progress`;
            this.events?.onReactiveAction({ time: 'now', event: 'action_loop_avoided', detail: blockDetail });
            this.shared.pushEvent({ type: 'action_loop_avoided', detail: blockDetail, importance: 'medium' });
          }
        }
        this.isExecutingAction = false;
        this.currentAction = null;
        this.actionAbortController = null;
        this.currentActionLabel = null;
        this.currentActionInitialGoal = '';
        this.currentActionStartedAt = 0;
      });
  }

  private async collectNearbyDrops(): Promise<void> {
    const bot = this.requireBot();
    for (let i = 0; i < 3; i++) {
      const item = bot.nearestEntity(e => e.name === 'item' || e.name === 'experience_orb');
      if (!item || bot.entity.position.distanceTo(item.position) > 10) {
        return;
      }

      const movements = new Movements(bot);
      bot.pathfinder.setMovements(movements);
      try {
        await bot.pathfinder.goto(new goals.GoalNear(
          item.position.x,
          item.position.y,
          item.position.z,
          1,
        ));
      } catch {
        return;
      }
      await sleep(150);
    }
  }

  private getBlockActionKey(block: {
    name?: string;
    position?: { x?: number; y?: number; z?: number } | null;
  }): string {
    if (!hasBlockPosition(block)) return `${block.name ?? 'unknown'}@unknown`;
    return `${block.name ?? 'unknown'}@${Math.round(block.position.x)},${Math.round(block.position.y)},${Math.round(block.position.z)}`;
  }

  private handleMiningFailure(actionKey: string, blockName: string): void {
    const failure = this.miningFailureGuard.recordFailure(actionKey);
    if (!failure.blocked) return;

    this.shared.pushEvent({
      type: 'action_loop_avoided',
      detail: `${blockName} で同じ失敗を繰り返したため ${Math.round(BLOCKED_TARGET_COOLDOWN_MS / 1000)} 秒回避`,
      importance: 'medium',
    });
    this.shared.updateEmotion({ arousal: -0.05, dominance: -0.05 }, `avoid_loop_${blockName}`);
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

  private attachRuntimeDiagnostics(bot: mineflayer.Bot): void {
    const client = (bot as mineflayer.Bot & {
      _client?: {
        on?: (event: string, listener: (...args: any[]) => void) => void;
      };
    })._client;

    client?.on?.('packet', (_data: unknown, meta?: { name?: string }) => {
      const now = Date.now();
      this.lastPacketAt = now;
      if (meta?.name === 'keep_alive') {
        this.lastKeepAliveAt = now;
      }
    });

    bot.on('physicsTick', () => {
      this.lastPhysicsTickAt = Date.now();
    });

    bot.on('move', () => {
      this.lastMoveAt = Date.now();
    });
  }

  // --- Helper methods ---

  private getRuntimeDiagnostics(bot: mineflayer.Bot | null = this.bot): ReflexRuntimeDiagnostics {
    const state = this.shared.get();
    return {
      reflexState: state.reflexState,
      currentGoal: state.currentGoal,
      threatLevel: state.threatLevel,
      currentActionLabel: this.currentActionLabel,
      currentActionAgeMs: toAgeMs(this.currentActionStartedAt),
      lastTickAgeMs: toAgeMs(this.lastTickStartedAt),
      maxTickDriftMs: this.maxTickDriftMs,
      lastPacketAgeMs: toAgeMs(this.lastPacketAt),
      lastKeepAliveAgeMs: toAgeMs(this.lastKeepAliveAt),
      lastPhysicsTickAgeMs: toAgeMs(this.lastPhysicsTickAt),
      lastMoveAgeMs: toAgeMs(this.lastMoveAt),
      hp: bot?.health ?? null,
      hunger: bot?.food ?? null,
      position: bot
        ? {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z,
        }
        : null,
    };
  }

  private resetRuntimeDiagnostics(): void {
    this.currentActionLabel = null;
    this.currentActionInitialGoal = '';
    this.currentActionStartedAt = 0;
    this.currentActionToken = 0;
    this.lastTickStartedAt = 0;
    this.nextExpectedTickAt = 0;
    this.maxTickDriftMs = 0;
    this.lastPacketAt = 0;
    this.lastKeepAliveAt = 0;
    this.lastPhysicsTickAt = 0;
    this.lastMoveAt = 0;
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

export function resolveGoalBehavior(activeGoal: string): GoalBehavior {
  const goal = activeGoal.toLowerCase();

  if (goal.includes('寝') || goal.includes('sleep') || goal.includes('ベッド')) {
    return 'sleep';
  }
  if (goal.includes('拠点') || goal.includes('帰') || goal.includes('base')) {
    return 'return_to_base';
  }
  if (goal.includes('食料') || goal.includes('food') || goal.includes('狩')) {
    return 'gather_food';
  }
  if (
    goal.includes('クラフト') ||
    goal.includes('craft') ||
    goal.includes('作成') ||
    goal.includes('作業台') ||
    goal.includes('ツール') ||
    goal.includes('pickaxe') ||
    goal.includes('sword') ||
    goal.includes('axe') ||
    goal.includes('炉') ||
    goal.includes('furnace') ||
    goal.includes('stick') ||
    goal.includes('planks')
  ) {
    return 'craft';
  }
  if (goal.includes('木') || goal.includes('log') || goal.includes('伐採')) {
    return 'mine_logs';
  }
  if (goal.includes('石炭') || goal.includes('coal')) {
    return 'mine_coal';
  }
  if (goal.includes('石') || goal.includes('stone') || goal.includes('cobble')) {
    return 'mine_stone';
  }
  if (goal.includes('鉄') || goal.includes('iron')) {
    return 'mine_iron';
  }
  if (goal.includes('ダイヤ') || goal.includes('diamond')) {
    return 'mine_diamond';
  }
  if (goal.includes('探索') || goal.includes('explor')) {
    return 'explore';
  }
  return 'explore';
}

export function shouldForceCraftBootstrap(
  inventory: InventorySnapshotItem[],
  hasNearbyCraftingTable: boolean,
): boolean {
  const hasPickaxe = inventory.some(item => item.name.endsWith('_pickaxe'));
  if (hasPickaxe) {
    return false;
  }

  const countBy = (name: string) => inventory
    .filter(item => item.name === name)
    .reduce((sum, item) => sum + item.count, 0);
  const sumBySuffix = (suffix: string) => inventory
    .filter(item => item.name.endsWith(suffix))
    .reduce((sum, item) => sum + item.count, 0);

  const logCount = sumBySuffix('_log');
  const plankCount = sumBySuffix('_planks');
  const stickCount = countBy('stick');
  const cobbleCount = countBy('cobblestone');
  const hasCraftingTableItem = countBy('crafting_table') > 0;

  const canReachCraftingTable = hasNearbyCraftingTable || hasCraftingTableItem;
  const canBootstrapWorkbench = logCount > 0 || plankCount >= 4 || hasCraftingTableItem;
  const canBootstrapPickaxe = canReachCraftingTable && stickCount >= 2 && (cobbleCount >= 3 || plankCount >= 3);

  return canBootstrapWorkbench || canBootstrapPickaxe;
}

export function didBlockBreak(originalName: string, currentBlockName: string | null): boolean {
  return currentBlockName !== originalName;
}

export function isFoodItemName(name: string): boolean {
  return FOOD_ITEMS.has(name);
}

export function formatRuntimeDiagnostics(diagnostics: ReflexRuntimeDiagnostics): string {
  const position = diagnostics.position
    ? `${Math.round(diagnostics.position.x)},${Math.round(diagnostics.position.y)},${Math.round(diagnostics.position.z)}`
    : 'n/a';

  return [
    `state=${diagnostics.reflexState}`,
    `goal=${diagnostics.currentGoal || 'none'}`,
    `threat=${diagnostics.threatLevel}`,
    `action=${diagnostics.currentActionLabel ?? 'none'}`,
    `actionAge=${formatAgeMs(diagnostics.currentActionAgeMs)}`,
    `tickAge=${formatAgeMs(diagnostics.lastTickAgeMs)}`,
    `maxTickDrift=${diagnostics.maxTickDriftMs}ms`,
    `packetAge=${formatAgeMs(diagnostics.lastPacketAgeMs)}`,
    `keepAliveAge=${formatAgeMs(diagnostics.lastKeepAliveAgeMs)}`,
    `physicsAge=${formatAgeMs(diagnostics.lastPhysicsTickAgeMs)}`,
    `moveAge=${formatAgeMs(diagnostics.lastMoveAgeMs)}`,
    `hp=${diagnostics.hp ?? 'n/a'}`,
    `hunger=${diagnostics.hunger ?? 'n/a'}`,
    `pos=${position}`,
  ].join(' ');
}

export function describeDisconnectReason(
  reason: unknown,
  diagnostics?: ReflexRuntimeDiagnostics,
): string {
  if (reason instanceof Error && reason.message.trim()) {
    return diagnostics ? `${reason.message} | ${formatRuntimeDiagnostics(diagnostics)}` : reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return diagnostics ? `${reason} | ${formatRuntimeDiagnostics(diagnostics)}` : reason;
  }
  if (reason && typeof reason === 'object') {
    try {
      const message = JSON.stringify(reason);
      return diagnostics ? `${message} | ${formatRuntimeDiagnostics(diagnostics)}` : message;
    } catch {
      return 'unknown disconnect';
    }
  }
  return diagnostics ? `unknown disconnect | ${formatRuntimeDiagnostics(diagnostics)}` : 'unknown disconnect';
}

function hasBlockPosition(block: unknown): block is {
  name?: string;
  position: { x: number; y: number; z: number };
} {
  if (!block || typeof block !== 'object') return false;
  const position = (block as { position?: unknown }).position;
  if (!position || typeof position !== 'object') return false;
  const { x, y, z } = position as { x?: unknown; y?: unknown; z?: unknown };
  return typeof x === 'number' && typeof y === 'number' && typeof z === 'number';
}

function toAgeMs(timestamp: number): number | null {
  if (timestamp <= 0) return null;
  return Math.max(0, Date.now() - timestamp);
}

function formatAgeMs(ageMs: number | null): string {
  return ageMs === null ? 'n/a' : `${ageMs}ms`;
}

function formatActionError(error: unknown): string | null {
  if (error instanceof Error) {
    const source = error.name && error.name !== 'Error'
      ? `${error.name}: ${error.message}`
      : error.message;
    return normalizeErrorText(source);
  }
  if (typeof error === 'string') {
    return normalizeErrorText(error);
  }
  if (error && typeof error === 'object') {
    try {
      return normalizeErrorText(JSON.stringify(error));
    } catch {
      return 'unknown_error_object';
    }
  }
  return null;
}

function normalizeErrorText(raw: string): string {
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return 'unknown_error';
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}
