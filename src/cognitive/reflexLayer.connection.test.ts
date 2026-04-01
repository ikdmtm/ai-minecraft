import { EventEmitter } from 'events';

jest.mock('mineflayer', () => ({
  __esModule: true,
  default: {
    createBot: jest.fn(),
  },
}));

jest.mock('mineflayer-pathfinder', () => ({
  pathfinder: jest.fn(),
  Movements: jest.fn().mockImplementation(() => ({})),
  goals: {},
}));

import mineflayer from 'mineflayer';
import { ReflexLayer } from './reflexLayer';
import { SharedStateBus } from './sharedState';

class MockBot extends EventEmitter {
  username = 'AI_Rei';
  health = 20;
  food = 20;
  _client = new EventEmitter();
  oxygenLevel = 300;
  isRaining = false;
  thunderState = 0;
  entities = {};
  entity = {
    position: {
      x: 0,
      y: 64,
      z: 0,
      offset: () => ({ x: 0, y: 63, z: 0 }),
      distanceTo: () => 0,
    },
  };
  inventory = {
    items: () => [],
    emptySlotCount: () => 10,
    slots: [],
  };
  time = { timeOfDay: 0 };
  pathfinder = {
    stop: jest.fn(),
    setMovements: jest.fn(),
  };
  loadPlugin = jest.fn();
  quit = jest.fn(() => {
    this.emit('end', 'manual quit');
  });
  chat = jest.fn();
  blockAt = jest.fn(() => ({
    name: 'stone',
    biome: { name: 'plains' },
    light: 15,
  }));
}

describe('ReflexLayer connection lifecycle', () => {
  const createBotMock = mineflayer.createBot as jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    createBotMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('marks the bot disconnected and notifies when the connection ends unexpectedly', async () => {
    const bot = new MockBot();
    createBotMock.mockReturnValue(bot);

    const layer = new ReflexLayer(new SharedStateBus());
    const events = {
      onDeath: jest.fn(),
      onReactiveAction: jest.fn(),
      onStateChange: jest.fn(),
      onDisconnect: jest.fn(),
    };

    const connectPromise = layer.connect({ host: 'localhost', port: 25565, username: 'AI_Rei' }, events);
    bot.emit('spawn');
    await connectPromise;

    expect(layer.isConnected()).toBe(true);

    bot._client.emit('packet', {}, { name: 'keep_alive' });
    bot.emit('physicsTick');
    bot.emit('move');
    jest.advanceTimersByTime(250);
    bot.emit('end', 'socket closed');

    expect(layer.isConnected()).toBe(false);
    expect(events.onDisconnect).toHaveBeenCalledWith(expect.stringContaining('socket closed'));
    expect(events.onDisconnect).toHaveBeenCalledWith(expect.stringContaining('state=idle'));
    expect(events.onDisconnect).toHaveBeenCalledWith(expect.stringContaining('keepAliveAge=250ms'));
    expect(events.onDisconnect).toHaveBeenCalledWith(expect.stringContaining('moveAge=250ms'));
  });

  it('does not report the planned disconnect triggered by shutdown', async () => {
    const bot = new MockBot();
    createBotMock.mockReturnValue(bot);

    const layer = new ReflexLayer(new SharedStateBus());
    const events = {
      onDeath: jest.fn(),
      onReactiveAction: jest.fn(),
      onStateChange: jest.fn(),
      onDisconnect: jest.fn(),
    };

    const connectPromise = layer.connect({ host: 'localhost', port: 25565, username: 'AI_Rei' }, events);
    bot.emit('spawn');
    await connectPromise;

    layer.disconnect();

    expect(layer.isConnected()).toBe(false);
    expect(events.onDisconnect).not.toHaveBeenCalled();
  });
});
