import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Queue } from 'bullmq';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Repository } from 'typeorm';
import { UploadNotFoundException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import type { StorageService } from '../storage/storage.service';
import { type Video, VideoStatus } from '../videos/entities/video.entity';

const QUEUE_IDLE_TIMEOUT_MS = 45_000;
const QUEUE_IDLE_POLL_MS = 200;

interface TestVideoDependencies {
  queue: Queue;
  videoRepository: Repository<Video>;
  storage: StorageService;
}

export async function waitForIdleQueue(queue: Queue): Promise<void> {
  const deadline = Date.now() + QUEUE_IDLE_TIMEOUT_MS;
  for (;;) {
    const pending = await queue.getJobCountByTypes(
      'waiting',
      'active',
      'delayed',
      'prioritized',
    );
    if (pending === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${pending} job(s) still pending in ${queue.name}. Is the video-worker service running?`,
      );
    }
    await sleep(QUEUE_IDLE_POLL_MS);
  }
}

async function abortUpload(
  storage: StorageService,
  video: Video,
): Promise<void> {
  try {
    await storage.abortMultipartUpload(video.source_key, video.upload_id);
  } catch (error) {
    if (!(error instanceof UploadNotFoundException)) {
      throw error;
    }
  }
}

/**
 * Waits for the video-worker service to finish what a test enqueued, so that a
 * job does not run against a row that is about to be deleted, and then removes
 * from the storage and from the queue what the rows point to. The rows
 * themselves stay, for `cleanAllTables`.
 */
export async function discardTestVideos({
  queue,
  videoRepository,
  storage,
}: TestVideoDependencies): Promise<void> {
  await waitForIdleQueue(queue);
  const config = storageConfig();
  const admin = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });
  for (const video of await videoRepository.find()) {
    await queue.remove(video.id);
    if (video.status === VideoStatus.DRAFT) {
      await abortUpload(storage, video);
    }
    await admin.send(
      new DeleteObjectCommand({
        Bucket: config.bucketVideos,
        Key: video.source_key,
      }),
    );
    if (video.thumbnail_key) {
      await admin.send(
        new DeleteObjectCommand({
          Bucket: config.bucketThumbnails,
          Key: video.thumbnail_key,
        }),
      );
    }
  }
  admin.destroy();
}
