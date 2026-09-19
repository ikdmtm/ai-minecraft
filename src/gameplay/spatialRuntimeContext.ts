import type mineflayer from 'mineflayer';
import { normalizeMemoryDimension } from './worldMemory.js';

export interface SpatialTicket { readonly epoch: number; readonly key: string; }
export interface SpatialContextHooks {
  invalidate(reason: string): void;
  ready(): void;
}

/** Runtime lease, not persistent world identity. Every respawn invalidates old
 * work, including A -> B -> A and same-dimension respawn. No gameplay decisions.
 */
export class SpatialRuntimeContext {
  private epoch = 0;
  private key: string;
  private available = false;
  private spawned = false;
  private positioned = false;
  private ended = false;
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly removeListeners: Array<() => void> = [];

  constructor(
    private readonly bot: mineflayer.Bot,
    private readonly worldId: () => string,
    private readonly hooks: SpatialContextHooks,
  ) {
    this.key = this.readKey();
    const client = (bot as any)._client;
    const listen = (emitter: any, event: string, handler: (...args: any[]) => void, prepend = false) => {
      if (!emitter?.on) return;
      if (prepend && emitter.prependListener) emitter.prependListener(event, handler);
      else emitter.on(event, handler);
      this.removeListeners.push(() => emitter.removeListener(event, handler));
    };
    // Run before Mineflayer's packet handlers change dimension/replace the world.
    if (client?.prependListener) {
      listen(client, 'login', () => this.begin('login'), true);
      listen(client, 'respawn', () => this.begin('respawn'), true);
    } else {
      listen(bot, 'respawn', () => this.begin('respawn'));
    }
    listen(bot, 'spawn', () => { if (!this.ended) { this.spawned = true; this.refresh(); } });
    listen(bot, 'forcedMove', () => { if (!this.ended) { this.positioned = true; this.refresh(); } });
    listen(bot, 'chunkColumnLoad', () => this.refresh());
    listen(bot, 'game', () => this.refresh());
    listen(bot, 'death', () => { this.begin('death'); this.ended = true; });
    listen(bot, 'end', () => { this.begin('disconnect'); this.ended = true; });
    // Some chunk writes finish after the event callback; never assume a timeout
    // implies readiness. This is an observation gate, not an LLM polling loop.
    this.timer = setInterval(() => this.refresh(), 100);
    this.timer.unref?.();
  }

  private readKey(): string {
    return JSON.stringify([this.worldId(), normalizeMemoryDimension(this.bot.game?.dimension)]);
  }

  private begin(reason: string): void {
    if (this.disposed) return;
    this.epoch++;
    this.available = false;
    this.spawned = false;
    this.positioned = false;
    this.ended = false;
    this.key = this.readKey();
    this.hooks.invalidate(reason);
  }

  private refresh(): void {
    if (this.disposed || this.ended) return;
    const key = this.readKey();
    if (key !== this.key) {
      // The packet begin() precedes game.dimension's update. While already
      // gated this is the same transition, so do not discard fresh spawn flags.
      if (this.available) this.begin('context_changed');
      this.key = key;
    }
    if (this.available || !this.spawned || !this.positioned) return;
    if (normalizeMemoryDimension(this.bot.game?.dimension) == null) return;
    const p = this.bot.entity?.position;
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return;
    try { if (!this.bot.blockAt(p)) return; } catch { return; }
    this.available = true;
    this.hooks.ready();
  }

  isReady(): boolean {
    return !this.disposed && !this.ended && this.available && this.readKey() === this.key;
  }

  ticket(): SpatialTicket {
    if (!this.isReady()) throw new Error('task_replan:spatial_not_ready');
    return { epoch: this.epoch, key: this.key };
  }

  matches(ticket: SpatialTicket): boolean {
    return this.isReady() && ticket.epoch === this.epoch && ticket.key === this.key;
  }

  getEpoch(): number { return this.epoch; }

  async waitUntilReady(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.isReady()) {
      if (this.disposed || this.ended) throw new Error('spatial_start_cancelled');
      if (Date.now() >= deadline) throw new Error('spatial_readiness_timeout');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.begin('runtime_stop');
    this.disposed = true;
    clearInterval(this.timer);
    for (const remove of this.removeListeners.splice(0)) remove();
  }
}
