import {
  OnQueueEvent,
  QueueEventsHost,
  QueueEventsListener,
} from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { VideoProcessingService } from './video-processing.service';
import {
  QUEUE_EVENTS_FIRST_ID,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

@QueueEventsListener(VIDEO_PROCESSING_QUEUE, {
  lastEventId: QUEUE_EVENTS_FIRST_ID,
})
export class VideoEventsListener extends QueueEventsHost {
  private readonly logger = new Logger(VideoEventsListener.name);

  constructor(private readonly videoProcessingService: VideoProcessingService) {
    super();
  }

  @OnQueueEvent('failed')
  async onFailed({ jobId }: { jobId: string }): Promise<void> {
    try {
      await this.videoProcessingService.markFailed(jobId);
    } catch (error) {
      this.logger.error(
        `Could not mark video ${jobId} as error`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
