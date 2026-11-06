import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
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
} from './support/videos-e2e';

const SIXTEEN_MIB = 16 * 1024 * 1024;
const FOUR_MIB = 4 * 1024 * 1024;
const ONE_MIB = 1024 * 1024;
const DECLARED_SIZE = 20971520;
const FINAL_STATUS_TIMEOUT_MS = 45_000;
const FINAL_STATUS_POLL_MS = 200;

type ClientPart = { part_number: number; etag: string };
type VideoBody = {
  status: VideoStatus;
  duration: number | null;
  thumbnail_url: string | null;
};
type SignedBody = { parts: { part_number: number; url: string }[] };
type ErrorBody = { error: string };

describe('videos-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let validVideo: Buffer;
  let ownerToken: string;
  let otherToken: string;

  async function discardVideos(): Promise<void> {
    await discardTestVideos({ queue, videoRepository, storage });
    await cleanAllTables(dataSource);
  }

  async function createVideo(declaredSize: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .auth(ownerToken, { type: 'bearer' })
      .send({
        original_filename: 'aula.mp4',
        declared_size: declaredSize,
        content_type: 'video/mp4',
      })
      .expect(201);
    return (response.body as { public_id: string }).public_id;
  }

  async function sendParts(
    publicId: string,
    chunks: Buffer[],
  ): Promise<ClientPart[]> {
    const signed = await request(app.getHttpServer())
      .post(`/videos/${publicId}/parts/sign`)
      .auth(ownerToken, { type: 'bearer' })
      .send({ part_numbers: chunks.map((_, index) => index + 1) })
      .expect(200);
    const parts: ClientPart[] = [];
    for (const { part_number, url } of (signed.body as SignedBody).parts) {
      const response = await presignedRequest(url, {
        method: 'PUT',
        body: chunks[part_number - 1],
      });
      expect(response.status).toBe(200);
      parts.push({ part_number, etag: response.headers.etag! });
    }
    return parts;
  }

  function complete(
    publicId: string,
    parts: ClientPart[],
    token: string | null = ownerToken,
  ) {
    const call = request(app.getHttpServer())
      .post(`/videos/${publicId}/complete`)
      .send({ parts });
    return token === null ? call : call.auth(token, { type: 'bearer' });
  }

  async function waitForFinalStatus(publicId: string): Promise<VideoBody> {
    const deadline = Date.now() + FINAL_STATUS_TIMEOUT_MS;
    for (;;) {
      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .auth(ownerToken, { type: 'bearer' })
        .expect(200);
      const body = response.body as VideoBody;
      if (
        body.status === VideoStatus.READY ||
        body.status === VideoStatus.ERROR
      ) {
        return body;
      }
      if (Date.now() > deadline) {
        throw new Error(`Video still in ${body.status} after the time limit`);
      }
      await sleep(FINAL_STATUS_POLL_MS);
    }
  }

  async function sendValidVideo(): Promise<{
    publicId: string;
    parts: ClientPart[];
  }> {
    const publicId = await createVideo(validVideo.length);
    const parts = await sendParts(publicId, [validVideo]);
    return { publicId, parts };
  }

  async function expectOpenUpload(publicId: string): Promise<void> {
    await request(app.getHttpServer())
      .get(`/videos/${publicId}/parts`)
      .auth(ownerToken, { type: 'bearer' })
      .expect(200);
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
      'complete-owner@example.com',
    );
    otherToken = await registerConfirmAndLogin(
      app,
      'complete-other@example.com',
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await discardVideos();
    await app.close();
  });

  // 1. POST /videos/{publicId}/complete

  it('fecha-e-processa', async () => {
    const file = await generateTestVideo({ durationSeconds: 3, noise: true });
    expect(file.length).toBeGreaterThan(SIXTEEN_MIB);
    const publicId = await createVideo(file.length);
    const parts = await sendParts(publicId, [
      file.subarray(0, SIXTEEN_MIB),
      file.subarray(SIXTEEN_MIB),
    ]);

    const response = await complete(publicId, parts).expect(200);

    expect([VideoStatus.PROCESSING, VideoStatus.READY]).toContain(
      (response.body as VideoBody).status,
    );
    const final = await waitForFinalStatus(publicId);
    expect(final.status).toBe(VideoStatus.READY);
    expect(final.duration).toBeGreaterThan(0);
    expect(final.thumbnail_url).toEqual(expect.any(String));
  });

  it('rejeita-lista-sem-parte', async () => {
    const publicId = await createVideo(DECLARED_SIZE);
    const parts = await sendParts(publicId, [
      randomBytes(SIXTEEN_MIB),
      randomBytes(FOUR_MIB),
    ]);

    const response = await complete(publicId, [parts[0]]).expect(409);

    expect((response.body as ErrorBody).error).toBe('UPLOAD_PARTS_MISMATCH');
    await expectOpenUpload(publicId);
  });

  it('rejeita-etag-divergente', async () => {
    const publicId = await createVideo(DECLARED_SIZE);
    const parts = await sendParts(publicId, [
      randomBytes(SIXTEEN_MIB),
      randomBytes(FOUR_MIB),
    ]);

    const response = await complete(publicId, [
      parts[0],
      { part_number: 2, etag: '"00000000000000000000000000000000"' },
    ]).expect(409);

    expect((response.body as ErrorBody).error).toBe('UPLOAD_PARTS_MISMATCH');
    await expectOpenUpload(publicId);
  });

  it('rejeita-soma-diferente-do-declarado', async () => {
    const publicId = await createVideo(DECLARED_SIZE);
    const parts = await sendParts(publicId, [
      randomBytes(SIXTEEN_MIB),
      randomBytes(ONE_MIB),
    ]);

    const response = await complete(publicId, parts).expect(409);

    expect((response.body as ErrorBody).error).toBe('UPLOAD_PARTS_MISMATCH');
    await expectOpenUpload(publicId);
  });

  it('repetir-depois-de-fechado-responde-estado-atual', async () => {
    const { publicId, parts } = await sendValidVideo();
    await complete(publicId, parts).expect(200);
    const final = await waitForFinalStatus(publicId);
    expect(final.status).toBe(VideoStatus.READY);
    const storageCalls = [
      jest.spyOn(storage, 'listParts'),
      jest.spyOn(storage, 'completeMultipartUpload'),
      jest.spyOn(storage, 'abortMultipartUpload'),
      jest.spyOn(storage, 'headObject'),
    ];

    for (const status of [
      VideoStatus.READY,
      VideoStatus.PROCESSING,
      VideoStatus.ERROR,
    ]) {
      await videoRepository.update({ public_id: publicId }, { status });

      const response = await complete(publicId, parts).expect(200);

      expect((response.body as VideoBody).status).toBe(status);
      for (const call of storageCalls) {
        expect(call).not.toHaveBeenCalled();
      }
    }
  });

  it('repetir-em-draft-com-multipart-fechado-segue', async () => {
    const { publicId, parts } = await sendValidVideo();
    const video = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    await storage.completeMultipartUpload(
      video.source_key,
      video.upload_id,
      parts.map(({ part_number, etag }) => ({
        partNumber: part_number,
        etag,
      })),
    );
    await expect(storage.headObject(video.source_key)).resolves.toEqual({
      size: validVideo.length,
    });

    const response = await complete(publicId, parts).expect(200);

    expect((response.body as VideoBody).status).not.toBe(VideoStatus.DRAFT);
    const final = await waitForFinalStatus(publicId);
    expect(final.status).toBe(VideoStatus.READY);
  });

  it('repetir-em-draft-sem-objeto-responde-erro', async () => {
    const publicId = await createVideo(DECLARED_SIZE);
    const video = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    await storage.abortMultipartUpload(video.source_key, video.upload_id);

    const response = await complete(publicId, [
      { part_number: 1, etag: '"00000000000000000000000000000000"' },
    ]).expect(409);

    expect((response.body as ErrorBody).error).toBe('UPLOAD_NOT_FOUND');
  });

  it('repetir-nao-cria-segundo-job', async () => {
    const { publicId, parts } = await sendValidVideo();
    await complete(publicId, parts).expect(200);
    const video = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    const job = await queue.getJob(video.id);
    expect(job).toBeDefined();

    await complete(publicId, parts).expect(200);

    const repeated = await queue.getJob(video.id);
    expect(repeated?.timestamp).toBe(job?.timestamp);
  });

  it('outro-usuario-sem-token-e-parts-vazio', async () => {
    const publicId = await createVideo(DECLARED_SIZE);
    const parts = [
      { part_number: 1, etag: '"00000000000000000000000000000000"' },
    ];

    const fromOther = await complete(publicId, parts, otherToken).expect(404);
    expect((fromOther.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    await complete(publicId, parts, null).expect(401);

    const empty = await complete(publicId, []).expect(400);
    expect((empty.body as ErrorBody).error).toBe('VALIDATION_ERROR');

    const invalidItem = await complete(publicId, [
      { part_number: 0, etag: '' },
    ]).expect(400);
    expect((invalidItem.body as ErrorBody).error).toBe('VALIDATION_ERROR');
  });
});
