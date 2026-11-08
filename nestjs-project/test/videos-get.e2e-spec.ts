import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, type Repository } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  createVideosTestApp,
  registerConfirmAndLogin,
} from './support/videos-e2e';

const POLLING_REQUESTS = 12;

type VideoBody = {
  public_id: string;
  status: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate: number | null;
  container: string | null;
  thumbnail_url: string | null;
};
type ErrorBody = { statusCode: number; error: string; message: string };

describe('videos-get', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let ownerToken: string;
  let otherToken: string;
  let publicId: string;

  beforeAll(async () => {
    const created = await createVideosTestApp();
    app = created.app;
    dataSource = created.moduleRef.get(DataSource);
    throttlerStorage =
      created.moduleRef.get<ThrottlerStorageService>(ThrottlerStorage);
    storage = created.moduleRef.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
  });

  beforeEach(async () => {
    throttlerStorage.storage.clear();
    await cleanAllTables(dataSource);
    ownerToken = await registerConfirmAndLogin(app, 'videos-owner@example.com');
    otherToken = await registerConfirmAndLogin(app, 'videos-other@example.com');
    const response = await request(app.getHttpServer())
      .post('/videos')
      .auth(ownerToken, { type: 'bearer' })
      .send({
        original_filename: 'aula.mp4',
        declared_size: 20971520,
        content_type: 'video/mp4',
      })
      .expect(201);
    publicId = (response.body as VideoBody).public_id;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const video of await videoRepository.find()) {
      await storage.abortMultipartUpload(video.source_key, video.upload_id);
    }
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await app.close();
  });

  function getVideo(id: string, token: string | null) {
    const call = request(app.getHttpServer()).get(`/videos/${id}`);
    return token === null ? call : call.auth(token, { type: 'bearer' });
  }

  // 1. GET /videos/{publicId}

  it('dono-le-rascunho', async () => {
    const response = await getVideo(publicId, ownerToken).expect(200);

    const body = response.body as VideoBody;
    expect(body.status).toBe('draft');
    expect(body.duration).toBeNull();
    expect(body.width).toBeNull();
    expect(body.height).toBeNull();
    expect(body.video_codec).toBeNull();
    expect(body.audio_codec).toBeNull();
    expect(body.bitrate).toBeNull();
    expect(body.container).toBeNull();
    expect(body.thumbnail_url).toBeNull();
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('channel_id');
    expect(body).not.toHaveProperty('upload_id');
    expect(body).not.toHaveProperty('source_key');
  });

  it('dono-le-video-pronto', async () => {
    const thumbnailKey = 'some-id/thumbnail.jpg';
    await videoRepository.update(
      { public_id: publicId },
      {
        status: VideoStatus.READY,
        duration: 5,
        width: 640,
        height: 360,
        video_codec: 'h264',
        audio_codec: 'aac',
        bitrate: 129400,
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        thumbnail_key: thumbnailKey,
      },
    );

    const response = await getVideo(publicId, ownerToken).expect(200);

    expect(response.body).toMatchObject({
      status: 'ready',
      duration: 5,
      width: 640,
      height: 360,
      video_codec: 'h264',
      audio_codec: 'aac',
      bitrate: 129400,
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      thumbnail_url: `${process.env.S3_PUBLIC_ENDPOINT}/${process.env.S3_BUCKET_THUMBNAILS}/${thumbnailKey}`,
    });
  });

  it('outro-usuario-recebe-404-igual-a-inexistente', async () => {
    const fromOther = await getVideo(publicId, otherToken).expect(404);
    const missing = await getVideo('doesnotexis', ownerToken).expect(404);

    expect((fromOther.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    expect(fromOther.body).toEqual(missing.body);
  });

  it('rejeita-sem-token', async () => {
    await getVideo(publicId, null).expect(401);
  });

  it('nao-limita-polling-de-status', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < POLLING_REQUESTS; i += 1) {
      const response = await getVideo(publicId, ownerToken);
      statuses.push(response.status);
    }

    expect(statuses).toEqual(new Array<number>(POLLING_REQUESTS).fill(200));
  });
});
