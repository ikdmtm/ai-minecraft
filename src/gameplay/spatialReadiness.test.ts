import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { SpatialRuntimeContext } from './spatialRuntimeContext.js';

describe('spatial startup deadline and error boundaries', () => {
  let context: SpatialRuntimeContext;
  let bot: any;
  beforeEach(() => {
    jest.useFakeTimers();
    bot = Object.assign(new EventEmitter(), {
      _client: new EventEmitter(), game: { dimension: 'overworld' },
      entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null,
    });
    context = new SpatialRuntimeContext(bot, () => 'fixture-world', { invalidate: jest.fn(), ready: jest.fn() });
  });
  afterEach(() => { context.dispose(); jest.useRealTimers(); });

  test('a deadline fails closed instead of declaring a missing column ready', async () => {
    const result = context.waitUntilReady(200).catch(error => error.message);
    bot.emit('spawn'); bot.emit('forcedMove');
    await jest.advanceTimersByTimeAsync(250);
    expect(await result).toBe('spatial_readiness_timeout');
    expect(context.isReady()).toBe(false);
  });

  test.each(['error', 'end'])('%s during startup terminates readiness without an unhandled event', async event => {
    const result = context.waitUntilReady().catch(error => error.message);
    expect(() => bot.emit(event, new Error('fixture connection failure'))).not.toThrow();
    await jest.advanceTimersByTimeAsync(50);
    expect(await result).toBe('spatial_start_cancelled');
    expect(context.isReady()).toBe(false);
  });

  test('dispose cancels a pending startup and removes its timer/listeners', async () => {
    const result = context.waitUntilReady().catch(error => error.message);
    context.dispose();
    await jest.advanceTimersByTimeAsync(50);
    expect(await result).toBe('spatial_start_cancelled');
    expect(jest.getTimerCount()).toBe(0);
    expect(bot.listenerCount('error')).toBe(0);
  });
});
