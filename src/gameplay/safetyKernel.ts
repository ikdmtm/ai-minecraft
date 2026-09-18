import mineflayer from 'mineflayer';
import type { SharedStateBus, CognitiveThreatLevel } from '../cognitive/sharedState.js';
import type { TypedGameplayDecision } from './typedActions.js';
import { SkillExecutor } from './skillExecutor.js';

const SAFETY_TICK_MS = 100;
const CRITICAL_HP = 4;
const CREEPER_FLEE_DISTANCE = 5;
const LOW_OXYGEN_LEVEL = 5;

export class SafetyKernel {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSignature = '';
  private lastDispatchAt = 0;

  constructor(
    private readonly bot: mineflayer.Bot,
    private readonly shared: SharedStateBus,
    private readonly executor: SkillExecutor,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), SAFETY_TICK_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    try {
      const hostiles = Object.values(this.bot.entities)
        .filter(entity => entity && entity !== this.bot.entity && entity.name && isHostile(entity.name))
        .map(entity => ({ entity, distance: this.bot.entity.position.distanceTo(entity.position) }))
        .sort((a, b) => a.distance - b.distance);

      const closest = hostiles[0]?.distance ?? Infinity;
      this.shared.setThreatLevel(threatLevel(this.bot.health, closest, this.bot.food));

      const creeper = hostiles.find(item => item.entity.name === 'creeper' && item.distance < CREEPER_FLEE_DISTANCE);
      if (creeper) {
        this.dispatch({
          action: 'FLEE', confidence: 1, source: 'safety',
          reason: `creeper_${creeper.distance.toFixed(1)}m`,
        });
        return;
      }

      const onFire = Boolean((this.bot.entity as any).isOnFire);
      const below = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0))?.name ?? '';
      if (onFire || below.includes('lava')) {
        this.dispatch({
          action: 'FLEE', confidence: 1, source: 'safety',
          reason: onFire ? 'on_fire' : `hazard_below:${below}`,
        });
        return;
      }

      const oxygen = this.bot.oxygenLevel ?? 20;
      if (isHeadSubmerged(this.bot) && oxygen <= LOW_OXYGEN_LEVEL) {
        this.dispatch({
          action: 'FLEE', confidence: 1, source: 'safety', direction: 'N',
          reason: `low_oxygen:${oxygen}`,
        });
        return;
      }

      if (this.bot.health <= CRITICAL_HP && hasFood(this.bot)) {
        this.dispatch({
          action: 'EAT', confidence: 1, source: 'safety', reason: `critical_hp:${this.bot.health}`,
        });
      }
    } catch {
      // Safety checks are best effort and must never crash gameplay.
    }
  }

  private dispatch(decision: TypedGameplayDecision): void {
    const signature = `${decision.action}:${decision.reason ?? ''}`;
    const now = Date.now();
    if (signature === this.lastSignature && now - this.lastDispatchAt < 1_000) return;
    this.lastSignature = signature;
    this.lastDispatchAt = now;
    this.shared.pushEvent({
      type: 'safety_override',
      detail: `${decision.action}:${decision.reason ?? ''}`,
      importance: 'critical',
    });
    this.executor.dispatch(decision, null, 'safety');
  }
}

function threatLevel(hp: number, closestHostile: number, hunger: number): CognitiveThreatLevel {
  if (hp <= 4 || closestHostile < 3) return 'critical';
  if (hp <= 8 || closestHostile < 7) return 'danger';
  if (closestHostile < 16 || hunger < 6) return 'caution';
  return 'safe';
}

function hasFood(bot: mineflayer.Bot): boolean {
  return bot.inventory.items().some(item => [
    'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'apple', 'golden_carrot', 'sweet_berries', 'beef', 'porkchop', 'chicken', 'mutton',
  ].includes(item.name));
}

function isHostile(name: string): boolean {
  return [
    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'drowned', 'husk',
    'stray', 'pillager', 'vindicator', 'evoker', 'ravager', 'slime', 'phantom', 'blaze', 'ghast',
  ].includes(name);
}


function isHeadSubmerged(bot: mineflayer.Bot): boolean {
  const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name ?? '';
  return head === 'water' || head === 'bubble_column';
}
