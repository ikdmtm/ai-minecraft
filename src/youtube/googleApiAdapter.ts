import { createReadStream } from 'node:fs';
import { google } from 'googleapis';
import type { youtube_v3 } from 'googleapis';
import type {
  YouTubeApiAdapter,
  BroadcastCreateParams,
  BroadcastCreateResult,
  StreamStatus,
} from './api.js';

/**
 * YouTube Data API v3（Live Streaming）の本番実装。
 * OAuth2 refresh_token で認証する。
 */
export class GoogleYouTubeApiAdapter implements YouTubeApiAdapter {
  constructor(private readonly youtube: youtube_v3.Youtube) {}

  static fromOAuthCredentials(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): GoogleYouTubeApiAdapter {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    const youtube = google.youtube({ version: 'v3', auth: oauth2 });
    return new GoogleYouTubeApiAdapter(youtube);
  }

  async createBroadcast(params: BroadcastCreateParams): Promise<BroadcastCreateResult> {
    const scheduled = new Date(Date.now() + 60_000).toISOString();

    const broadcastRes = await this.youtube.liveBroadcasts.insert({
      part: ['snippet', 'status', 'contentDetails'],
      requestBody: {
        snippet: {
          title: params.title,
          description: params.description,
          scheduledStartTime: scheduled,
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
        },
        contentDetails: {
          enableAutoStart: false,
          enableAutoStop: true,
        },
      },
    });

    const broadcastId = broadcastRes.data.id;
    if (!broadcastId) throw new Error('liveBroadcasts.insert: missing broadcast id');

    const streamRes = await this.youtube.liveStreams.insert({
      part: ['snippet', 'cdn'],
      requestBody: {
        snippet: { title: `Stream — ${params.title.slice(0, 80)}` },
        cdn: {
          frameRate: '30fps',
          ingestionType: 'rtmp',
          resolution: '720p',
        },
      },
    });

    const streamId = streamRes.data.id;
    if (!streamId) throw new Error('liveStreams.insert: missing stream id');

    const ingestion = streamRes.data.cdn?.ingestionInfo;
    const streamName = ingestion?.streamName;
    if (!streamName) throw new Error('liveStreams.insert: missing streamName (ingestion key)');

    const rtmpBase =
      ingestion?.ingestionAddress?.replace(/\/$/, '') || 'rtmp://a.rtmp.youtube.com/live2';
    const rtmpUrl = `${rtmpBase}/${streamName}`;

    await this.youtube.liveBroadcasts.bind({
      part: ['id', 'snippet'],
      id: broadcastId,
      streamId,
    });

    return {
      broadcastId,
      streamId,
      streamKey: streamName,
      rtmpUrl,
    };
  }

  async transitionBroadcast(
    broadcastId: string,
    status: 'live' | 'complete' | 'testing',
  ): Promise<void> {
    await this.youtube.liveBroadcasts.transition({
      broadcastStatus: status,
      id: broadcastId,
      part: ['id', 'status'],
    });
  }

  async updateBroadcast(
    broadcastId: string,
    update: { title?: string; description?: string },
  ): Promise<void> {
    const current = await this.youtube.liveBroadcasts.list({
      part: ['snippet'],
      id: [broadcastId],
    });
    const item = current.data.items?.[0];
    if (!item?.snippet) throw new Error('liveBroadcasts.list: broadcast not found');
    const sn = item.snippet;

    await this.youtube.liveBroadcasts.update({
      part: ['snippet'],
      requestBody: {
        id: broadcastId,
        snippet: {
          title: update.title ?? sn.title ?? '',
          description: update.description ?? sn.description ?? '',
          scheduledStartTime: sn.scheduledStartTime ?? undefined,
        },
      },
    });
  }

  async endBroadcast(broadcastId: string): Promise<void> {
    await this.transitionBroadcast(broadcastId, 'complete');
  }

  async uploadThumbnail(broadcastId: string, filePath: string): Promise<void> {
    await this.youtube.thumbnails.set({
      videoId: broadcastId,
      media: {
        body: createReadStream(filePath),
      },
    });
  }

  async getStreamStatus(streamId: string): Promise<StreamStatus> {
    const res = await this.youtube.liveStreams.list({
      part: ['status'],
      id: [streamId],
    });
    const raw = res.data.items?.[0]?.status?.streamStatus;
    return mapStreamStatus(raw);
  }
}

function mapStreamStatus(raw: string | null | undefined): StreamStatus {
  switch (raw) {
    case 'active':
    case 'live':
      return 'active';
    case 'ready':
      return 'ready';
    case 'error':
      return 'error';
    case 'inactive':
    case 'created':
    default:
      return 'inactive';
  }
}

/** 環境変数が揃っていればアダプターを生成。欠けていれば null。 */
export function tryCreateGoogleYouTubeAdapter(): GoogleYouTubeApiAdapter | null {
  const clientId = process.env.YOUTUBE_CLIENT_ID?.trim();
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return GoogleYouTubeApiAdapter.fromOAuthCredentials(clientId, clientSecret, refreshToken);
}
