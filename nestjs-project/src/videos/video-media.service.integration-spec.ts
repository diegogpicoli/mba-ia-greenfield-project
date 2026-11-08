import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { generateTestVideo } from '../test/generate-test-video';
import { presignedRequest } from '../test/presigned-request';
import {
  MediaCommandError,
  VideoFileRejectedError,
} from './video-media.errors';
import { VideoMediaService } from './video-media.service';

const JPEG_MAGIC = 'ffd8';

function hlsPlaylist(segment: string): Buffer {
  return Buffer.from(
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:5',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:5.0,',
      segment,
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'),
  );
}

describe('VideoMediaService (integration)', () => {
  let module: TestingModule;
  let media: VideoMediaService;
  let storage: StorageService;
  let config: ConfigType<typeof storageConfig>;
  let admin: S3Client;
  let directory: string;
  const storedKeys: string[] = [];

  async function storeAndSignRead(content: Buffer): Promise<string> {
    const key = `test-${randomUUID()}/source`;
    storedKeys.push(key);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const { url } = await storage.signUploadPart(key, uploadId, 1);
    const response = await presignedRequest(url, {
      method: 'PUT',
      body: content,
    });
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: response.headers.etag! },
    ]);
    const read = await storage.signWorkerRead(key);
    return read.url;
  }

  function outputPath(): string {
    return join(directory, `${randomUUID()}.jpg`);
  }

  async function expectJpeg(path: string): Promise<Buffer> {
    const content = await readFile(path);
    expect(content.subarray(0, 2).toString('hex')).toBe(JPEG_MAGIC);
    return content;
  }

  beforeAll(async () => {
    config = storageConfig();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [VideoMediaService],
    }).compile();
    await module.init();
    media = module.get(VideoMediaService);
    storage = module.get(StorageService);
    admin = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
    });
    directory = await mkdtemp(join(tmpdir(), 'video-media-'));
  }, 120000);

  afterAll(async () => {
    for (const key of storedKeys) {
      await admin.send(
        new DeleteObjectCommand({ Bucket: config.bucketVideos, Key: key }),
      );
    }
    admin.destroy();
    await rm(directory, { recursive: true, force: true });
    await module.close();
  }, 120000);

  describe('playlist with an http segment', () => {
    let server: Server;
    let baseUrl: string;
    const requests: string[] = [];

    beforeAll(async () => {
      server = createServer((request, response) => {
        requests.push(request.url ?? '');
        response.statusCode = 404;
        response.end();
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    beforeEach(() => {
      requests.length = 0;
    });

    afterAll(async () => {
      await new Promise((resolve) => {
        server.close(resolve);
      });
    });

    it('should reject it without requesting the address', async () => {
      const url = await storeAndSignRead(
        hlsPlaylist(`${baseUrl}/internal-address.ts`),
      );

      await expect(media.probe(url)).rejects.toBeInstanceOf(
        VideoFileRejectedError,
      );

      expect(requests).toEqual([]);
    });

    it('should not request the address when extracting a thumbnail either', async () => {
      const url = await storeAndSignRead(
        hlsPlaylist(`${baseUrl}/internal-address.ts`),
      );

      await expect(
        media.extractThumbnail(url, 1, outputPath()),
      ).rejects.toBeInstanceOf(MediaCommandError);

      expect(requests).toEqual([]);
    });
  });

  describe('probe', () => {
    it('should read the metadata of a 640x360 video of 5 seconds with audio', async () => {
      const url = await storeAndSignRead(await generateTestVideo());

      const metadata = await media.probe(url);

      expect(Math.abs(metadata.duration! - 5)).toBeLessThan(0.5);
      expect(metadata.width).toBe(640);
      expect(metadata.height).toBe(360);
      expect(metadata.video_codec).toBe('h264');
      expect(metadata.audio_codec).toBe('aac');
      expect(metadata.bitrate).toBeGreaterThan(0);
      expect(metadata.container).toContain('mp4');
    });

    it('should return a null audio codec for a video without audio', async () => {
      const url = await storeAndSignRead(
        await generateTestVideo({ audio: false, durationSeconds: 1 }),
      );

      await expect(media.probe(url)).resolves.toMatchObject({
        video_codec: 'h264',
        audio_codec: null,
      });
    });

    it('should reject a text file without exposing the signed URL', async () => {
      const url = await storeAndSignRead(
        Buffer.from('this is just a text file, not a video\n'.repeat(50)),
      );

      const error: unknown = await media.probe(url).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(VideoFileRejectedError);
      expect((error as Error).message).not.toContain('X-Amz-Signature');
    });

    it('should reject a file that only has audio', async () => {
      const url = await storeAndSignRead(
        await generateTestVideo({ video: false, durationSeconds: 1 }),
      );

      await expect(media.probe(url)).rejects.toBeInstanceOf(
        VideoFileRejectedError,
      );
    });

    it('should reject a playlist that points to /etc/passwd without reading it', async () => {
      const url = await storeAndSignRead(hlsPlaylist('file:///etc/passwd'));

      const error: unknown = await media.probe(url).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(VideoFileRejectedError);
      expect((error as Error).message).not.toContain('root:');
    });

    it('should reject a playlist that points to a valid local video', async () => {
      const localVideo = join(directory, 'local.mp4');
      await writeFile(
        localVideo,
        await generateTestVideo({ audio: false, durationSeconds: 1 }),
      );
      const url = await storeAndSignRead(hlsPlaylist(`file://${localVideo}`));

      await expect(media.probe(url)).rejects.toBeInstanceOf(
        VideoFileRejectedError,
      );
    });

    it('should refuse the file protocol because of the protocol whitelist', async () => {
      const localVideo = join(directory, 'direct.mp4');
      await writeFile(
        localVideo,
        await generateTestVideo({ audio: false, durationSeconds: 1 }),
      );

      await expect(media.probe(`file://${localVideo}`)).rejects.toBeInstanceOf(
        VideoFileRejectedError,
      );
    });

    it('should accept a Matroska video, which is one of the allowed formats', async () => {
      const url = await storeAndSignRead(
        await generateTestVideo({
          container: 'matroska',
          audio: false,
          durationSeconds: 1,
        }),
      );

      const metadata = await media.probe(url);

      expect(metadata.container).toContain('matroska');
      expect(metadata.video_codec).toBe('h264');
      const output = outputPath();
      await media.extractThumbnail(url, metadata.duration, output);
      await expectJpeg(output);
    });

    it.each([
      [
        'a bad signature',
        async () => {
          const url = await storeAndSignRead(
            await generateTestVideo({ audio: false, durationSeconds: 1 }),
          );
          return url.replace(
            /X-Amz-Signature=[0-9a-f]+/,
            `X-Amz-Signature=${'0'.repeat(64)}`,
          );
        },
      ],
      [
        'a missing object',
        async () =>
          (await storage.signWorkerRead(`test-${randomUUID()}/source`)).url,
      ],
      ['a refused connection', () => Promise.resolve('http://127.0.0.1:1/x')],
    ])('should not treat %s as a rejected file', async (_label, createUrl) => {
      const url = await createUrl();

      const error: unknown = await media.probe(url).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MediaCommandError);
      expect(error).not.toBeInstanceOf(VideoFileRejectedError);
    });
  });

  describe('extractThumbnail', () => {
    it('should write a JPEG taken at 10% of the duration', async () => {
      const url = await storeAndSignRead(
        await generateTestVideo({ audio: false }),
      );
      const atTenPercent = outputPath();
      const atFirstFrame = outputPath();

      await media.extractThumbnail(url, 5, atTenPercent);
      await media.extractThumbnail(url, null, atFirstFrame);

      const tenPercent = await expectJpeg(atTenPercent);
      const firstFrame = await expectJpeg(atFirstFrame);
      expect(tenPercent.equals(firstFrame)).toBe(false);
    });

    it('should fall back to the first frame for a video with a single frame', async () => {
      const url = await storeAndSignRead(
        await generateTestVideo({ audio: false, frames: 1 }),
      );
      const metadata = await media.probe(url);
      const output = outputPath();

      await media.extractThumbnail(url, metadata.duration, output);

      await expectJpeg(output);
      expect((await stat(output)).size).toBeGreaterThan(0);
    });

    it('should fall back to the first frame when the duration is past the end of the video', async () => {
      const url = await storeAndSignRead(
        await generateTestVideo({ audio: false, durationSeconds: 1 }),
      );
      const output = outputPath();

      await media.extractThumbnail(url, 600, output);

      await expectJpeg(output);
    });

    it('should fall back to the first frame for an MPEG-TS video, where the seek finds no frame', async () => {
      const url = await storeAndSignRead(
        await generateTestVideo({
          container: 'mpegts',
          audio: false,
          durationSeconds: 2,
        }),
      );
      const output = outputPath();

      await media.extractThumbnail(url, 2, output);

      await expectJpeg(output);
    });

    it('should refuse the file protocol and write nothing', async () => {
      const localVideo = join(directory, 'direct-thumbnail.mp4');
      await writeFile(
        localVideo,
        await generateTestVideo({ audio: false, durationSeconds: 1 }),
      );
      const output = outputPath();

      await expect(
        media.extractThumbnail(`file://${localVideo}`, 1, output),
      ).rejects.toBeInstanceOf(MediaCommandError);

      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
