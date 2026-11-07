import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  UploadNotFoundException,
  UploadPartOutOfRangeException,
  UploadPartsMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
  VideoUploadClosedException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';
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
  const videoRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    getThumbnailUrl: jest.fn(),
    signUploadPart: jest.fn(),
    listParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    signClientRead: jest.fn(),
  };
  const videoQueue = { add: jest.fn() };

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
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: videoQueue,
        },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('getOwned', () => {
    const createdAt = new Date('2026-11-06T10:00:00Z');
    const updatedAt = new Date('2026-11-06T10:05:00Z');
    const draft = {
      id: 'internal-id',
      public_id: 'public-id-1',
      channel_id: 'channel-id',
      title: 'aula.mp4',
      status: VideoStatus.DRAFT,
      original_filename: 'aula.mp4',
      declared_size: 20971520,
      upload_id: 'upload-id',
      source_key: 'internal-id/source',
      thumbnail_key: null,
      duration: null,
      width: null,
      height: null,
      video_codec: null,
      audio_codec: null,
      bitrate: null,
      container: null,
      created_at: createdAt,
      updated_at: updatedAt,
    };

    it('should map a draft to the resource, with null metadata and no internal field', async () => {
      videoRepository.findOne.mockResolvedValue(draft);

      await expect(service.getOwned('public-id-1', USER_ID)).resolves.toEqual({
        public_id: 'public-id-1',
        title: 'aula.mp4',
        status: VideoStatus.DRAFT,
        original_filename: 'aula.mp4',
        declared_size: 20971520,
        duration: null,
        width: null,
        height: null,
        video_codec: null,
        audio_codec: null,
        bitrate: null,
        container: null,
        thumbnail_url: null,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      expect(storageService.getThumbnailUrl).not.toHaveBeenCalled();
    });

    it('should build the thumbnail_url from the thumbnail key of a ready video', async () => {
      videoRepository.findOne.mockResolvedValue({
        ...draft,
        status: VideoStatus.READY,
        thumbnail_key: 'internal-id/thumbnail.jpg',
        duration: 5,
      });
      storageService.getThumbnailUrl.mockReturnValue('http://storage/thumb');

      await expect(
        service.getOwned('public-id-1', USER_ID),
      ).resolves.toMatchObject({
        status: VideoStatus.READY,
        duration: 5,
        thumbnail_url: 'http://storage/thumb',
      });
      expect(storageService.getThumbnailUrl).toHaveBeenCalledWith(
        'internal-id/thumbnail.jpg',
      );
    });

    it('should throw VIDEO_NOT_FOUND when no video matches', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getOwned('public-id-1', USER_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('signParts', () => {
    const draft = {
      status: VideoStatus.DRAFT,
      declared_size: 20971520,
      source_key: 'internal-id/source',
      upload_id: 'upload-id',
    };

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.ERROR])(
      'should refuse a video in %s',
      async (status) => {
        videoRepository.findOne.mockResolvedValue({ ...draft, status });

        await expect(
          service.signParts('public-id', USER_ID, { part_numbers: [1] }),
        ).rejects.toBeInstanceOf(VideoUploadClosedException);

        expect(storageService.signUploadPart).not.toHaveBeenCalled();
      },
    );

    it('should refuse a number above part_count, without signing any part', async () => {
      videoRepository.findOne.mockResolvedValue(draft);

      await expect(
        service.signParts('public-id', USER_ID, { part_numbers: [1, 3] }),
      ).rejects.toBeInstanceOf(UploadPartOutOfRangeException);

      expect(storageService.signUploadPart).not.toHaveBeenCalled();
    });

    it('should accept the last part and keep each URL with its number', async () => {
      videoRepository.findOne.mockResolvedValue(draft);
      storageService.signUploadPart.mockImplementation(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve({
            url: `http://storage/${partNumber}`,
            expiresAt: new Date('2026-11-06T11:00:00Z'),
          }),
      );

      const response = await service.signParts('public-id', USER_ID, {
        part_numbers: [2, 1],
      });

      expect(response.parts).toEqual([
        { part_number: 2, url: 'http://storage/2' },
        { part_number: 1, url: 'http://storage/1' },
      ]);
      expect(storageService.signUploadPart).toHaveBeenCalledWith(
        'internal-id/source',
        'upload-id',
        2,
      );
    });

    it('should report the earliest expiration among the signed URLs', async () => {
      videoRepository.findOne.mockResolvedValue(draft);
      const earliest = new Date('2026-11-06T11:00:00Z');
      storageService.signUploadPart
        .mockResolvedValueOnce({
          url: 'http://storage/1',
          expiresAt: new Date('2026-11-06T11:00:01Z'),
        })
        .mockResolvedValueOnce({
          url: 'http://storage/2',
          expiresAt: earliest,
        });

      const response = await service.signParts('public-id', USER_ID, {
        part_numbers: [1, 2],
      });

      expect(response.expires_at).toEqual(earliest);
    });
  });

  describe('getUploadProgress', () => {
    const draft = {
      status: VideoStatus.DRAFT,
      declared_size: 33554433,
      source_key: 'internal-id/source',
      upload_id: 'upload-id',
    };

    function storedPart(partNumber: number) {
      return { partNumber, etag: `"etag-${partNumber}"`, size: 16777216 };
    }

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.ERROR])(
      'should refuse a video in %s, without consulting the storage',
      async (status) => {
        videoRepository.findOne.mockResolvedValue({ ...draft, status });

        await expect(
          service.getUploadProgress('public-id', USER_ID),
        ).rejects.toBeInstanceOf(VideoUploadClosedException);

        expect(storageService.listParts).not.toHaveBeenCalled();
      },
    );

    it('should report every part as missing when nothing reached the storage', async () => {
      videoRepository.findOne.mockResolvedValue(draft);
      storageService.listParts.mockResolvedValue([]);

      await expect(
        service.getUploadProgress('public-id', USER_ID),
      ).resolves.toEqual({
        part_size: 16777216,
        part_count: 3,
        uploaded_parts: [],
        missing_part_numbers: [1, 2, 3],
      });
      expect(storageService.listParts).toHaveBeenCalledWith(
        'internal-id/source',
        'upload-id',
      );
    });

    it('should report only the parts that did not reach the storage, also in the middle', async () => {
      videoRepository.findOne.mockResolvedValue(draft);
      storageService.listParts.mockResolvedValue([
        storedPart(1),
        storedPart(3),
      ]);

      const progress = await service.getUploadProgress('public-id', USER_ID);

      expect(progress.uploaded_parts).toEqual([
        { part_number: 1, etag: '"etag-1"' },
        { part_number: 3, etag: '"etag-3"' },
      ]);
      expect(progress.missing_part_numbers).toEqual([2]);
    });

    it('should report nothing missing when every part reached the storage', async () => {
      videoRepository.findOne.mockResolvedValue(draft);
      storageService.listParts.mockResolvedValue([
        storedPart(1),
        storedPart(2),
        storedPart(3),
      ]);

      const progress = await service.getUploadProgress('public-id', USER_ID);

      expect(progress.missing_part_numbers).toEqual([]);
    });
  });

  describe('complete', () => {
    const PART_SIZE = 16777216;
    const declaredSize = PART_SIZE + 1024;
    const draft = {
      id: 'internal-id',
      public_id: 'public-id',
      status: VideoStatus.DRAFT,
      declared_size: declaredSize,
      source_key: 'internal-id/source',
      upload_id: 'upload-id',
      thumbnail_key: null,
    };
    const storedParts = [
      { partNumber: 1, etag: '"etag-1"', size: PART_SIZE },
      { partNumber: 2, etag: '"etag-2"', size: 1024 },
    ];
    const dto = {
      parts: [
        { part_number: 1, etag: '"etag-1"' },
        { part_number: 2, etag: '"etag-2"' },
      ],
    };

    function expectNothingEnqueued(): void {
      expect(videoQueue.add).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    }

    function mockDraftThenProcessing(): void {
      videoRepository.findOne
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({ ...draft, status: VideoStatus.PROCESSING });
    }

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.ERROR])(
      'should answer the current state of a video in %s, without the storage or the queue',
      async (status) => {
        videoRepository.findOne.mockResolvedValue({ ...draft, status });

        await expect(
          service.complete('public-id', USER_ID, dto),
        ).resolves.toMatchObject({ public_id: 'public-id', status });

        expect(storageService.listParts).not.toHaveBeenCalled();
        expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
        expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
        expect(storageService.headObject).not.toHaveBeenCalled();
        expectNothingEnqueued();
      },
    );

    it('should close with the client list in ascending order', async () => {
      mockDraftThenProcessing();
      storageService.listParts.mockResolvedValue(storedParts);

      await service.complete('public-id', USER_ID, {
        parts: [
          { part_number: 2, etag: 'etag-2' },
          { part_number: 1, etag: 'etag-1' },
        ],
      });

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'internal-id/source',
        'upload-id',
        [
          { partNumber: 1, etag: 'etag-1' },
          { partNumber: 2, etag: 'etag-2' },
        ],
      );
    });

    it('should enqueue after closing and only then write processing, only over a draft', async () => {
      mockDraftThenProcessing();
      storageService.listParts.mockResolvedValue(storedParts);

      await expect(
        service.complete('public-id', USER_ID, dto),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });

      expect(videoQueue.add).toHaveBeenCalledWith(
        PROCESS_VIDEO_JOB,
        { videoId: 'internal-id' },
        {
          jobId: 'internal-id',
          attempts: 3,
          backoff: { type: 'exponential', delay: 30000 },
        },
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'internal-id', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING },
      );
      const [closed] =
        storageService.completeMultipartUpload.mock.invocationCallOrder;
      const [enqueued] = videoQueue.add.mock.invocationCallOrder;
      const [written] = videoRepository.update.mock.invocationCallOrder;
      expect(closed).toBeLessThan(enqueued);
      expect(enqueued).toBeLessThan(written);
    });

    it('should answer the status read after the write, not the one read before it', async () => {
      videoRepository.findOne
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce({ ...draft, status: VideoStatus.READY });
      storageService.listParts.mockResolvedValue(storedParts);

      await expect(
        service.complete('public-id', USER_ID, dto),
      ).resolves.toMatchObject({ status: VideoStatus.READY });
    });

    it('should abort and refuse a sum above 10 GiB', async () => {
      videoRepository.findOne.mockResolvedValue(draft);
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"etag-1"', size: 10737418241 },
      ]);

      await expect(
        service.complete('public-id', USER_ID, dto),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'internal-id/source',
        'upload-id',
      );
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(storageService.headObject).not.toHaveBeenCalled();
      expectNothingEnqueued();
    });

    it('should not abort a sum of exactly 10 GiB', async () => {
      videoRepository.findOne.mockResolvedValue(draft);
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"etag-1"', size: 10737418240 },
      ]);

      await expect(
        service.complete('public-id', USER_ID, dto),
      ).rejects.toBeInstanceOf(UploadPartsMismatchException);

      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should refuse a mismatch without aborting or closing', async () => {
      videoRepository.findOne.mockResolvedValue(draft);
      storageService.listParts.mockResolvedValue(storedParts);

      await expect(
        service.complete('public-id', USER_ID, {
          parts: [{ part_number: 1, etag: '"etag-1"' }],
        }),
      ).rejects.toBeInstanceOf(UploadPartsMismatchException);

      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expectNothingEnqueued();
    });

    it('should go on when the listing finds no upload and the object has the declared size', async () => {
      mockDraftThenProcessing();
      storageService.listParts.mockRejectedValue(new UploadNotFoundException());
      storageService.headObject.mockResolvedValue({ size: declaredSize });

      await expect(
        service.complete('public-id', USER_ID, dto),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });

      expect(storageService.headObject).toHaveBeenCalledWith(
        'internal-id/source',
      );
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoQueue.add).toHaveBeenCalledTimes(1);
    });

    it('should go on when closing finds no upload and the object has the declared size', async () => {
      mockDraftThenProcessing();
      storageService.listParts.mockResolvedValue(storedParts);
      storageService.completeMultipartUpload.mockRejectedValue(
        new UploadNotFoundException(),
      );
      storageService.headObject.mockResolvedValue({ size: declaredSize });

      await expect(
        service.complete('public-id', USER_ID, dto),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });

      expect(videoQueue.add).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['does not exist', null],
      ['has another size', { size: declaredSize - 1 }],
    ])(
      'should answer UPLOAD_NOT_FOUND when the upload is gone and the object %s',
      async (_case, stored) => {
        videoRepository.findOne.mockResolvedValue(draft);
        storageService.listParts.mockRejectedValue(
          new UploadNotFoundException(),
        );
        storageService.headObject.mockResolvedValue(stored);

        await expect(
          service.complete('public-id', USER_ID, dto),
        ).rejects.toBeInstanceOf(UploadNotFoundException);

        expectNothingEnqueued();
      },
    );

    it('should not treat another storage error as a closed upload', async () => {
      const failure = new Error('storage unavailable');
      videoRepository.findOne.mockResolvedValue(draft);
      storageService.listParts.mockRejectedValue(failure);

      await expect(service.complete('public-id', USER_ID, dto)).rejects.toBe(
        failure,
      );

      expect(storageService.headObject).not.toHaveBeenCalled();
      expectNothingEnqueued();
    });

    it('should not write processing when the job could not be enqueued', async () => {
      const failure = new Error('queue unavailable');
      videoRepository.findOne.mockResolvedValue(draft);
      storageService.listParts.mockResolvedValue(storedParts);
      videoQueue.add.mockRejectedValue(failure);

      await expect(service.complete('public-id', USER_ID, dto)).rejects.toBe(
        failure,
      );

      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('getStreamUrl', () => {
    const ready = {
      status: VideoStatus.READY,
      source_key: 'internal-id/source',
    };

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
      'should refuse a video in %s, without signing',
      async (status) => {
        videoRepository.findOne.mockResolvedValue({ ...ready, status });

        await expect(
          service.getStreamUrl('public-id', USER_ID),
        ).rejects.toBeInstanceOf(VideoNotReadyException);

        expect(storageService.signClientRead).not.toHaveBeenCalled();
      },
    );

    it('should sign the read of the source of a ready video, without a disposition', async () => {
      const expiresAt = new Date('2026-11-06T16:00:00Z');
      videoRepository.findOne.mockResolvedValue(ready);
      storageService.signClientRead.mockResolvedValue({
        url: 'http://storage/source',
        expiresAt,
      });

      await expect(service.getStreamUrl('public-id', USER_ID)).resolves.toEqual(
        {
          url: 'http://storage/source',
          expires_at: expiresAt,
        },
      );
      expect(storageService.signClientRead).toHaveBeenCalledWith(
        'internal-id/source',
      );
    });
  });

  describe('getDownloadUrl', () => {
    const ready = {
      status: VideoStatus.READY,
      source_key: 'internal-id/source',
      original_filename: 'ação.mp4',
    };

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
      'should refuse a video in %s, without signing',
      async (status) => {
        videoRepository.findOne.mockResolvedValue({ ...ready, status });

        await expect(
          service.getDownloadUrl('public-id', USER_ID),
        ).rejects.toBeInstanceOf(VideoNotReadyException);

        expect(storageService.signClientRead).not.toHaveBeenCalled();
      },
    );

    it('should sign the read of the source with the original name as an attachment', async () => {
      const expiresAt = new Date('2026-11-06T16:00:00Z');
      videoRepository.findOne.mockResolvedValue(ready);
      storageService.signClientRead.mockResolvedValue({
        url: 'http://storage/source',
        expiresAt,
      });

      await expect(
        service.getDownloadUrl('public-id', USER_ID),
      ).resolves.toEqual({
        url: 'http://storage/source',
        expires_at: expiresAt,
      });
      expect(storageService.signClientRead).toHaveBeenCalledWith(
        'internal-id/source',
        `attachment; filename="a__o.mp4"; filename*=UTF-8''a%C3%A7%C3%A3o.mp4`,
      );
    });
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
