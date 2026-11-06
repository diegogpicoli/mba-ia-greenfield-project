import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { type Job, UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { generateTestVideo } from '../test/generate-test-video';
import { presignedRequest } from '../test/presigned-request';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { MediaCommandError } from './video-media.errors';
import { VideoMediaService } from './video-media.service';
import { VideoProcessingService } from './video-processing.service';
import { type ProcessVideoJobData, VideoProcessor } from './video.processor';
import {
  THUMBNAIL_FILE_NAME,
  THUMBNAIL_TEMP_DIR_PREFIX,
} from './videos.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const JPEG_MAGIC = 'ffd8';

function jobFor(videoId: string): Job<ProcessVideoJobData> {
  return { data: { videoId } } as Job<ProcessVideoJobData>;
}

async function listThumbnailTempDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith(THUMBNAIL_TEMP_DIR_PREFIX));
}

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let processor: VideoProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let config: ConfigType<typeof storageConfig>;
  let admin: S3Client;
  const videoKeys: string[] = [];
  const thumbnailKeys: string[] = [];
  let counter = 0;

  async function createVideoRow(): Promise<Video> {
    counter += 1;
    const users = dataSource.getRepository(User);
    const channels = dataSource.getRepository(Channel);
    const user = await users.save(
      users.create({
        email: `processor_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Channel ${counter}`,
        nickname: `processor_channel_${counter}`,
        user_id: user.id,
      }),
    );
    const id = randomUUID();
    thumbnailKeys.push(`${id}/${THUMBNAIL_FILE_NAME}`);
    videoKeys.push(`${id}/source`);
    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: `proc${counter}`.padEnd(11, 'x'),
        channel_id: channel.id,
        title: 'Video',
        status: VideoStatus.PROCESSING,
        original_filename: 'video.mp4',
        declared_size: 1,
        upload_id: 'upload-id',
        source_key: `${id}/source`,
      }),
    );
  }

  async function storeSource(key: string, content: Buffer): Promise<void> {
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const { url } = await storage.signUploadPart(key, uploadId, 1);
    const response = await presignedRequest(url, {
      method: 'PUT',
      body: content,
    });
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: response.headers.etag! },
    ]);
  }

  async function createStoredVideo(content: Buffer): Promise<Video> {
    const video = await createVideoRow();
    await storeSource(video.source_key, content);
    return video;
  }

  beforeAll(async () => {
    config = storageConfig();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoMediaService, VideoProcessingService, VideoProcessor],
    }).compile();
    await module.init();
    processor = module.get(VideoProcessor);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
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

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    for (const key of videoKeys) {
      await admin.send(
        new DeleteObjectCommand({ Bucket: config.bucketVideos, Key: key }),
      );
    }
    for (const key of thumbnailKeys) {
      await admin.send(
        new DeleteObjectCommand({ Bucket: config.bucketThumbnails, Key: key }),
      );
    }
    admin.destroy();
    await cleanAllTables(dataSource);
    await module.close();
  }, 120000);

  it('should mark a valid video as ready, with the metadata and the thumbnail key', async () => {
    const video = await createStoredVideo(await generateTestVideo());

    await processor.process(jobFor(video.id));

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.READY);
    expect(Math.abs(stored.duration! - 5)).toBeLessThan(0.5);
    expect(stored.width).toBe(640);
    expect(stored.height).toBe(360);
    expect(stored.video_codec).toBe('h264');
    expect(stored.audio_codec).toBe('aac');
    expect(stored.bitrate).toBeGreaterThan(0);
    expect(stored.container).toContain('mp4');
    expect(stored.thumbnail_key).toBe(`${video.id}/${THUMBNAIL_FILE_NAME}`);
  });

  it('should leave the thumbnail readable in the thumbnails bucket', async () => {
    const video = await createStoredVideo(
      await generateTestVideo({ audio: false, durationSeconds: 1 }),
    );

    await processor.process(jobFor(video.id));

    const response = await fetch(
      `${config.endpoint}/${config.bucketThumbnails}/${video.id}/${THUMBNAIL_FILE_NAME}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    const content = Buffer.from(await response.arrayBuffer());
    expect(content.subarray(0, 2).toString('hex')).toBe(JPEG_MAGIC);
  });

  it('should keep one row and the same thumbnail key when the video is processed twice', async () => {
    const video = await createStoredVideo(
      await generateTestVideo({ audio: false, durationSeconds: 1 }),
    );

    await processor.process(jobFor(video.id));
    const first = await videoRepository.findOneByOrFail({ id: video.id });
    await processor.process(jobFor(video.id));
    const second = await videoRepository.findOneByOrFail({ id: video.id });

    await expect(videoRepository.count()).resolves.toBe(1);
    expect(second.status).toBe(VideoStatus.READY);
    expect(second.thumbnail_key).toBe(first.thumbnail_key);
    expect(second.duration).toBe(first.duration);
  });

  it('should fail for good on an invalid file and keep the object in the storage', async () => {
    const video = await createStoredVideo(
      Buffer.from('this is just a text file, not a video\n'.repeat(50)),
    );

    await expect(processor.process(jobFor(video.id))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    await expect(storage.headObject(video.source_key)).resolves.not.toBeNull();
    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.PROCESSING);
    expect(stored.thumbnail_key).toBeNull();
  });

  it('should fail for good on a video that does not exist', async () => {
    await expect(
      processor.process(jobFor(randomUUID())),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('should rethrow a failure to reach the storage as a common error', async () => {
    const video = await createVideoRow();

    const error: unknown = await processor
      .process(jobFor(video.id))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MediaCommandError);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.PROCESSING);
  });

  it('should rethrow a failed thumbnail upload, without ready, and remove the temporary file', async () => {
    const video = await createStoredVideo(
      await generateTestVideo({ audio: false, durationSeconds: 1 }),
    );
    const before = await listThumbnailTempDirs();
    const failure = new Error('storage unavailable');
    jest.spyOn(storage, 'putThumbnail').mockRejectedValueOnce(failure);

    await expect(processor.process(jobFor(video.id))).rejects.toBe(failure);

    await expect(listThumbnailTempDirs()).resolves.toEqual(before);
    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.PROCESSING);
  });

  it('should remove the temporary file after a successful run', async () => {
    const video = await createStoredVideo(
      await generateTestVideo({ audio: false, durationSeconds: 1 }),
    );
    const before = await listThumbnailTempDirs();

    await processor.process(jobFor(video.id));

    await expect(listThumbnailTempDirs()).resolves.toEqual(before);
  });
});
