import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import { VideoTooLargeException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { CreatedVideoResponseDto } from './dto/created-video-response.dto';
import { Video } from './entities/video.entity';
import {
  PUBLIC_ID_BYTES,
  PUBLIC_ID_COLUMN,
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_PART_SIZE_BYTES,
  VIDEO_SOURCE_FILE_NAME,
} from './videos.constants';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreatedVideoResponseDto> {
    if (dto.declared_size > VIDEO_MAX_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    const id = randomUUID();
    const sourceKey = `${id}/${VIDEO_SOURCE_FILE_NAME}`;
    const uploadId = await this.storageService.createMultipartUpload(
      sourceKey,
      dto.content_type,
    );
    const video = await this.saveWithUniquePublicId({
      id,
      channel_id: channel.id,
      title: dto.original_filename,
      original_filename: dto.original_filename,
      declared_size: dto.declared_size,
      upload_id: uploadId,
      source_key: sourceKey,
    });
    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      original_filename: video.original_filename,
      declared_size: video.declared_size,
      part_size: VIDEO_PART_SIZE_BYTES,
      part_count: Math.ceil(video.declared_size / VIDEO_PART_SIZE_BYTES),
      created_at: video.created_at,
      updated_at: video.updated_at,
    };
  }

  private async saveWithUniquePublicId(
    fields: Omit<Partial<Video>, 'public_id'>,
  ): Promise<Video> {
    for (let attempt = 1; attempt <= PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...fields,
            public_id: randomBytes(PUBLIC_ID_BYTES).toString('base64url'),
          }),
        );
      } catch (error) {
        if (!isPgUniqueViolationOnColumn(error, PUBLIC_ID_COLUMN)) {
          throw error;
        }
      }
    }
    throw new Error('Public id conflict could not be resolved after retries');
  }
}
