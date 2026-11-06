import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Channel } from './channels/entities/channel.entity';
import { StorageService } from './storage/storage.service';
import { User } from './users/entities/user.entity';
import { Video } from './videos/entities/video.entity';
import { VideoEventsListener } from './videos/video-events.listener';
import { VideoProcessor } from './videos/video.processor';
import { VIDEO_PROCESSING_QUEUE } from './videos/videos.constants';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile without init, so that no second consumer starts', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(VideoEventsListener)).toBeInstanceOf(VideoEventsListener);
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();
    expect(module.get(getRepositoryToken(Video))).toBeDefined();
    expect(module.get(getRepositoryToken(Channel))).toBeDefined();
    expect(module.get(getRepositoryToken(User))).toBeDefined();

    await module.close();
  }, 120000);
});
