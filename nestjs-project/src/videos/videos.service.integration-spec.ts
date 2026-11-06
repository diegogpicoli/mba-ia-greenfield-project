import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Job, Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  UploadNotFoundException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  discardTestVideos,
  waitForIdleQueue,
} from '../test/discard-test-videos';
import { generateTestVideo } from '../test/generate-test-video';
import { presignedRequest } from '../test/presigned-request';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const DTO = {
  original_filename: 'aula.mp4',
  declared_size: 20971520,
  content_type: 'video/mp4',
};

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let channels: ChannelsService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let counter = 0;

  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    counter += 1;
    const users = dataSource.getRepository(User);
    const user = await users.save(
      users.create({
        email: `videos_svc_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.createChannel(user.id, user.email);
    return { user, channel };
  }

  async function sendDraft(
    userId: string,
    chunks: Buffer[],
  ): Promise<{
    publicId: string;
    parts: { part_number: number; etag: string }[];
  }> {
    const { public_id: publicId } = await service.createDraft(userId, {
      ...DTO,
      declared_size: chunks.reduce((total, { length }) => total + length, 0),
    });
    const signed = await service.signParts(publicId, userId, {
      part_numbers: chunks.map((_, index) => index + 1),
    });
    const parts: { part_number: number; etag: string }[] = [];
    for (const { part_number, url } of signed.parts) {
      const response = await presignedRequest(url, {
        method: 'PUT',
        body: chunks[part_number - 1],
      });
      expect(response.status).toBe(200);
      parts.push({ part_number, etag: response.headers.etag! });
    }
    return { publicId, parts };
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (config: ConfigType<typeof queueConfig>) => ({
            connection: { host: config.host, port: config.port },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        ChannelsModule,
        StorageModule,
      ],
      providers: [VideosService],
    }).compile();
    await module.init();
    service = module.get(VideosService);
    storage = module.get(StorageService);
    channels = module.get(ChannelsService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 120000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await discardTestVideos({ queue, videoRepository, storage });
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await module.close();
  }, 120000);

  it('should save the draft in the channel of the user, with the multipart open', async () => {
    const { user, channel } = await createUserWithChannel();

    const response = await service.createDraft(user.id, DTO);

    const video = await videoRepository.findOneByOrFail({
      public_id: response.public_id,
    });
    expect(video.channel_id).toBe(channel.id);
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.title).toBe(DTO.original_filename);
    expect(video.original_filename).toBe(DTO.original_filename);
    expect(video.declared_size).toBe(DTO.declared_size);
    expect(video.source_key).toBe(`${video.id}/source`);
    expect(video.upload_id).toBeTruthy();
    await expect(
      storage.listParts(video.source_key, video.upload_id),
    ).resolves.toEqual([]);
  });

  it('should not expose the internal fields in the response', async () => {
    const { user } = await createUserWithChannel();

    const response = await service.createDraft(user.id, DTO);

    expect(response).not.toHaveProperty('id');
    expect(response).not.toHaveProperty('upload_id');
    expect(response).not.toHaveProperty('source_key');
    expect(response).not.toHaveProperty('channel_id');
  });

  describe('signParts', () => {
    it('should sign URLs that the real MinIO accepts, and the part appears in the listing', async () => {
      const { user } = await createUserWithChannel();
      const { public_id } = await service.createDraft(user.id, DTO);

      const { parts } = await service.signParts(public_id, user.id, {
        part_numbers: [1],
      });

      const response = await presignedRequest(parts[0].url, {
        method: 'PUT',
        body: Buffer.from('part content'),
      });
      expect(response.status).toBe(200);
      expect(response.headers.etag).toBeTruthy();
      const video = await videoRepository.findOneByOrFail({ public_id });
      const listed = await storage.listParts(video.source_key, video.upload_id);
      expect(listed.map(({ partNumber }) => partNumber)).toEqual([1]);
    });

    it('should sign the 640 parts of a video of 10 GiB', async () => {
      const { user } = await createUserWithChannel();
      const { public_id } = await service.createDraft(user.id, {
        ...DTO,
        declared_size: 10737418240,
      });
      const numbers = Array.from({ length: 640 }, (_, index) => index + 1);

      const { parts } = await service.signParts(public_id, user.id, {
        part_numbers: numbers,
      });

      expect(parts.map(({ part_number }) => part_number)).toEqual(numbers);
      expect(new Set(parts.map(({ url }) => url)).size).toBe(640);
    });
  });

  describe('getUploadProgress', () => {
    it('should report the real progress in MinIO, with the ETag the client received on the PUT', async () => {
      const { user } = await createUserWithChannel();
      const { public_id } = await service.createDraft(user.id, DTO);

      await expect(
        service.getUploadProgress(public_id, user.id),
      ).resolves.toEqual({
        part_size: 16777216,
        part_count: 2,
        uploaded_parts: [],
        missing_part_numbers: [1, 2],
      });

      const { parts } = await service.signParts(public_id, user.id, {
        part_numbers: [1],
      });
      const sent = await presignedRequest(parts[0].url, {
        method: 'PUT',
        body: Buffer.from('part content'),
      });
      expect(sent.status).toBe(200);

      await expect(
        service.getUploadProgress(public_id, user.id),
      ).resolves.toEqual({
        part_size: 16777216,
        part_count: 2,
        uploaded_parts: [{ part_number: 1, etag: sent.headers.etag }],
        missing_part_numbers: [2],
      });
    });

    it('should translate an aborted upload into UPLOAD_NOT_FOUND', async () => {
      const { user } = await createUserWithChannel();
      const { public_id } = await service.createDraft(user.id, DTO);
      const video = await videoRepository.findOneByOrFail({ public_id });
      await storage.abortMultipartUpload(video.source_key, video.upload_id);

      await expect(
        service.getUploadProgress(public_id, user.id),
      ).rejects.toBeInstanceOf(UploadNotFoundException);
    });
  });

  describe('complete', () => {
    const CONTENT = Buffer.from('part content');

    function stubQueueAdd(effect?: () => Promise<unknown>) {
      return jest.spyOn(queue, 'add').mockImplementation(async () => {
        await effect?.();
        return {} as Job;
      });
    }

    it('should enqueue the planned job, retained after the video-worker takes the video to ready', async () => {
      const { user } = await createUserWithChannel();
      const { publicId, parts } = await sendDraft(user.id, [
        await generateTestVideo(),
      ]);

      await service.complete(publicId, user.id, { parts });

      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });
      const job = await queue.getJob(video.id);
      expect(job?.name).toBe(PROCESS_VIDEO_JOB);
      expect(job?.data).toEqual({ videoId: video.id });
      expect(job?.opts.attempts).toBe(3);
      expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 30000 });
      expect(job?.opts.removeOnComplete).toBeUndefined();
      expect(job?.opts.removeOnFail).toBeUndefined();
      await waitForIdleQueue(queue);
      await expect(
        videoRepository.findOneByOrFail({ id: video.id }),
      ).resolves.toMatchObject({ status: VideoStatus.READY });
      await expect(queue.getJobState(video.id)).resolves.toBe('completed');
    });

    it('should write processing when the worker has not answered yet', async () => {
      const { user } = await createUserWithChannel();
      const { publicId, parts } = await sendDraft(user.id, [CONTENT]);
      stubQueueAdd();

      const response = await service.complete(publicId, user.id, { parts });

      expect(response.status).toBe(VideoStatus.PROCESSING);
      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      await expect(storage.headObject(video.source_key)).resolves.toEqual({
        size: CONTENT.length,
      });
    });

    it.each([VideoStatus.READY, VideoStatus.ERROR])(
      'should not overwrite a %s written by the worker before the write of processing',
      async (status) => {
        const { user } = await createUserWithChannel();
        const { publicId, parts } = await sendDraft(user.id, [CONTENT]);
        stubQueueAdd(() =>
          videoRepository.update({ public_id: publicId }, { status }),
        );

        const response = await service.complete(publicId, user.id, { parts });

        expect(response.status).toBe(status);
        await expect(
          videoRepository.findOneByOrFail({ public_id: publicId }),
        ).resolves.toMatchObject({ status });
      },
    );

    it('should abort the real upload when the sum exceeds 10 GiB', async () => {
      const { user } = await createUserWithChannel();
      const { publicId, parts } = await sendDraft(user.id, [CONTENT]);
      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });
      const add = stubQueueAdd();
      jest.spyOn(storage, 'listParts').mockResolvedValueOnce([
        {
          partNumber: 1,
          etag: parts[0].etag,
          size: 10737418241,
        },
      ]);

      await expect(
        service.complete(publicId, user.id, { parts }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      await expect(
        storage.listParts(video.source_key, video.upload_id),
      ).rejects.toBeInstanceOf(UploadNotFoundException);
      expect(add).not.toHaveBeenCalled();
      await expect(
        videoRepository.findOneByOrFail({ public_id: publicId }),
      ).resolves.toMatchObject({ status: VideoStatus.DRAFT });
    });

    it('should not create a second job when the call is repeated in draft', async () => {
      const { user } = await createUserWithChannel();
      const { publicId, parts } = await sendDraft(user.id, [
        await generateTestVideo(),
      ]);
      await service.complete(publicId, user.id, { parts });
      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });
      const job = await queue.getJob(video.id);
      expect(job).toBeDefined();
      await waitForIdleQueue(queue);
      await videoRepository.update(
        { id: video.id },
        { status: VideoStatus.DRAFT },
      );

      const response = await service.complete(publicId, user.id, { parts });

      expect(response.status).toBe(VideoStatus.PROCESSING);
      const repeated = await queue.getJob(video.id);
      expect(repeated?.timestamp).toBe(job?.timestamp);
      await expect(queue.getJobState(video.id)).resolves.toBe('completed');
    });

    it('should accept the ETags without quotes in the real MinIO', async () => {
      const { user } = await createUserWithChannel();
      const { publicId, parts } = await sendDraft(user.id, [CONTENT]);
      stubQueueAdd();

      const response = await service.complete(publicId, user.id, {
        parts: parts.map(({ part_number, etag }) => ({
          part_number,
          etag: etag.replaceAll('"', ''),
        })),
      });

      expect(response.status).toBe(VideoStatus.PROCESSING);
    });

    it('should close a list sent out of order in the real MinIO', async () => {
      const { user } = await createUserWithChannel();
      const chunks = [randomBytes(16 * 1024 * 1024), randomBytes(1024)];
      const { publicId, parts } = await sendDraft(user.id, chunks);
      stubQueueAdd();

      const response = await service.complete(publicId, user.id, {
        parts: [...parts].reverse(),
      });

      expect(response.status).toBe(VideoStatus.PROCESSING);
      const video = await videoRepository.findOneByOrFail({
        public_id: publicId,
      });
      await expect(storage.headObject(video.source_key)).resolves.toEqual({
        size: chunks[0].length + chunks[1].length,
      });
    });
  });

  describe('getStreamUrl', () => {
    it('should give a URL that the real MinIO answers with a Range in the middle of the file', async () => {
      const { user } = await createUserWithChannel();
      const content = randomBytes(2048);
      const { publicId, parts } = await sendDraft(user.id, [content]);
      jest.spyOn(queue, 'add').mockResolvedValue({} as Job);
      await service.complete(publicId, user.id, { parts });
      await videoRepository.update(
        { public_id: publicId },
        { status: VideoStatus.READY },
      );

      const { url, expires_at } = await service.getStreamUrl(publicId, user.id);

      const signed = new URL(url);
      expect(signed.origin).toBe(storageConfig().publicEndpoint);
      expect(signed.searchParams.get('X-Amz-Expires')).toBe('21600');
      expect(expires_at).toBeInstanceOf(Date);
      const read = await presignedRequest(url, {
        headers: { Range: 'bytes=1024-1535' },
      });
      expect(read.status).toBe(206);
      expect(read.headers['content-range']).toBe('bytes 1024-1535/2048');
      expect(read.headers['content-type']).toBe(DTO.content_type);
      expect(read.body.equals(content.subarray(1024, 1536))).toBe(true);
    });
  });

  describe('findOwned', () => {
    it('should return the video to its owner', async () => {
      const { user, channel } = await createUserWithChannel();
      const { public_id } = await service.createDraft(user.id, DTO);

      const video = await service.findOwned(public_id, user.id);

      expect(video.public_id).toBe(public_id);
      expect(video.channel_id).toBe(channel.id);
    });

    it('should not find the video of another channel', async () => {
      const owner = await createUserWithChannel();
      const other = await createUserWithChannel();
      const { public_id } = await service.createDraft(owner.user.id, DTO);

      await expect(
        service.findOwned(public_id, other.user.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should not find a public_id that does not exist', async () => {
      const { user } = await createUserWithChannel();

      await expect(
        service.findOwned('doesnotexis', user.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  it('should give each draft its own public_id and key', async () => {
    const { user } = await createUserWithChannel();

    const first = await service.createDraft(user.id, DTO);
    const second = await service.createDraft(user.id, DTO);

    expect(second.public_id).not.toBe(first.public_id);
    await expect(videoRepository.count()).resolves.toBe(2);
  });
});
