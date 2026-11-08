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

const AWKWARD_NAME = 'aula "ação"\nfinal;ção.mp4';

type UrlBody = { url: string; expires_at: string };
type ErrorBody = { error: string };

describe('videos-download', () => {
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

  function getDownload(id: string, token: string | null = ownerToken) {
    const call = request(app.getHttpServer()).get(`/videos/${id}/download`);
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
    ownerToken = await registerConfirmAndLogin(
      app,
      'download-owner@example.com',
    );
    otherToken = await registerConfirmAndLogin(
      app,
      'download-other@example.com',
    );
    const uploaded = await uploadUntilFinalStatus(app, ownerToken, validVideo, {
      originalFilename: 'aula.mp4',
    });
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

  // 1. GET /videos/{publicId}/download

  it('entrega-url-de-download', async () => {
    const response = await getDownload(publicId).expect(200);

    const body = response.body as UrlBody;
    expect(body.url).toEqual(expect.any(String));
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('url-responde-attachment', async () => {
    const response = await getDownload(publicId).expect(200);

    const read = await presignedRequest((response.body as UrlBody).url);

    expect(read.status).toBe(200);
    const disposition = read.headers['content-disposition'];
    expect(disposition).toMatch(/^attachment/);
    expect(disposition).toContain('aula.mp4');
  });

  it('nome-com-aspas-quebra-de-linha-e-acentos', async () => {
    const uploaded = await uploadUntilFinalStatus(app, ownerToken, validVideo, {
      originalFilename: AWKWARD_NAME,
    });
    expect(uploaded.final.status).toBe(VideoStatus.READY);
    const response = await getDownload(uploaded.publicId).expect(200);

    const read = await presignedRequest((response.body as UrlBody).url);

    expect(read.status).toBe(200);
    const disposition = read.headers['content-disposition']!;
    expect(disposition).not.toMatch(/[\r\n]/);
    const match =
      /^attachment; filename="([^"]*)"; filename\*=UTF-8''([^"]+)$/.exec(
        disposition,
      );
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![2])).toBe(AWKWARD_NAME);
  });

  it('rejeita-video-fora-de-ready', async () => {
    await videoRepository.update(
      { public_id: publicId },
      { status: VideoStatus.PROCESSING },
    );

    const response = await getDownload(publicId).expect(409);

    expect((response.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
  });

  it('outro-usuario-e-sem-token', async () => {
    const fromOther = await getDownload(publicId, otherToken).expect(404);
    expect((fromOther.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    await getDownload(publicId, null).expect(401);
  });
});
