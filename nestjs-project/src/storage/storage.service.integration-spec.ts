import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { UploadNotFoundException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { presignedRequest } from '../test/presigned-request';
import { LIST_PARTS_PAGE_SIZE } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;
const VIDEO_CONTENT_TYPE = 'video/mp4';
const PART_UPLOAD_CONCURRENCY = 32;

type StorageConfig = ConfigType<typeof storageConfig>;

async function createStorageModule(
  overrides: Partial<StorageConfig> = {},
): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  })
    .overrideProvider(storageConfig.KEY)
    .useValue({ ...storageConfig(), ...overrides })
    .compile();
  await module.init();
  return module;
}

function expectAboutSecondsAhead(date: Date, seconds: number): void {
  const expected = Date.now() + seconds * 1000;
  expect(Math.abs(date.getTime() - expected)).toBeLessThan(60_000);
}

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let service: StorageService;
  let config: StorageConfig;
  let admin: S3Client;
  const createdVideoKeys: string[] = [];
  const createdThumbnailKeys: string[] = [];

  function newVideoKey(): string {
    const key = `test-${randomUUID()}/source`;
    createdVideoKeys.push(key);
    return key;
  }

  function newThumbnailKey(): string {
    const key = `test-${randomUUID()}/thumbnail.jpg`;
    createdThumbnailKeys.push(key);
    return key;
  }

  async function putPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> {
    const { url } = await service.signUploadPart(key, uploadId, partNumber);
    const response = await presignedRequest(url, { method: 'PUT', body });
    expect(response.status).toBe(200);
    expect(response.headers.etag).toBeTruthy();
    return response.headers.etag!;
  }

  async function storeVideoObject(content: Buffer): Promise<string> {
    const key = newVideoKey();
    const uploadId = await service.createMultipartUpload(
      key,
      VIDEO_CONTENT_TYPE,
    );
    const etag = await putPart(key, uploadId, 1, content);
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);
    return key;
  }

  beforeAll(async () => {
    config = storageConfig();
    module = await createStorageModule();
    service = module.get(StorageService);
    admin = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
    });
  }, 120000);

  afterAll(async () => {
    for (const key of createdVideoKeys) {
      await admin.send(
        new DeleteObjectCommand({ Bucket: config.bucketVideos, Key: key }),
      );
    }
    for (const key of createdThumbnailKeys) {
      await admin.send(
        new DeleteObjectCommand({ Bucket: config.bucketThumbnails, Key: key }),
      );
    }
    admin.destroy();
    await module.close();
  }, 120000);

  describe('multipart upload by presigned URL', () => {
    it('should close a file above 16 MiB sent in two parts into an object with the total size', async () => {
      const key = newVideoKey();
      const firstPart = randomBytes(16 * MIB);
      const secondPart = randomBytes(MIB);
      const uploadId = await service.createMultipartUpload(
        key,
        VIDEO_CONTENT_TYPE,
      );

      const firstUrl = await service.signUploadPart(key, uploadId, 1);
      const secondUrl = await service.signUploadPart(key, uploadId, 2);
      expect(new URL(firstUrl.url).origin).toBe(config.publicEndpoint);
      expect(new URL(secondUrl.url).origin).toBe(config.publicEndpoint);

      const firstEtag = await putPart(key, uploadId, 1, firstPart);
      const secondEtag = await putPart(key, uploadId, 2, secondPart);

      const listed = await service.listParts(key, uploadId);
      expect(
        listed.map(({ partNumber, size }) => ({ partNumber, size })),
      ).toEqual([
        { partNumber: 1, size: firstPart.length },
        { partNumber: 2, size: secondPart.length },
      ]);
      expect(listed.map(({ etag }) => etag.replaceAll('"', ''))).toEqual([
        firstEtag.replaceAll('"', ''),
        secondEtag.replaceAll('"', ''),
      ]);

      await service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: firstEtag },
        { partNumber: 2, etag: secondEtag },
      ]);

      await expect(service.headObject(key)).resolves.toEqual({
        size: firstPart.length + secondPart.length,
      });
      const { url } = await service.signClientRead(key);
      const stored = await presignedRequest(url);
      expect(stored.status).toBe(200);
      expect(stored.body.equals(Buffer.concat([firstPart, secondPart]))).toBe(
        true,
      );
    });

    it('should sign UploadPart without checksum parameters, for 1h, and MinIO should accept the PUT', async () => {
      const key = newVideoKey();
      const uploadId = await service.createMultipartUpload(
        key,
        VIDEO_CONTENT_TYPE,
      );

      const { url, expiresAt } = await service.signUploadPart(key, uploadId, 1);

      const params = new URL(url).searchParams;
      const checksumParams = [...params.keys()].filter((name) =>
        name.toLowerCase().includes('checksum'),
      );
      expect(checksumParams).toEqual([]);
      expect(params.get('X-Amz-Expires')).toBe('3600');
      expectAboutSecondsAhead(expiresAt, 3600);

      const response = await presignedRequest(url, {
        method: 'PUT',
        body: randomBytes(1024),
      });
      expect(response.status).toBe(200);

      await service.abortMultipartUpload(key, uploadId);
    });

    it('should list every part across pages when there are more parts than one page holds', async () => {
      const key = newVideoKey();
      const uploadId = await service.createMultipartUpload(
        key,
        VIDEO_CONTENT_TYPE,
      );
      const total = LIST_PARTS_PAGE_SIZE + 1;
      const numbers = Array.from({ length: total }, (_, index) => index + 1);
      for (let start = 0; start < total; start += PART_UPLOAD_CONCURRENCY) {
        await Promise.all(
          numbers
            .slice(start, start + PART_UPLOAD_CONCURRENCY)
            .map((number) => putPart(key, uploadId, number, Buffer.from('x'))),
        );
      }
      const send = jest.spyOn(S3Client.prototype, 'send');

      const parts = await service.listParts(key, uploadId);

      const listCalls = send.mock.calls.filter(
        ([command]) => command instanceof ListPartsCommand,
      );
      send.mockRestore();
      expect(listCalls).toHaveLength(2);
      expect(parts.map(({ partNumber }) => partNumber)).toEqual(numbers);

      await service.abortMultipartUpload(key, uploadId);
    }, 180000);

    it('should turn NoSuchUpload into UPLOAD_NOT_FOUND once the upload is aborted', async () => {
      const key = newVideoKey();
      const uploadId = await service.createMultipartUpload(
        key,
        VIDEO_CONTENT_TYPE,
      );
      const etag = await putPart(key, uploadId, 1, randomBytes(1024));

      await service.abortMultipartUpload(key, uploadId);

      const notFound = { errorCode: 'UPLOAD_NOT_FOUND', httpStatus: 409 };
      await expect(service.listParts(key, uploadId)).rejects.toBeInstanceOf(
        UploadNotFoundException,
      );
      await expect(service.listParts(key, uploadId)).rejects.toMatchObject(
        notFound,
      );
      await expect(
        service.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag },
        ]),
      ).rejects.toMatchObject(notFound);
    });

    it('should turn NoSuchUpload into UPLOAD_NOT_FOUND when aborting an upload that never existed', async () => {
      const neverExisted = Buffer.from(
        `${randomUUID()}.${randomUUID()}`,
      ).toString('base64');

      await expect(
        service.abortMultipartUpload(newVideoKey(), neverExisted),
      ).rejects.toMatchObject({
        errorCode: 'UPLOAD_NOT_FOUND',
        httpStatus: 409,
      });
    });

    it('should accept aborting an upload that was already aborted, because MinIO answers 204', async () => {
      const key = newVideoKey();
      const uploadId = await service.createMultipartUpload(
        key,
        VIDEO_CONTENT_TYPE,
      );
      await service.abortMultipartUpload(key, uploadId);

      await expect(
        service.abortMultipartUpload(key, uploadId),
      ).resolves.toBeUndefined();
    });

    it('should report a missing object as null', async () => {
      await expect(
        service.headObject(`test-${randomUUID()}/source`),
      ).resolves.toBeNull();
    });
  });

  describe('signed read', () => {
    it('should answer a signed GET with Range with 206 and Content-Range', async () => {
      const content = randomBytes(2048);
      const key = await storeVideoObject(content);
      const { url } = await service.signClientRead(key);

      const response = await presignedRequest(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(response.status).toBe(206);
      expect(response.headers['content-range']).toBe('bytes 0-1023/2048');
      expect(response.body.equals(content.subarray(0, 1024))).toBe(true);
    });

    it('should sign the client read by the public endpoint for 6h, with the optional disposition', async () => {
      const key = await storeVideoObject(randomBytes(1024));
      const disposition = 'attachment; filename="clip.mp4"';

      const { url, expiresAt } = await service.signClientRead(key, disposition);

      expect(new URL(url).origin).toBe(config.publicEndpoint);
      expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('21600');
      expectAboutSecondsAhead(expiresAt, 21600);
      const response = await presignedRequest(url);
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toBe(disposition);
    });

    it('should sign the worker read by the internal endpoint, reachable from inside the container', async () => {
      const content = randomBytes(1024);
      const key = await storeVideoObject(content);

      const { url } = await service.signWorkerRead(key);

      expect(new URL(url).origin).toBe(config.endpoint);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(content)).toBe(
        true,
      );
    });
  });

  describe('bucket provisioning', () => {
    it('should create both buckets on the first start and keep them on the second', async () => {
      const suffix = randomUUID().slice(0, 8);
      const buckets = {
        bucketVideos: `st-test-${suffix}-videos`,
        bucketThumbnails: `st-test-${suffix}-thumbnails`,
      };
      const key = 'thumbnail.jpg';

      const first = await createStorageModule(buckets);
      await first.close();
      const second = await createStorageModule(buckets);
      try {
        await expect(
          admin.send(new HeadBucketCommand({ Bucket: buckets.bucketVideos })),
        ).resolves.toBeDefined();
        await expect(
          admin.send(
            new HeadBucketCommand({ Bucket: buckets.bucketThumbnails }),
          ),
        ).resolves.toBeDefined();

        await second.get(StorageService).putThumbnail(key, randomBytes(16));
        const anonymous = await fetch(
          `${config.endpoint}/${buckets.bucketThumbnails}/${key}`,
        );
        expect(anonymous.status).toBe(200);
      } finally {
        await second.close();
        await admin.send(
          new DeleteObjectCommand({
            Bucket: buckets.bucketThumbnails,
            Key: key,
          }),
        );
        await admin.send(
          new DeleteBucketCommand({ Bucket: buckets.bucketThumbnails }),
        );
        await admin.send(
          new DeleteBucketCommand({ Bucket: buckets.bucketVideos }),
        );
      }
    }, 60000);

    it('should allow anonymous reads of a thumbnail and deny listing that bucket', async () => {
      const key = newThumbnailKey();
      const content = randomBytes(256);
      await service.putThumbnail(key, content);

      const object = await fetch(
        `${config.endpoint}/${config.bucketThumbnails}/${key}`,
      );
      expect(object.status).toBe(200);
      expect(object.headers.get('content-type')).toBe('image/jpeg');
      expect(Buffer.from(await object.arrayBuffer()).equals(content)).toBe(
        true,
      );

      const listing = await fetch(
        `${config.endpoint}/${config.bucketThumbnails}/`,
      );
      expect(listing.status).toBe(403);
      expect(await listing.text()).not.toContain(key);
    });

    it('should deny anonymous reads of a video object', async () => {
      const key = await storeVideoObject(randomBytes(1024));

      const response = await fetch(
        `${config.endpoint}/${config.bucketVideos}/${key}`,
      );

      expect(response.status).toBe(403);
    });
  });
});
