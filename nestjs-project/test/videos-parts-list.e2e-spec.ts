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

const SIXTEEN_MIB = 16 * 1024 * 1024;

type ProgressBody = {
  part_size: number;
  part_count: number;
  uploaded_parts: { part_number: number; etag: string }[];
  missing_part_numbers: number[];
};
type SignedBody = { parts: { part_number: number; url: string }[] };
type ErrorBody = { error: string };

describe('videos-parts-list', () => {
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
    ownerToken = await registerConfirmAndLogin(app, 'list-owner@example.com');
    otherToken = await registerConfirmAndLogin(app, 'list-other@example.com');
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

  function getProgress(token: string | null = ownerToken) {
    const call = request(app.getHttpServer()).get(`/videos/${publicId}/parts`);
    return token === null ? call : call.auth(token, { type: 'bearer' });
  }

  // 1. GET /videos/{publicId}/parts

  it('progresso-sem-partes', async () => {
    const response = await getProgress().expect(200);

    const body = response.body as ProgressBody;
    expect(body.part_size).toBe(16777216);
    expect(body.part_count).toBe(2);
    expect(body.uploaded_parts).toEqual([]);
    expect(body.missing_part_numbers).toEqual([1, 2]);
  });

  it('progresso-depois-da-primeira-parte', async () => {
    const signed = await request(app.getHttpServer())
      .post(`/videos/${publicId}/parts/sign`)
      .auth(ownerToken, { type: 'bearer' })
      .send({ part_numbers: [1] })
      .expect(200);
    const sent = await presignedRequest(
      (signed.body as SignedBody).parts[0].url,
      { method: 'PUT', body: randomBytes(SIXTEEN_MIB) },
    );
    expect(sent.status).toBe(200);
    expect(sent.headers.etag).toBeTruthy();

    const response = await getProgress().expect(200);

    const body = response.body as ProgressBody;
    expect(body.uploaded_parts).toHaveLength(1);
    expect(body.uploaded_parts[0].part_number).toBe(1);
    expect(body.uploaded_parts[0].etag).toBeTruthy();
    expect(body.missing_part_numbers).toEqual([2]);
  });

  it('rejeita-video-fora-de-draft', async () => {
    await videoRepository.update(
      { public_id: publicId },
      { status: VideoStatus.PROCESSING },
    );

    const response = await getProgress().expect(409);

    expect((response.body as ErrorBody).error).toBe('VIDEO_UPLOAD_CLOSED');
  });

  it('rejeita-upload-abortado', async () => {
    const video = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    await storage.abortMultipartUpload(video.source_key, video.upload_id);

    const response = await getProgress().expect(409);

    expect((response.body as ErrorBody).error).toBe('UPLOAD_NOT_FOUND');
  });

  it('outro-usuario-e-sem-token', async () => {
    const fromOther = await getProgress(otherToken).expect(404);
    expect((fromOther.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    await getProgress(null).expect(401);
  });
});
