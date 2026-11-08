import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { MailService } from '../../src/mail/mail.service';
import { presignedRequest } from '../../src/test/presigned-request';
import { VideoStatus } from '../../src/videos/entities/video.entity';
import { VIDEO_PART_SIZE_BYTES } from '../../src/videos/videos.constants';

const PASSWORD = 'password123';
const FINAL_STATUS_TIMEOUT_MS = 45_000;
const FINAL_STATUS_POLL_MS = 200;

export type ClientPart = { part_number: number; etag: string };
export type VideoBody = {
  status: VideoStatus;
  duration: number | null;
  thumbnail_url: string | null;
};
type SignedBody = { parts: { part_number: number; url: string }[] };

interface NewVideo {
  declaredSize: number;
  originalFilename?: string;
  contentType?: string;
}

export async function createVideosTestApp(): Promise<{
  app: INestApplication<App>;
  moduleRef: TestingModule;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return { app, moduleRef };
}

export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
): Promise<string> {
  let confirmationToken = '';
  jest
    .spyOn(app.get(MailService), 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: PASSWORD })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (login.body as { access_token: string }).access_token;
}

export async function createVideo(
  app: INestApplication<App>,
  token: string,
  {
    declaredSize,
    originalFilename = 'aula.mp4',
    contentType = 'video/mp4',
  }: NewVideo,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/videos')
    .auth(token, { type: 'bearer' })
    .send({
      original_filename: originalFilename,
      declared_size: declaredSize,
      content_type: contentType,
    })
    .expect(201);
  return (response.body as { public_id: string }).public_id;
}

export async function sendParts(
  app: INestApplication<App>,
  token: string,
  publicId: string,
  chunks: Buffer[],
): Promise<ClientPart[]> {
  const signed = await request(app.getHttpServer())
    .post(`/videos/${publicId}/parts/sign`)
    .auth(token, { type: 'bearer' })
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

export async function waitForFinalStatus(
  app: INestApplication<App>,
  token: string,
  publicId: string,
): Promise<VideoBody> {
  const deadline = Date.now() + FINAL_STATUS_TIMEOUT_MS;
  for (;;) {
    const response = await request(app.getHttpServer())
      .get(`/videos/${publicId}`)
      .auth(token, { type: 'bearer' })
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

/**
 * Takes a file through the real upload flow, in parts of the planned size, and
 * waits for the video-worker service to give the video its final status.
 */
export async function uploadUntilFinalStatus(
  app: INestApplication<App>,
  token: string,
  file: Buffer,
  video: Omit<NewVideo, 'declaredSize'> = {},
): Promise<{ publicId: string; final: VideoBody }> {
  const publicId = await createVideo(app, token, {
    ...video,
    declaredSize: file.length,
  });
  const chunks: Buffer[] = [];
  for (let start = 0; start < file.length; start += VIDEO_PART_SIZE_BYTES) {
    chunks.push(file.subarray(start, start + VIDEO_PART_SIZE_BYTES));
  }
  const parts = await sendParts(app, token, publicId, chunks);
  await request(app.getHttpServer())
    .post(`/videos/${publicId}/complete`)
    .auth(token, { type: 'bearer' })
    .send({ parts })
    .expect(200);
  return { publicId, final: await waitForFinalStatus(app, token, publicId) };
}
