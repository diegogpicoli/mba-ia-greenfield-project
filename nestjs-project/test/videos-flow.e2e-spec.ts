import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
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
  sendParts,
  type VideoBody,
} from './support/videos-e2e';

const SIXTEEN_MIB = 16 * 1024 * 1024;
const POLL_MS = 100;
const FINAL_STATUS_TIMEOUT_MS = 45_000;
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

type VideoResource = VideoBody & {
  width: number | null;
  height: number | null;
};
type CreatedBody = {
  public_id: string;
  status: VideoStatus;
  part_size: number;
  part_count: number;
};
type UrlBody = { url: string; expires_at: string };
type ErrorBody = { error: string };

/** What is read from the API at each moment of a flow. */
class FlowObservation {
  readonly statuses: VideoStatus[] = [];
  readonly otherUserAnswers: string[] = [];
  readonly connectedWorkers: number[] = [];
}

describe('videos-flow', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let ownerToken: string;
  let otherToken: string;

  async function discardVideos(): Promise<void> {
    await discardTestVideos({ queue, videoRepository, storage });
    await cleanAllTables(dataSource);
  }

  function get(path: string, token: string) {
    return request(app.getHttpServer())
      .get(path)
      .auth(token, { type: 'bearer' });
  }

  async function createVideo(
    originalFilename: string,
    declaredSize: number,
  ): Promise<CreatedBody> {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .auth(ownerToken, { type: 'bearer' })
      .send({
        original_filename: originalFilename,
        declared_size: declaredSize,
        content_type: 'video/mp4',
      })
      .expect(201);
    return response.body as CreatedBody;
  }

  async function observe(
    publicId: string,
    observation: FlowObservation,
  ): Promise<VideoResource> {
    const own = await get(`/videos/${publicId}`, ownerToken).expect(200);
    const other = await get(`/videos/${publicId}`, otherToken);
    observation.otherUserAnswers.push(
      `${other.status} ${(other.body as ErrorBody).error}`,
    );
    observation.connectedWorkers.push((await queue.getWorkers()).length);
    const body = own.body as VideoResource;
    if (observation.statuses.at(-1) !== body.status) {
      observation.statuses.push(body.status);
    }
    return body;
  }

  async function observeUntilFinalStatus(
    publicId: string,
    observation: FlowObservation,
  ): Promise<VideoResource> {
    const deadline = Date.now() + FINAL_STATUS_TIMEOUT_MS;
    for (;;) {
      const body = await observe(publicId, observation);
      if (
        body.status === VideoStatus.READY ||
        body.status === VideoStatus.ERROR
      ) {
        return body;
      }
      if (Date.now() > deadline) {
        throw new Error(`Video still in ${body.status} after the time limit`);
      }
      await sleep(POLL_MS);
    }
  }

  function completeUpload(
    publicId: string,
    parts: { part_number: number; etag: string }[],
  ) {
    return request(app.getHttpServer())
      .post(`/videos/${publicId}/complete`)
      .auth(ownerToken, { type: 'bearer' })
      .send({ parts })
      .expect(200);
  }

  beforeAll(async () => {
    const created = await createVideosTestApp();
    app = created.app;
    dataSource = created.moduleRef.get(DataSource);
    storage = created.moduleRef.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
    queue = created.moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    created.moduleRef
      .get<ThrottlerStorageService>(ThrottlerStorage)
      .storage.clear();
    await discardVideos();
    ownerToken = await registerConfirmAndLogin(app, 'flow-owner@example.com');
    otherToken = await registerConfirmAndLogin(app, 'flow-other@example.com');
  });

  afterAll(async () => {
    await queue.resume();
    await discardVideos();
    await app.close();
  });

  describe('um video valido acima de 16 MiB, em mais de uma parte', () => {
    const observation = new FlowObservation();
    let file: Buffer;
    let publicId: string;
    let created: CreatedBody;
    let answerToComplete: VideoStatus;
    let jobStateWhileProcessing: string;
    let final: VideoResource;

    beforeAll(async () => {
      file = await generateTestVideo({ durationSeconds: 3, noise: true });
      created = await createVideo('aula.mp4', file.length);
      publicId = created.public_id;
      await observe(publicId, observation);
      const chunks: Buffer[] = [];
      for (let start = 0; start < file.length; start += created.part_size) {
        chunks.push(file.subarray(start, start + created.part_size));
      }
      const parts = await sendParts(app, ownerToken, publicId, chunks);
      await observe(publicId, observation);

      // With the queue paused the job waits, so the worker cannot take the
      // video from processing to ready between two reads of the status.
      await queue.pause();
      const completed = await completeUpload(publicId, parts);
      answerToComplete = (completed.body as VideoResource).status;
      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });
      jobStateWhileProcessing = await queue.getJobState(video.id);
      await observe(publicId, observation);
      await queue.resume();

      final = await observeUntilFinalStatus(publicId, observation);
    });

    it('passa-por-draft-processing-e-ready-com-duracao-e-thumbnail', () => {
      expect(file.length).toBeGreaterThan(SIXTEEN_MIB);
      expect(created.part_count).toBeGreaterThan(1);
      expect(created.status).toBe(VideoStatus.DRAFT);
      expect(answerToComplete).toBe(VideoStatus.PROCESSING);
      expect(jobStateWhileProcessing).not.toBe('active');
      expect(observation.statuses).toEqual([
        VideoStatus.DRAFT,
        VideoStatus.PROCESSING,
        VideoStatus.READY,
      ]);
      expect(final.duration).toBeCloseTo(3, 0);
      expect(final.width).toBe(640);
      expect(final.height).toBe(360);
      expect(final.thumbnail_url).toEqual(expect.any(String));
    });

    it('download-devolve-os-bytes-enviados', async () => {
      const response = await get(
        `/videos/${publicId}/download`,
        ownerToken,
      ).expect(200);

      const read = await presignedRequest((response.body as UrlBody).url);

      expect(read.status).toBe(200);
      expect(read.body.length).toBe(file.length);
      expect(read.body.equals(file)).toBe(true);
    });

    it('download-responde-attachment', async () => {
      const response = await get(
        `/videos/${publicId}/download`,
        ownerToken,
      ).expect(200);

      const read = await presignedRequest((response.body as UrlBody).url);

      expect(read.headers['content-disposition']).toMatch(/^attachment/);
      expect(read.headers['content-disposition']).toContain('aula.mp4');
    });

    it('stream-responde-a-range-no-inicio-e-entre-duas-partes', async () => {
      const response = await get(
        `/videos/${publicId}/stream`,
        ownerToken,
      ).expect(200);
      const { url } = response.body as UrlBody;

      const start = await presignedRequest(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(start.status).toBe(206);
      expect(start.headers['content-range']).toBe(
        `bytes 0-1023/${file.length}`,
      );
      expect(start.headers['content-type']).toBe('video/mp4');
      expect(start.body.equals(file.subarray(0, 1024))).toBe(true);

      const first = created.part_size - 256;
      const last = created.part_size + 255;
      const acrossParts = await presignedRequest(url, {
        headers: { Range: `bytes=${first}-${last}` },
      });

      expect(acrossParts.status).toBe(206);
      expect(acrossParts.body.equals(file.subarray(first, last + 1))).toBe(
        true,
      );
    });

    it('thumbnail-sem-autenticacao-e-listagem-negada', async () => {
      const thumbnailUrl = new URL(final.thumbnail_url!);
      expect(thumbnailUrl.search).toBe('');

      const thumbnail = await presignedRequest(thumbnailUrl.href);

      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers['content-type']).toBe('image/jpeg');
      expect(thumbnail.body.subarray(0, 3).equals(JPEG_SIGNATURE)).toBe(true);

      const bucket = thumbnailUrl.pathname.split('/')[1];
      const listing = await presignedRequest(
        `${thumbnailUrl.origin}/${bucket}?list-type=2`,
      );

      expect(listing.status).toBe(403);
    });

    it('original-nao-e-publico', async () => {
      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });
      const signed = new URL(
        (await storage.signClientRead(video.source_key)).url,
      );

      const anonymous = await presignedRequest(
        `${signed.origin}${signed.pathname}`,
      );

      expect(anonymous.status).toBe(403);
    });

    it('outro-usuario-recebe-404-durante-todo-o-fluxo', () => {
      expect(observation.otherUserAnswers.length).toBeGreaterThanOrEqual(4);
      expect(new Set(observation.otherUserAnswers)).toEqual(
        new Set(['404 VIDEO_NOT_FOUND']),
      );
    });

    it('exatamente-um-worker-conectado-durante-todo-o-fluxo', () => {
      expect(observation.connectedWorkers.length).toBeGreaterThanOrEqual(4);
      expect(new Set(observation.connectedWorkers)).toEqual(new Set([1]));
    });
  });

  describe('um arquivo de texto enviado como video', () => {
    const observation = new FlowObservation();
    const content = Buffer.from('this is not a video\n'.repeat(1024));
    let publicId: string;
    let final: VideoResource;

    beforeAll(async () => {
      publicId = (await createVideo('texto.mp4', content.length)).public_id;
      await observe(publicId, observation);
      const parts = await sendParts(app, ownerToken, publicId, [content]);
      await completeUpload(publicId, parts);
      final = await observeUntilFinalStatus(publicId, observation);
    });

    it('termina-em-error-sem-metadados-nem-thumbnail', () => {
      expect(observation.statuses[0]).toBe(VideoStatus.DRAFT);
      expect(observation.statuses.at(-1)).toBe(VideoStatus.ERROR);
      expect(final.duration).toBeNull();
      expect(final.thumbnail_url).toBeNull();
    });

    it('original-continua-no-storage', async () => {
      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });

      await expect(storage.headObject(video.source_key)).resolves.toEqual({
        size: content.length,
      });
      const { url } = await storage.signClientRead(video.source_key);
      const read = await presignedRequest(url);
      expect(read.body.equals(content)).toBe(true);
    });

    it('stream-e-download-recusam-video-em-error', async () => {
      for (const route of ['stream', 'download']) {
        const response = await get(
          `/videos/${publicId}/${route}`,
          ownerToken,
        ).expect(409);

        expect((response.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
      }
    });

    it('outro-usuario-recebe-404-durante-todo-o-fluxo', () => {
      expect(new Set(observation.otherUserAnswers)).toEqual(
        new Set(['404 VIDEO_NOT_FOUND']),
      );
    });

    it('exatamente-um-worker-conectado-durante-todo-o-fluxo', () => {
      expect(new Set(observation.connectedWorkers)).toEqual(new Set([1]));
    });
  });
});
