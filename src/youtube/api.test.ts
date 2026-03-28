import { YouTubeClient, type YouTubeApiAdapter } from './api';

function createMockAdapter(): jest.Mocked<YouTubeApiAdapter> {
  return {
    createBroadcast: jest.fn().mockResolvedValue({
      broadcastId: 'broadcast-123',
      streamId: 'stream-456',
      streamKey: 'xxxx-xxxx-xxxx-xxxx',
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
    }),
    transitionBroadcast: jest.fn().mockResolvedValue(undefined),
    updateBroadcast: jest.fn().mockResolvedValue(undefined),
    endBroadcast: jest.fn().mockResolvedValue(undefined),
    uploadThumbnail: jest.fn().mockResolvedValue(undefined),
    getStreamStatus: jest.fn().mockResolvedValue('active'),
  };
}

describe('YouTubeClient', () => {
  let adapter: jest.Mocked<YouTubeApiAdapter>;
  let client: YouTubeClient;

  beforeEach(() => {
    adapter = createMockAdapter();
    client = new YouTubeClient(adapter);
  });

  describe('createLiveBroadcast', () => {
    it('creates broadcast with correct metadata', async () => {
      const result = await client.createLiveBroadcast({
        title: '【AI Minecraft】星守レイのハードコア生存実験 #Gen5',
        description: 'テスト概要欄',
        tags: ['Minecraft', 'AI'],
        categoryId: '20',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.broadcastId).toBe('broadcast-123');
        expect(result.value.streamKey).toBe('xxxx-xxxx-xxxx-xxxx');
      }

      expect(adapter.createBroadcast).toHaveBeenCalledWith({
        title: '【AI Minecraft】星守レイのハードコア生存実験 #Gen5',
        description: 'テスト概要欄',
        tags: ['Minecraft', 'AI'],
        categoryId: '20',
      });
    });

    it('returns error on API failure', async () => {
      adapter.createBroadcast.mockRejectedValue(new Error('API quota exceeded'));
      const result = await client.createLiveBroadcast({
        title: 'test', description: '', tags: [], categoryId: '20',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('API quota exceeded');
    });
  });

  describe('goLive', () => {
    it('transitions broadcast to live status', async () => {
      const result = await client.goLive('broadcast-123');
      expect(result.ok).toBe(true);
      expect(adapter.transitionBroadcast).toHaveBeenCalledWith('broadcast-123', 'live');
    });

    it('returns error on transition failure', async () => {
      adapter.transitionBroadcast.mockRejectedValue(new Error('stream not active'));
      const result = await client.goLive('broadcast-123');
      expect(result.ok).toBe(false);
    });
  });

  describe('endBroadcast', () => {
    it('transitions to complete then ends', async () => {
      const result = await client.endBroadcast('broadcast-123');
      expect(result.ok).toBe(true);
      expect(adapter.transitionBroadcast).toHaveBeenCalledWith('broadcast-123', 'complete');
    });

    it('handles already-ended broadcast gracefully', async () => {
      adapter.transitionBroadcast.mockRejectedValue(new Error('redundantTransition'));
      const result = await client.endBroadcast('broadcast-123');
      expect(result.ok).toBe(true);
    });
  });

  describe('updateTitle', () => {
    it('updates broadcast title', async () => {
      const result = await client.updateTitle('broadcast-123', '新しいタイトル');
      expect(result.ok).toBe(true);
      expect(adapter.updateBroadcast).toHaveBeenCalledWith('broadcast-123', { title: '新しいタイトル' });
    });
  });

  describe('uploadThumbnail', () => {
    it('uploads thumbnail for broadcast', async () => {
      const result = await client.uploadThumbnail('broadcast-123', '/tmp/thumb.png');
      expect(result.ok).toBe(true);
      expect(adapter.uploadThumbnail).toHaveBeenCalledWith('broadcast-123', '/tmp/thumb.png');
    });

    it('returns error on upload failure', async () => {
      adapter.uploadThumbnail.mockRejectedValue(new Error('file not found'));
      const result = await client.uploadThumbnail('broadcast-123', '/tmp/nope.png');
      expect(result.ok).toBe(false);
    });
  });

  describe('getStreamStatus', () => {
    it('returns stream health status', async () => {
      const result = await client.getStreamStatus('stream-456');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('active');
    });
  });

  describe('isHealthy', () => {
    it('returns true when stream is active', async () => {
      const healthy = await client.isHealthy('stream-456');
      expect(healthy).toBe(true);
    });

    it('returns false when stream is inactive', async () => {
      adapter.getStreamStatus.mockResolvedValue('inactive');
      const healthy = await client.isHealthy('stream-456');
      expect(healthy).toBe(false);
    });

    it('returns false on API error', async () => {
      adapter.getStreamStatus.mockRejectedValue(new Error('network'));
      const healthy = await client.isHealthy('stream-456');
      expect(healthy).toBe(false);
    });
  });
});
