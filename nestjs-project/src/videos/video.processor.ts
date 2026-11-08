import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { VideoProcessingService } from './video-processing.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';

export interface ProcessVideoJobData {
  videoId: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  constructor(private readonly videoProcessingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    await this.videoProcessingService.process(job.data.videoId);
  }
}
