import { buildMemory, type MemorySource } from './memoryBuilder';

function createSource(overrides: Partial<MemorySource> = {}): MemorySource {
  return {
    getRecentDeaths: jest.fn().mockReturnValue([
      { generation: 5, survivalMinutes: 45, cause: 'クリーパー爆発', lesson: '夜は拠点に戻る' },
      { generation: 4, survivalMinutes: 240, cause: 'スケルトン', lesson: '洞窟では盾を持つ' },
      { generation: 3, survivalMinutes: 10, cause: '溶岩', lesson: '下掘りをしない' },
    ]),
    getBestRecord: jest.fn().mockReturnValue(240),
    getTotalDeaths: jest.fn().mockReturnValue(5),
    ...overrides,
  };
}

describe('buildMemory', () => {
  it('returns Memory with correct totalDeaths', () => {
    const source = createSource();
    const memory = buildMemory(source);
    expect(memory.totalDeaths).toBe(5);
  });

  it('returns Memory with correct bestRecordMinutes', () => {
    const source = createSource();
    const memory = buildMemory(source);
    expect(memory.bestRecordMinutes).toBe(240);
  });

  it('returns recent deaths limited to 5', () => {
    const source = createSource();
    const memory = buildMemory(source);
    expect(memory.recentDeaths).toHaveLength(3);
    expect(source.getRecentDeaths).toHaveBeenCalledWith(5);
  });

  it('maps death records correctly', () => {
    const source = createSource();
    const memory = buildMemory(source);
    expect(memory.recentDeaths[0]).toEqual({
      generation: 5,
      survivalMinutes: 45,
      cause: 'クリーパー爆発',
      lesson: '夜は拠点に戻る',
    });
  });

  it('handles empty death history', () => {
    const source = createSource({
      getRecentDeaths: jest.fn().mockReturnValue([]),
      getTotalDeaths: jest.fn().mockReturnValue(0),
      getBestRecord: jest.fn().mockReturnValue(0),
    });
    const memory = buildMemory(source);
    expect(memory.totalDeaths).toBe(0);
    expect(memory.bestRecordMinutes).toBe(0);
    expect(memory.recentDeaths).toEqual([]);
  });

  it('custom limit overrides default 5', () => {
    const source = createSource();
    buildMemory(source, 3);
    expect(source.getRecentDeaths).toHaveBeenCalledWith(3);
  });
});
