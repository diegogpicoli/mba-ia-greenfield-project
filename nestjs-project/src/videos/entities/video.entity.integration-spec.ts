import { randomUUID } from 'node:crypto';
import { DataSource, type DeepPartial, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_INVALID_TEXT_REPRESENTATION = '22P02';
const PG_STRING_TOO_LONG = '22001';
const TEN_GIB = 10737418240;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `video_channel_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: DeepPartial<Video> = {},
  ): Video {
    counter += 1;
    const id = randomUUID();
    return videoRepository.create({
      id,
      public_id: `pub${counter}`.padEnd(11, 'x'),
      channel_id: channelId,
      title: 'aula.mp4',
      original_filename: 'aula.mp4',
      declared_size: 1024,
      upload_id: 'upload-id',
      source_key: `${id}/source`,
      ...overrides,
    });
  }

  it('should enforce the unique public_id constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      buildVideo(channel.id, { public_id: 'abcdefghijk' }),
    );

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { public_id: 'abcdefghijk' }),
      ),
    ).rejects.toMatchObject({ code: PG_UNIQUE_VIOLATION });
  });

  it('should reject a public_id longer than 11 characters', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { public_id: 'abcdefghijkl' }),
      ),
    ).rejects.toMatchObject({ code: PG_STRING_TOO_LONG });
  });

  it('should default status to draft', async () => {
    const channel = await createChannel();

    const { id } = await videoRepository.save(buildVideo(channel.id));

    const persisted = await videoRepository.findOneByOrFail({ id });
    expect(persisted.status).toBe(VideoStatus.DRAFT);
  });

  it.each(Object.values(VideoStatus))(
    'should accept the %s status',
    async (status) => {
      const channel = await createChannel();

      const { id } = await videoRepository.save(
        buildVideo(channel.id, { status }),
      );

      const persisted = await videoRepository.findOneByOrFail({ id });
      expect(persisted.status).toBe(status);
    },
  );

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { status: 'published' as VideoStatus }),
      ),
    ).rejects.toMatchObject({ code: PG_INVALID_TEXT_REPRESENTATION });
  });

  it('should reject a channel_id that does not exist', async () => {
    await expect(
      videoRepository.save(buildVideo(randomUUID())),
    ).rejects.toMatchObject({ code: PG_FOREIGN_KEY_VIOLATION });
  });

  it('should read declared_size back as a number', async () => {
    const channel = await createChannel();

    const { id } = await videoRepository.save(
      buildVideo(channel.id, { declared_size: TEN_GIB }),
    );

    const persisted = await videoRepository.findOneByOrFail({ id });
    expect(persisted.declared_size).toBe(TEN_GIB);
  });

  it('should read bitrate back as a number', async () => {
    const channel = await createChannel();

    const { id } = await videoRepository.save(
      buildVideo(channel.id, { bitrate: 8000000 }),
    );

    const persisted = await videoRepository.findOneByOrFail({ id });
    expect(persisted.bitrate).toBe(8000000);
  });

  it('should keep metadata and thumbnail_key null until they are written', async () => {
    const channel = await createChannel();

    const { id } = await videoRepository.save(buildVideo(channel.id));

    const persisted = await videoRepository.findOneByOrFail({ id });
    expect(persisted).toMatchObject({
      thumbnail_key: null,
      duration: null,
      width: null,
      height: null,
      video_codec: null,
      audio_codec: null,
      bitrate: null,
      container: null,
    });
  });

  it('should load the relation from both sides', async () => {
    const channel = await createChannel();
    const { id } = await videoRepository.save(buildVideo(channel.id));

    const video = await videoRepository.findOneOrFail({
      where: { id },
      relations: { channel: true },
    });
    const owner = await channelRepository.findOneOrFail({
      where: { id: channel.id },
      relations: { videos: true },
    });

    expect(video.channel.id).toBe(channel.id);
    expect(owner.videos.map((item) => item.id)).toEqual([id]);
  });
});
