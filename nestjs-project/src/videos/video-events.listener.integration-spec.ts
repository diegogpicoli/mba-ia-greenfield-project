import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
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
import { presignedRequest } from '../test/presigned-request';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoEventsListener } from './video-events.listener';
import { VideoMediaService } from './video-media.service';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoEventsListener (integration)', () => {
  let module: TestingModule;
  let listener: VideoEventsListener;
  let processing: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let config: ConfigType<typeof storageConfig>;
  let admin: S3Client;
  const videoKeys: string[] = [];
  let counter = 0;

  async function createVideoRow(status: VideoStatus): Promise<Video> {
    counter += 1;
    const users = dataSource.getRepository(User);
    const channels = dataSource.getRepository(Channel);
    const user = await users.save(
      users.create({
        email: `listener_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Channel ${counter}`,
        nickname: `listener_channel_${counter}`,
        user_id: user.id,
      }),
    );
    const id = randomUUID();
    videoKeys.push(`${id}/source`);
    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: `lst${counter}`.padEnd(11, 'x'),
        channel_id: channel.id,
        title: 'Video',
        status,
        original_filename: 'video.mp4',
        declared_size: 1,
        upload_id: 'upload-id',
        source_key: `${id}/source`,
      }),
    );
  }

  async function storeSource(key: string): Promise<void> {
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const { url } = await storage.signUploadPart(key, uploadId, 1);
    const response = await presignedRequest(url, {
      method: 'PUT',
      body: randomBytes(1024),
    });
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: response.headers.etag! },
    ]);
  }

  async function statusOf(id: string): Promise<VideoStatus> {
    const video = await videoRepository.findOneByOrFail({ id });
    return video.status;
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
      providers: [
        VideoMediaService,
        VideoProcessingService,
        VideoEventsListener,
      ],
    }).compile();
    await module.init();
    listener = module.get(VideoEventsListener);
    processing = module.get(VideoProcessingService);
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
    admin.destroy();
    await cleanAllTables(dataSource);
    await module.close();
  }, 120000);

  it('should mark a video in processing as error and keep the object in the storage', async () => {
    const video = await createVideoRow(VideoStatus.PROCESSING);
    await storeSource(video.source_key);

    await listener.onFailed({ jobId: video.id });

    await expect(statusOf(video.id)).resolves.toBe(VideoStatus.ERROR);
    await expect(storage.headObject(video.source_key)).resolves.not.toBeNull();
  });

  it('should mark a video in draft as error, because the worker can fail before processing is written', async () => {
    const video = await createVideoRow(VideoStatus.DRAFT);

    await listener.onFailed({ jobId: video.id });

    await expect(statusOf(video.id)).resolves.toBe(VideoStatus.ERROR);
  });

  it('should not change a video in ready when the event is read again', async () => {
    const video = await createVideoRow(VideoStatus.READY);

    await listener.onFailed({ jobId: video.id });

    await expect(statusOf(video.id)).resolves.toBe(VideoStatus.READY);
  });

  it('should keep a video in error when the event is read again', async () => {
    const video = await createVideoRow(VideoStatus.PROCESSING);

    await listener.onFailed({ jobId: video.id });
    await listener.onFailed({ jobId: video.id });

    await expect(statusOf(video.id)).resolves.toBe(VideoStatus.ERROR);
  });

  it('should ignore a failed job of a video that does not exist', async () => {
    await expect(
      listener.onFailed({ jobId: randomUUID() }),
    ).resolves.toBeUndefined();
  });

  it('should log a failure to write error, without rethrowing', async () => {
    const video = await createVideoRow(VideoStatus.PROCESSING);
    const failure = new Error('database unavailable');
    jest.spyOn(processing, 'markFailed').mockRejectedValueOnce(failure);
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await expect(
      listener.onFailed({ jobId: video.id }),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(
      `Could not mark video ${video.id} as error`,
      failure.stack,
    );
    await expect(statusOf(video.id)).resolves.toBe(VideoStatus.PROCESSING);
  });

  it('should log a malformed job id read from the stream, without rethrowing', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await expect(
      listener.onFailed({ jobId: 'not-a-uuid' }),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
  });
});
