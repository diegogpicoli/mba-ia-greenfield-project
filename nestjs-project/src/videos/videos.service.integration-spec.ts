import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  UploadNotFoundException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
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

  async function abortOpenUploads(): Promise<void> {
    for (const video of await videoRepository.find()) {
      await storage.abortMultipartUpload(video.source_key, video.upload_id);
    }
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
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
  }, 120000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(async () => {
    await abortOpenUploads();
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
