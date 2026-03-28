import { VoicevoxClient, type HttpAdapter } from './voicevox';

function createMockHttp(overrides: Partial<HttpAdapter> = {}): HttpAdapter {
  return {
    postJson: jest.fn().mockResolvedValue({ accent_phrases: [], speedScale: 1.0 }),
    postJsonGetBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-wav-data')),
    get: jest.fn().mockResolvedValue({ status: 200 }),
    ...overrides,
  };
}

describe('VoicevoxClient', () => {
  it('synthesizes text to audio buffer', async () => {
    const http = createMockHttp();
    const client = new VoicevoxClient('http://localhost:50021', 3, http);

    const result = await client.synthesize('こんにちは');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.isBuffer(result.value)).toBe(true);
      expect(result.value.length).toBeGreaterThan(0);
    }

    expect(http.postJson).toHaveBeenCalledWith(
      'http://localhost:50021/audio_query?text=%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF&speaker=3',
      {},
    );
    expect(http.postJsonGetBuffer).toHaveBeenCalledWith(
      'http://localhost:50021/synthesis?speaker=3',
      expect.any(Object),
    );
  });

  it('calls audio_query then synthesis in order', async () => {
    const callOrder: string[] = [];
    const http = createMockHttp({
      postJson: jest.fn().mockImplementation(async () => {
        callOrder.push('audio_query');
        return { accent_phrases: [] };
      }),
      postJsonGetBuffer: jest.fn().mockImplementation(async () => {
        callOrder.push('synthesis');
        return Buffer.from('wav');
      }),
    });
    const client = new VoicevoxClient('http://localhost:50021', 3, http);
    await client.synthesize('テスト');
    expect(callOrder).toEqual(['audio_query', 'synthesis']);
  });

  it('returns error when audio_query fails', async () => {
    const http = createMockHttp({
      postJson: jest.fn().mockRejectedValue(new Error('Connection refused')),
    });
    const client = new VoicevoxClient('http://localhost:50021', 3, http);
    const result = await client.synthesize('テスト');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Connection refused');
  });

  it('returns error when synthesis fails', async () => {
    const http = createMockHttp({
      postJsonGetBuffer: jest.fn().mockRejectedValue(new Error('500 error')),
    });
    const client = new VoicevoxClient('http://localhost:50021', 3, http);
    const result = await client.synthesize('テスト');
    expect(result.ok).toBe(false);
  });

  it('returns error for empty text', async () => {
    const http = createMockHttp();
    const client = new VoicevoxClient('http://localhost:50021', 3, http);
    const result = await client.synthesize('');
    expect(result.ok).toBe(false);
  });

  it('checks health via GET request', async () => {
    const http = createMockHttp({
      get: jest.fn().mockResolvedValue({ status: 200 }),
    });
    const client = new VoicevoxClient('http://localhost:50021', 3, http);
    const healthy = await client.isHealthy();
    expect(healthy).toBe(true);
    expect(http.get).toHaveBeenCalledWith('http://localhost:50021/version');
  });

  it('returns unhealthy when GET fails', async () => {
    const http = createMockHttp({
      get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const client = new VoicevoxClient('http://localhost:50021', 3, http);
    const healthy = await client.isHealthy();
    expect(healthy).toBe(false);
  });

  it('uses specified speaker ID', async () => {
    const http = createMockHttp();
    const client = new VoicevoxClient('http://localhost:50021', 8, http);
    await client.synthesize('テスト');
    expect(http.postJson).toHaveBeenCalledWith(
      expect.stringContaining('speaker=8'),
      expect.any(Object),
    );
  });
});
