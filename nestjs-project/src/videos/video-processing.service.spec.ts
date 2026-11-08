import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  MediaCommandError,
  VideoFileRejectedError,
} from './video-media.errors';
import { VideoMediaService } from './video-media.service';
import { VideoProcessingService } from './video-processing.service';

const VIDEO = { id: 'video-id', source_key: 'video-id/source' } as Video;

describe('VideoProcessingService', () => {
  let module: TestingModule;
  let service: VideoProcessingService;
  const videoRepository = { findOneBy: jest.fn(), update: jest.fn() };
  const storageService = { signWorkerRead: jest.fn(), putThumbnail: jest.fn() };
  const videoMediaService = { probe: jest.fn(), extractThumbnail: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    videoRepository.findOneBy.mockResolvedValue(VIDEO);
    storageService.signWorkerRead.mockResolvedValue({
      url: 'http://minio:9000/signed',
    });
    module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: VideoMediaService, useValue: videoMediaService },
      ],
    }).compile();
    service = module.get(VideoProcessingService);
  });

  it('should fail for good when the video does not exist', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(service.process('missing')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    expect(storageService.signWorkerRead).not.toHaveBeenCalled();
  });

  it('should fail for good when ffprobe rejects the file', async () => {
    videoMediaService.probe.mockRejectedValue(
      new VideoFileRejectedError('no video stream'),
    );

    const error: unknown = await service
      .process(VIDEO.id)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toContain('no video stream');
  });

  it('should rethrow a failure to reach the storage, so that the job is retried', async () => {
    const failure = new MediaCommandError(
      'ffprobe',
      '<url>: Server returned 404 Not Found',
    );
    videoMediaService.probe.mockRejectedValue(failure);

    await expect(service.process(VIDEO.id)).rejects.toBe(failure);
  });

  it('should rethrow a failure to sign the read, so that the job is retried', async () => {
    const failure = new Error('signing failed');
    storageService.signWorkerRead.mockRejectedValue(failure);

    await expect(service.process(VIDEO.id)).rejects.toBe(failure);
  });
});
