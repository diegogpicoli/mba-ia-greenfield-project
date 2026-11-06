import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, type Repository } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { discardTestVideos } from '../src/test/discard-test-videos';
import { generateTestVideo } from '../src/test/generate-test-video';
import { presignedRequest } from '../src/test/presigned-request';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
import {
  createVideosTestApp,
  registerConfirmAndLogin,
  uploadUntilFinalStatus,
} from './support/videos-e2e';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

type UrlBody = { url: string; expires_at: string };
type ErrorBody = { error: string };

describe('videos-stream', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let validVideo: Buffer;
  let ownerToken: string;
  let otherToken: string;
  let publicId: string;

  async function discardVideos(): Promise<void> {
    await discardTestVideos({ queue, videoRepository, storage });
    await cleanAllTables(dataSource);
  }

  function getStream(token: string | null = ownerToken) {
    const call = request(app.getHttpServer()).get(`/videos/${publicId}/stream`);
    return token === null ? call : call.auth(token, { type: 'bearer' });
  }

  beforeAll(async () => {
    const created = await createVideosTestApp();
    app = created.app;
    dataSource = created.moduleRef.get(DataSource);
    throttlerStorage =
      created.moduleRef.get<ThrottlerStorageService>(ThrottlerStorage);
    storage = created.moduleRef.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
    queue = created.moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    validVideo = await generateTestVideo();
  });

  beforeEach(async () => {
    throttlerStorage.storage.clear();
    await discardVideos();
    ownerToken = await registerConfirmAndLogin(app, 'stream-owner@example.com');
    otherToken = await registerConfirmAndLogin(app, 'stream-other@example.com');
    const uploaded = await uploadUntilFinalStatus(app, ownerToken, validVideo);
    expect(uploaded.final.status).toBe(VideoStatus.READY);
    publicId = uploaded.publicId;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await discardVideos();
    await app.close();
  });

  // 1. GET /videos/{publicId}/stream

  it('entrega-url-de-leitura', async () => {
    const response = await getStream().expect(200);

    const body = response.body as UrlBody;
    expect(body.url).toEqual(expect.any(String));
    const expected = Date.now() + SIX_HOURS_MS;
    expect(
      Math.abs(new Date(body.expires_at).getTime() - expected),
    ).toBeLessThan(60_000);
  });

  it('url-responde-a-range', async () => {
    const response = await getStream().expect(200);

    const read = await presignedRequest((response.body as UrlBody).url, {
      headers: { Range: 'bytes=0-1023' },
    });

    expect(read.status).toBe(206);
    expect(read.headers['content-range']).toBeTruthy();
    expect(read.headers['content-type']).toBe('video/mp4');
    expect(read.body).toHaveLength(1024);
  });

  it('rejeita-video-fora-de-ready', async () => {
    for (const status of [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.ERROR,
    ]) {
      await videoRepository.update({ public_id: publicId }, { status });

      const response = await getStream().expect(409);

      expect((response.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
    }
  });

  it('outro-usuario-e-sem-token', async () => {
    const fromOther = await getStream(otherToken).expect(404);
    expect((fromOther.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    await getStream(null).expect(401);
  });
});
