import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../src/channels/entities/channel.entity';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  createVideosTestApp,
  registerConfirmAndLogin,
} from './support/videos-e2e';

const EMAIL = 'videos-create@example.com';
const VALID_BODY = {
  original_filename: 'aula.mp4',
  declared_size: 20971520,
  content_type: 'video/mp4',
};

type CreatedBody = {
  public_id: string;
  title: string;
  status: string;
  part_size: number;
  part_count: number;
};
type ErrorBody = { error: string };

describe('videos-create', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let token: string;

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
    token = await registerConfirmAndLogin(app, EMAIL);
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

  function postVideo(body: object, bearer: string | null = token) {
    const call = request(app.getHttpServer()).post('/videos').send(body);
    return bearer === null ? call : call.auth(bearer, { type: 'bearer' });
  }

  // 1. POST /videos

  it('cria-rascunho-com-plano-de-partes', async () => {
    const response = await postVideo(VALID_BODY).expect(201);

    const body = response.body as CreatedBody;
    expect(body.public_id).toHaveLength(11);
    expect(body.status).toBe('draft');
    expect(body.title).toBe('aula.mp4');
    expect(body.part_size).toBe(16777216);
    expect(body.part_count).toBe(2);
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('upload_id');
  });

  it('aceita-tamanho-exato-do-limite', async () => {
    const response = await postVideo({
      ...VALID_BODY,
      declared_size: 10737418240,
    }).expect(201);

    expect((response.body as CreatedBody).part_count).toBe(640);
  });

  it('rejeita-um-byte-acima-do-limite', async () => {
    const response = await postVideo({
      ...VALID_BODY,
      declared_size: 10737418241,
    }).expect(413);

    expect((response.body as ErrorBody).error).toBe('VIDEO_TOO_LARGE');
    await expect(videoRepository.count()).resolves.toBe(0);
  });

  it('rejeita-sem-content-type', async () => {
    const response = await postVideo({
      original_filename: VALID_BODY.original_filename,
      declared_size: VALID_BODY.declared_size,
    }).expect(400);

    expect((response.body as ErrorBody).error).toBe('VALIDATION_ERROR');
  });

  it('rejeita-sem-token', async () => {
    await postVideo(VALID_BODY, null).expect(401);
  });

  it('grava-rascunho-no-canal-com-multipart-aberto', async () => {
    const response = await postVideo(VALID_BODY).expect(201);

    const video = await videoRepository.findOneByOrFail({
      public_id: (response.body as CreatedBody).public_id,
    });
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email: EMAIL });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    expect(video.channel_id).toBe(channel.id);
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.upload_id).toBeTruthy();
    expect(video.source_key).toBe(`${video.id}/source`);
    await expect(
      storage.listParts(video.source_key, video.upload_id),
    ).resolves.toEqual([]);
  });
});
