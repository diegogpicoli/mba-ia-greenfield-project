import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { In, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoFileRejectedError } from './video-media.errors';
import { VideoMediaService } from './video-media.service';
import {
  THUMBNAIL_FILE_NAME,
  THUMBNAIL_TEMP_DIR_PREFIX,
} from './videos.constants';

@Injectable()
export class VideoProcessingService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly videoMediaService: VideoMediaService,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new UnrecoverableError(`Video ${videoId} not found`);
    }
    try {
      await this.processVideo(video);
    } catch (error) {
      if (error instanceof VideoFileRejectedError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  async markFailed(jobId: string): Promise<void> {
    await this.videoRepository.update(
      { id: jobId, status: In([VideoStatus.DRAFT, VideoStatus.PROCESSING]) },
      { status: VideoStatus.ERROR },
    );
  }

  private async processVideo(video: Video): Promise<void> {
    const { url } = await this.storageService.signWorkerRead(video.source_key);
    const metadata = await this.videoMediaService.probe(url);
    const thumbnailKey = `${video.id}/${THUMBNAIL_FILE_NAME}`;
    const directory = await mkdtemp(join(tmpdir(), THUMBNAIL_TEMP_DIR_PREFIX));
    try {
      const output = join(directory, THUMBNAIL_FILE_NAME);
      await this.videoMediaService.extractThumbnail(
        url,
        metadata.duration,
        output,
      );
      await this.storageService.putThumbnail(
        thumbnailKey,
        await readFile(output),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    await this.videoRepository.update(
      { id: video.id },
      { ...metadata, status: VideoStatus.READY, thumbnail_key: thumbnailKey },
    );
  }
}
