import type { youtube_v3 } from 'googleapis';
import { GoogleYouTubeApiAdapter } from './googleApiAdapter';

/** googleapis の型と jest.Mock が衝突するためテスト専用の緩いモック型 */
type MockYoutubeApi = {
  liveBroadcasts: {
    insert: jest.Mock;
    bind: jest.Mock;
    list: jest.Mock;
    update: jest.Mock;
    transition: jest.Mock;
  };
  liveStreams: {
    insert: jest.Mock;
    list: jest.Mock;
  };
  thumbnails: {
    set: jest.Mock;
  };
};

function createMockYoutube(): MockYoutubeApi {
  return {
    liveBroadcasts: {
      insert: jest.fn(),
      bind: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      transition: jest.fn(),
    },
    liveStreams: {
      insert: jest.fn(),
      list: jest.fn(),
    },
    thumbnails: {
      set: jest.fn(),
    },
  };
}

function asYoutube(mock: MockYoutubeApi): youtube_v3.Youtube {
  return mock as unknown as youtube_v3.Youtube;
}

describe('GoogleYouTubeApiAdapter', () => {
  const params = {
    title: 'Test Live',
    description: 'Desc',
    tags: ['Minecraft'],
    categoryId: '20',
    privacyStatus: 'unlisted' as const,
  };

  it('createBroadcast inserts broadcast, stream, binds, returns rtmpUrl', async () => {
    const youtube = createMockYoutube();
    youtube.liveBroadcasts.insert.mockResolvedValue({
      data: { id: 'b1' },
    });
    youtube.liveStreams.insert.mockResolvedValue({
      data: {
        id: 's1',
        cdn: {
          ingestionInfo: {
            streamName: 'key-1234',
            ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2',
          },
        },
      },
    });
    youtube.liveBroadcasts.bind.mockResolvedValue({ data: {} });

    const adapter = new GoogleYouTubeApiAdapter(asYoutube(youtube));
    const result = await adapter.createBroadcast(params);

    expect(result.broadcastId).toBe('b1');
    expect(result.streamId).toBe('s1');
    expect(result.streamKey).toBe('key-1234');
    expect(result.rtmpUrl).toBe('rtmp://a.rtmp.youtube.com/live2/key-1234');
    expect(youtube.liveBroadcasts.bind).toHaveBeenCalledWith({
      part: ['id', 'snippet'],
      id: 'b1',
      streamId: 's1',
    });
    expect(youtube.liveBroadcasts.insert).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({
        status: expect.objectContaining({
          privacyStatus: 'unlisted',
        }),
      }),
    }));
  });

  it('createBroadcast throws when streamName missing', async () => {
    const youtube = createMockYoutube();
    youtube.liveBroadcasts.insert.mockResolvedValue({ data: { id: 'b1' } });
    youtube.liveStreams.insert.mockResolvedValue({
      data: { id: 's1', cdn: {} },
    });

    const adapter = new GoogleYouTubeApiAdapter(asYoutube(youtube));
    await expect(adapter.createBroadcast(params)).rejects.toThrow('streamName');
  });

  it('transitionBroadcast calls liveBroadcasts.transition', async () => {
    const youtube = createMockYoutube();
    youtube.liveBroadcasts.transition.mockResolvedValue({ data: {} });
    const adapter = new GoogleYouTubeApiAdapter(asYoutube(youtube));
    await adapter.transitionBroadcast('b1', 'live');
    expect(youtube.liveBroadcasts.transition).toHaveBeenCalledWith({
      broadcastStatus: 'live',
      id: 'b1',
      part: ['id', 'status'],
    });
  });

  it('updateBroadcast lists then updates snippet', async () => {
    const youtube = createMockYoutube();
    youtube.liveBroadcasts.list.mockResolvedValue({
      data: {
        items: [
          {
            snippet: {
              title: 'Old',
              description: 'D',
              scheduledStartTime: '2026-01-01T00:00:00Z',
            },
          },
        ],
      },
    });
    youtube.liveBroadcasts.update.mockResolvedValue({ data: {} });

    const adapter = new GoogleYouTubeApiAdapter(asYoutube(youtube));
    await adapter.updateBroadcast('b1', { title: 'New' });

    expect(youtube.liveBroadcasts.update).toHaveBeenCalledWith({
      part: ['snippet'],
      requestBody: {
        id: 'b1',
        snippet: {
          title: 'New',
          description: 'D',
          scheduledStartTime: '2026-01-01T00:00:00Z',
        },
      },
    });
  });

  it('getStreamStatus maps live to active', async () => {
    const youtube = createMockYoutube();
    youtube.liveStreams.list.mockResolvedValue({
      data: { items: [{ status: { streamStatus: 'live' } }] },
    });
    const adapter = new GoogleYouTubeApiAdapter(asYoutube(youtube));
    await expect(adapter.getStreamStatus('s1')).resolves.toBe('active');
  });

  it('getStreamStatus maps created to inactive', async () => {
    const youtube = createMockYoutube();
    youtube.liveStreams.list.mockResolvedValue({
      data: { items: [{ status: { streamStatus: 'created' } }] },
    });
    const adapter = new GoogleYouTubeApiAdapter(asYoutube(youtube));
    await expect(adapter.getStreamStatus('s1')).resolves.toBe('inactive');
  });

  it('getBroadcastStatus maps testing state', async () => {
    const youtube = createMockYoutube();
    youtube.liveBroadcasts.list.mockResolvedValue({
      data: { items: [{ status: { lifeCycleStatus: 'testing' } }] },
    });
    const adapter = new GoogleYouTubeApiAdapter(asYoutube(youtube));
    await expect(adapter.getBroadcastStatus('b1')).resolves.toBe('testing');
  });
});
