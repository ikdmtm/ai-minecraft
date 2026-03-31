import { HudWriter, type HudData, type HudWriterDeps, formatHealthBar, formatHungerBar, formatSurvivalDuration, formatPosition } from './hudWriter.js';

function makeHudData(overrides: Partial<HudData> = {}): HudData {
  return {
    health: 20,
    maxHealth: 20,
    hunger: 20,
    position: { x: 100.5, y: 64.0, z: -200.3 },
    generation: 1,
    survivalStartTime: Date.now() - 3_723_000,
    bestRecordMinutes: 120,
    currentGoal: '木を伐採する',
    threatLevel: 'safe',
    reflexState: 'exploring',
    commentary: 'きれいな景色だなぁ',
    emotionLabel: 'content',
    ...overrides,
  };
}

function createMockDeps(): HudWriterDeps & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    writeFile: (path: string, content: string) => { written.set(path, content); },
  };
}

describe('HudWriter', () => {
  describe('formatHealthBar', () => {
    it('should show full health', () => {
      expect(formatHealthBar(20, 20)).toBe('HP 20/20');
    });

    it('should show partial health', () => {
      expect(formatHealthBar(8, 20)).toBe('HP  8/20');
    });

    it('should show zero health', () => {
      expect(formatHealthBar(0, 20)).toBe('HP  0/20');
    });

    it('should round fractional health', () => {
      expect(formatHealthBar(15.5, 20)).toBe('HP 16/20');
    });
  });

  describe('formatHungerBar', () => {
    it('should show full hunger', () => {
      expect(formatHungerBar(20)).toBe('Food 20/20');
    });

    it('should show partial hunger', () => {
      expect(formatHungerBar(6)).toBe('Food  6/20');
    });
  });

  describe('formatSurvivalDuration', () => {
    it('should format minutes and seconds', () => {
      const start = Date.now() - (5 * 60_000 + 30_000);
      const result = formatSurvivalDuration(start);
      expect(result).toMatch(/^0:05:\d{2}$/);
    });

    it('should format hours', () => {
      const start = Date.now() - (62 * 60_000 + 15_000);
      const result = formatSurvivalDuration(start);
      expect(result).toMatch(/^1:02:\d{2}$/);
    });

    it('should handle zero duration', () => {
      const result = formatSurvivalDuration(Date.now());
      expect(result).toBe('0:00:00');
    });
  });

  describe('formatPosition', () => {
    it('should format xyz coordinates', () => {
      expect(formatPosition({ x: 100.7, y: 64.2, z: -200.9 })).toBe('X:101 Y:64 Z:-201');
    });
  });

  describe('HudWriter update and write', () => {
    let writer: HudWriter;
    let deps: ReturnType<typeof createMockDeps>;

    beforeEach(() => {
      deps = createMockDeps();
      writer = new HudWriter('/tmp/hud', deps);
    });

    afterEach(() => {
      writer.stop();
    });

    it('should write stats file on flush', () => {
      writer.update(makeHudData({ health: 16, hunger: 14 }));
      writer.flush();

      const stats = deps.written.get('/tmp/hud/ai-mc-hud-stats.txt');
      expect(stats).toBeDefined();
      expect(stats).toContain('HP 16/20');
      expect(stats).toContain('Food 14/20');
    });

    it('should write info file with generation and survival', () => {
      writer.update(makeHudData({ generation: 3 }));
      writer.flush();

      const info = deps.written.get('/tmp/hud/ai-mc-hud-info.txt');
      expect(info).toBeDefined();
      expect(info).toContain('Gen #3');
      expect(info).toMatch(/\d+:\d{2}:\d{2}/);
    });

    it('should write goal file', () => {
      writer.update(makeHudData({ currentGoal: 'ダイヤモンドを探す', threatLevel: 'caution' }));
      writer.flush();

      const goal = deps.written.get('/tmp/hud/ai-mc-hud-goal.txt');
      expect(goal).toBeDefined();
      expect(goal).toContain('ダイヤモンドを探す');
    });

    it('should write commentary file', () => {
      writer.update(makeHudData({ commentary: 'クリーパーが近い！気をつけないと...' }));
      writer.flush();

      const commentary = deps.written.get('/tmp/hud/ai-mc-hud-commentary.txt');
      expect(commentary).toBeDefined();
      expect(commentary).toContain('クリーパーが近い！気をつけないと...');
    });

    it('should truncate long commentary', () => {
      const longText = 'あ'.repeat(200);
      writer.update(makeHudData({ commentary: longText }));
      writer.flush();

      const commentary = deps.written.get('/tmp/hud/ai-mc-hud-commentary.txt')!;
      expect(commentary.length).toBeLessThan(200);
    });

    it('should include threat level indicator in info', () => {
      writer.update(makeHudData({ threatLevel: 'critical' }));
      writer.flush();

      const info = deps.written.get('/tmp/hud/ai-mc-hud-info.txt');
      expect(info).toContain('CRITICAL');
    });

    it('should include position in stats', () => {
      writer.update(makeHudData({ position: { x: 50, y: 72, z: -300 } }));
      writer.flush();

      const stats = deps.written.get('/tmp/hud/ai-mc-hud-stats.txt');
      expect(stats).toContain('X:50');
      expect(stats).toContain('Y:72');
      expect(stats).toContain('Z:-300');
    });

    it('should include emotion and reflex state in info', () => {
      writer.update(makeHudData({ emotionLabel: 'panicked', reflexState: 'fleeing' }));
      writer.flush();

      const info = deps.written.get('/tmp/hud/ai-mc-hud-info.txt');
      expect(info).toBeDefined();
    });

    it('should clear commentary when empty', () => {
      writer.update(makeHudData({ commentary: '' }));
      writer.flush();

      const commentary = deps.written.get('/tmp/hud/ai-mc-hud-commentary.txt');
      expect(commentary).toBe('');
    });
  });

  describe('HudWriter start/stop', () => {
    it('should periodically flush when started', async () => {
      const deps = createMockDeps();
      const writer = new HudWriter('/tmp/hud', deps, 50);
      writer.update(makeHudData());
      writer.start();

      await new Promise(r => setTimeout(r, 120));
      writer.stop();

      expect(deps.written.size).toBeGreaterThan(0);
    });

    it('should not write after stop', async () => {
      const deps = createMockDeps();
      const writer = new HudWriter('/tmp/hud', deps, 50);
      writer.update(makeHudData());
      writer.start();

      await new Promise(r => setTimeout(r, 80));
      writer.stop();
      deps.written.clear();

      await new Promise(r => setTimeout(r, 100));
      expect(deps.written.size).toBe(0);
    });

    it('should return file paths', () => {
      const deps = createMockDeps();
      const writer = new HudWriter('/tmp/hud', deps);
      const paths = writer.getFilePaths();

      expect(paths.stats).toBe('/tmp/hud/ai-mc-hud-stats.txt');
      expect(paths.info).toBe('/tmp/hud/ai-mc-hud-info.txt');
      expect(paths.goal).toBe('/tmp/hud/ai-mc-hud-goal.txt');
      expect(paths.commentary).toBe('/tmp/hud/ai-mc-hud-commentary.txt');
    });
  });
});
