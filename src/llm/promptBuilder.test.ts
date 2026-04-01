import { buildSystemPrompt, buildUserMessage } from './promptBuilder';
import type { GameState } from '../types/gameState';

function sampleGameState(): GameState {
  return {
    player: {
      hp: 16, maxHp: 20, hunger: 18,
      position: { x: 120, y: 64, z: -45 },
      biome: 'forest',
      equipment: {
        hand: 'iron_sword', helmet: null,
        chestplate: 'iron_chestplate', leggings: null, boots: null,
      },
      inventorySummary: ['cobblestone x64', 'iron_ingot x3', 'bread x8'],
    },
    world: {
      timeOfDay: 'night', minecraftTime: 18200,
      weather: 'clear', lightLevel: 4,
      nearbyEntities: [
        { type: 'zombie', distance: 12, direction: 'north' },
      ],
      nearbyBlocksOfInterest: [
        { type: 'iron_ore', distance: 6, direction: 'below' },
      ],
    },
    base: {
      known: true,
      position: { x: 115, y: 64, z: -40 },
      distance: 7, hasBed: true, hasFurnace: true, hasCraftingTable: true,
    },
    pacing: {
      currentActionCategory: 'mining',
      categoryDurationMinutes: 12,
      survivalTimeMinutes: 87,
      progressPhase: 'stable',
      bestRecordMinutes: 240,
    },
    previousPlan: {
      goal: '鉄鉱石を採掘して鉄装備を完成させる',
      status: 'in_progress',
      progress: '鉄インゴット3個取得',
    },
    recentEvents: [
      { time: '2min_ago', event: 'reactive_flee', detail: 'クリーパー接近により一時退避' },
    ],
    stagnationWarning: false,
    memory: {
      totalDeaths: 5,
      bestRecordMinutes: 240,
      recentDeaths: [
        { generation: 5, survivalMinutes: 45, cause: 'クリーパー爆発', lesson: '夜は拠点に戻る' },
      ],
    },
  };
}

describe('buildSystemPrompt', () => {
  it('includes character name', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('星守レイ');
  });

  it('includes output format instruction', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('action');
    expect(prompt).toContain('commentary');
    expect(prompt).toContain('threat_level');
  });

  it('includes pacing value', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('退屈');
  });

  it('includes survival priority', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('生存');
  });

  it('includes the unified Rei speech guidelines', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('一人称は「わたし」');
    expect(prompt).toContain('荒い男性口調は使わない');
    expect(prompt).toContain('知的で観察好き');
    expect(prompt).toContain('視聴者に媚びすぎない');
  });
});

describe('buildUserMessage', () => {
  it('returns valid JSON string', () => {
    const msg = buildUserMessage(sampleGameState());
    expect(() => JSON.parse(msg)).not.toThrow();
  });

  it('includes player HP', () => {
    const msg = buildUserMessage(sampleGameState());
    const parsed = JSON.parse(msg);
    expect(parsed.player.hp).toBe(16);
  });

  it('includes world time', () => {
    const msg = buildUserMessage(sampleGameState());
    const parsed = JSON.parse(msg);
    expect(parsed.world.time_of_day).toBe('night');
  });

  it('includes memory with death history', () => {
    const msg = buildUserMessage(sampleGameState());
    const parsed = JSON.parse(msg);
    expect(parsed.memory.total_deaths).toBe(5);
    expect(parsed.memory.recent_deaths).toHaveLength(1);
  });

  it('includes pacing info', () => {
    const msg = buildUserMessage(sampleGameState());
    const parsed = JSON.parse(msg);
    expect(parsed.pacing.current_action_category).toBe('mining');
    expect(parsed.pacing.survival_time_minutes).toBe(87);
  });

  it('includes stagnation_warning', () => {
    const state = sampleGameState();
    state.stagnationWarning = true;
    const msg = buildUserMessage(state);
    const parsed = JSON.parse(msg);
    expect(parsed.stagnation_warning).toBe(true);
  });

  it('includes base info when known', () => {
    const msg = buildUserMessage(sampleGameState());
    const parsed = JSON.parse(msg);
    expect(parsed.base.known).toBe(true);
    expect(parsed.base.has_bed).toBe(true);
  });

  it('includes recent events', () => {
    const msg = buildUserMessage(sampleGameState());
    const parsed = JSON.parse(msg);
    expect(parsed.recent_events).toHaveLength(1);
    expect(parsed.recent_events[0].event).toBe('reactive_flee');
  });
});
