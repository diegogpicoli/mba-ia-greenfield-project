import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomBytes, randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  UploadNotFoundException,
  UploadPartOutOfRangeException,
  UploadPartsMismatchException,
  VideoNotFoundException,
  VideoTooLargeException,
  VideoUploadClosedException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import type {
  CompletedPartDto,
  CompleteVideoDto,
} from './dto/complete-video.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { CreatedVideoResponseDto } from './dto/created-video-response.dto';
import type { SignPartsDto } from './dto/sign-parts.dto';
import type { SignedPartsResponseDto } from './dto/signed-parts-response.dto';
import type { UploadProgressResponseDto } from './dto/upload-progress-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { partsMatchDeclaredFile, sumPartSizes } from './part-verification.util';
import type { ProcessVideoJobData } from './video.processor';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  PUBLIC_ID_BYTES,
  PUBLIC_ID_COLUMN,
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_PART_SIZE_BYTES,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_SOURCE_FILE_NAME,
} from './videos.constants';

function partCountOf(declaredSize: number): number {
  return Math.ceil(declaredSize / VIDEO_PART_SIZE_BYTES);
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoQueue: Queue<ProcessVideoJobData>,
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
      part_count: partCountOf(video.declared_size),
      created_at: video.created_at,
      updated_at: video.updated_at,
    };
  }

  async getOwned(publicId: string, userId: string): Promise<VideoResponseDto> {
    return this.toResponse(await this.findOwned(publicId, userId));
  }

  async findOwned(publicId: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async signParts(
    publicId: string,
    userId: string,
    dto: SignPartsDto,
  ): Promise<SignedPartsResponseDto> {
    const video = await this.findOwnedDraft(publicId, userId);
    const partCount = partCountOf(video.declared_size);
    if (dto.part_numbers.some((partNumber) => partNumber > partCount)) {
      throw new UploadPartOutOfRangeException();
    }
    const signed = await Promise.all(
      dto.part_numbers.map((partNumber) =>
        this.storageService.signUploadPart(
          video.source_key,
          video.upload_id,
          partNumber,
        ),
      ),
    );
    return {
      parts: signed.map(({ url }, index) => ({
        part_number: dto.part_numbers[index],
        url,
      })),
      expires_at: new Date(
        Math.min(...signed.map(({ expiresAt }) => expiresAt.getTime())),
      ),
    };
  }

  async getUploadProgress(
    publicId: string,
    userId: string,
  ): Promise<UploadProgressResponseDto> {
    const video = await this.findOwnedDraft(publicId, userId);
    const uploaded = await this.storageService.listParts(
      video.source_key,
      video.upload_id,
    );
    const partCount = partCountOf(video.declared_size);
    const uploadedNumbers = new Set(
      uploaded.map(({ partNumber }) => partNumber),
    );
    return {
      part_size: VIDEO_PART_SIZE_BYTES,
      part_count: partCount,
      uploaded_parts: uploaded.map(({ partNumber, etag }) => ({
        part_number: partNumber,
        etag,
      })),
      missing_part_numbers: Array.from(
        { length: partCount },
        (_, index) => index + 1,
      ).filter((partNumber) => !uploadedNumbers.has(partNumber)),
    };
  }

  async complete(
    publicId: string,
    userId: string,
    dto: CompleteVideoDto,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwned(publicId, userId);
    if (video.status !== VideoStatus.DRAFT) {
      return this.toResponse(video);
    }
    await this.closeUpload(video, dto.parts);
    await this.videoQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: video.id },
    );
    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING },
    );
    return this.getOwned(publicId, userId);
  }

  private async findOwnedDraft(
    publicId: string,
    userId: string,
  ): Promise<Video> {
    const video = await this.findOwned(publicId, userId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoUploadClosedException();
    }
    return video;
  }

  private async closeUpload(
    video: Video,
    parts: CompletedPartDto[],
  ): Promise<void> {
    try {
      await this.verifyAndCompleteUpload(video, parts);
    } catch (error) {
      if (!(error instanceof UploadNotFoundException)) {
        throw error;
      }
      const stored = await this.storageService.headObject(video.source_key);
      if (stored?.size !== video.declared_size) {
        throw error;
      }
    }
  }

  private async verifyAndCompleteUpload(
    video: Video,
    parts: CompletedPartDto[],
  ): Promise<void> {
    const storedParts = await this.storageService.listParts(
      video.source_key,
      video.upload_id,
    );
    if (sumPartSizes(storedParts) > VIDEO_MAX_SIZE_BYTES) {
      await this.storageService.abortMultipartUpload(
        video.source_key,
        video.upload_id,
      );
      throw new VideoTooLargeException();
    }
    const matches = partsMatchDeclaredFile({
      clientParts: parts,
      storedParts,
      partCount: partCountOf(video.declared_size),
      declaredSize: video.declared_size,
    });
    if (!matches) {
      throw new UploadPartsMismatchException();
    }
    await this.storageService.completeMultipartUpload(
      video.source_key,
      video.upload_id,
      [...parts]
        .sort((first, second) => first.part_number - second.part_number)
        .map(({ part_number, etag }) => ({ partNumber: part_number, etag })),
    );
  }

  private toResponse(video: Video): VideoResponseDto {
    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      original_filename: video.original_filename,
      declared_size: video.declared_size,
      duration: video.duration,
      width: video.width,
      height: video.height,
      video_codec: video.video_codec,
      audio_codec: video.audio_codec,
      bitrate: video.bitrate,
      container: video.container,
      thumbnail_url: video.thumbnail_key
        ? this.storageService.getThumbnailUrl(video.thumbnail_key)
        : null,
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
