import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { VideoTooLargeException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { PUBLIC_ID_MAX_ATTEMPTS } from './videos.constants';
import { VideosService } from './videos.service';

const USER_ID = 'user-id';
const DTO = {
  original_filename: 'aula.mp4',
  declared_size: 20971520,
  content_type: 'video/mp4',
};

function uniqueViolation(column: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: `Key (${column})=(x) already exists.`,
    }),
  );
}

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = { create: jest.fn(), save: jest.fn() };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = { createMultipartUpload: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-id' });
    storageService.createMultipartUpload.mockResolvedValue('upload-id');
    videoRepository.create.mockImplementation((video: Partial<Video>) => video);
    videoRepository.save.mockImplementation((video: Partial<Video>) =>
      Promise.resolve(video),
    );
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('size limit', () => {
    it('should reject one byte above 10 GiB before opening the multipart', async () => {
      await expect(
        service.createDraft(USER_ID, { ...DTO, declared_size: 10737418241 }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('should accept exactly 10 GiB', async () => {
      await expect(
        service.createDraft(USER_ID, { ...DTO, declared_size: 10737418240 }),
      ).resolves.toMatchObject({ part_count: 640 });
    });
  });

  describe('part_count', () => {
    it.each([
      [1, 1],
      [16777216, 1],
      [16777217, 2],
      [33554432, 2],
      [33554433, 3],
    ])('should plan %i bytes in %i parts', async (declaredSize, parts) => {
      await expect(
        service.createDraft(USER_ID, { ...DTO, declared_size: declaredSize }),
      ).resolves.toMatchObject({ part_size: 16777216, part_count: parts });
    });
  });

  describe('public_id collision', () => {
    it('should retry with a new public_id on 23505 of that column', async () => {
      videoRepository.save.mockRejectedValueOnce(uniqueViolation('public_id'));

      await service.createDraft(USER_ID, DTO);

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const [[first], [second]] = videoRepository.create.mock.calls as [
        [Partial<Video>],
        [Partial<Video>],
      ];
      expect(first.public_id).toHaveLength(11);
      expect(second.public_id).toHaveLength(11);
      expect(second.public_id).not.toBe(first.public_id);
      expect(second.id).toBe(first.id);
    });

    it('should not retry on 23505 of another column', async () => {
      const failure = uniqueViolation('id');
      videoRepository.save.mockRejectedValueOnce(failure);

      await expect(service.createDraft(USER_ID, DTO)).rejects.toBe(failure);

      expect(videoRepository.save).toHaveBeenCalledTimes(1);
    });

    it('should stop after the maximum number of attempts', async () => {
      videoRepository.save.mockRejectedValue(uniqueViolation('public_id'));

      await expect(service.createDraft(USER_ID, DTO)).rejects.toThrow(
        'Public id conflict',
      );

      expect(videoRepository.save).toHaveBeenCalledTimes(
        PUBLIC_ID_MAX_ATTEMPTS,
      );
    });
  });
});
