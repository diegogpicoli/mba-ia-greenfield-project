import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, type Repository } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { presignedRequest } from '../src/test/presigned-request';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  createVideosTestApp,
  registerConfirmAndLogin,
} from './support/videos-e2e';

const ONE_HOUR_MS = 60 * 60 * 1000;
const SIXTEEN_MIB = 16 * 1024 * 1024;

type SignedBody = {
  parts: { part_number: number; url: string }[];
  expires_at: string;
};
type ErrorBody = { error: string };

describe('videos-parts-sign', () => {
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
    ownerToken = await registerConfirmAndLogin(app, 'sign-owner@example.com');
    otherToken = await registerConfirmAndLogin(app, 'sign-other@example.com');
    const response = await request(app.getHttpServer())
      .post('/videos')
      .auth(ownerToken, { type: 'bearer' })
      .send({
        original_filename: 'aula.mp4',
        declared_size: 20971520,
        content_type: 'video/mp4',
      })
      .expect(201);
    publicId = (response.body as { public_id: string }).public_id;
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

  function signParts(partNumbers: number[], token: string | null = ownerToken) {
    const call = request(app.getHttpServer())
      .post(`/videos/${publicId}/parts/sign`)
      .send({ part_numbers: partNumbers });
    return token === null ? call : call.auth(token, { type: 'bearer' });
  }

  // 1. POST /videos/{publicId}/parts/sign

  it('assina-partes-do-rascunho', async () => {
    const response = await signParts([1, 2]).expect(200);

    const body = response.body as SignedBody;
    expect(body.parts).toHaveLength(2);
    expect(body.parts.map(({ part_number }) => part_number)).toEqual([1, 2]);
    expect(body.parts[0].url).toEqual(expect.any(String));
    expect(body.parts[1].url).toEqual(expect.any(String));
    const expected = Date.now() + ONE_HOUR_MS;
    expect(
      Math.abs(new Date(body.expires_at).getTime() - expected),
    ).toBeLessThan(60_000);
  });

  it('url-assinada-aceita-put', async () => {
    const signed = await signParts([1]).expect(200);

    const response = await presignedRequest(
      (signed.body as SignedBody).parts[0].url,
      { method: 'PUT', body: randomBytes(SIXTEEN_MIB) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.etag).toBeTruthy();
  });

  it('rejeita-numero-acima-de-part-count', async () => {
    const response = await signParts([3]).expect(400);

    expect((response.body as ErrorBody).error).toBe('UPLOAD_PART_OUT_OF_RANGE');
  });

  it('rejeita-lista-vazia-ou-repetida', async () => {
    const empty = await signParts([]).expect(400);
    expect((empty.body as ErrorBody).error).toBe('VALIDATION_ERROR');

    const repeated = await signParts([1, 1]).expect(400);
    expect((repeated.body as ErrorBody).error).toBe('VALIDATION_ERROR');
  });

  it('rejeita-video-fora-de-draft', async () => {
    await videoRepository.update(
      { public_id: publicId },
      { status: VideoStatus.PROCESSING },
    );

    const response = await signParts([1]).expect(409);

    expect((response.body as ErrorBody).error).toBe('VIDEO_UPLOAD_CLOSED');
  });

  it('outro-usuario-e-sem-token', async () => {
    const fromOther = await signParts([1], otherToken).expect(404);
    expect((fromOther.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    await signParts([1], null).expect(401);
  });
});
