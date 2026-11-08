export const VIDEO_PROCESSING_QUEUE = 'video-processing';

export const PROCESS_VIDEO_JOB = 'process-video';

export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
} as const;

export const QUEUE_EVENTS_FIRST_ID = '0-0';

export const VIDEO_PART_SIZE_BYTES = 16 * 1024 * 1024;

export const VIDEO_MAX_SIZE_BYTES = 10737418240;

export const VIDEO_MAX_PART_COUNT = Math.ceil(
  VIDEO_MAX_SIZE_BYTES / VIDEO_PART_SIZE_BYTES,
);

export const VIDEO_SOURCE_FILE_NAME = 'source';

export const PUBLIC_ID_BYTES = 8;

export const PUBLIC_ID_COLUMN = 'public_id';

export const PUBLIC_ID_MAX_ATTEMPTS = 5;

export const MEDIA_ALLOWED_PROTOCOLS = 'http,https,tcp,tls';

export const MEDIA_ALLOWED_FORMATS =
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,flv,asf,mpeg,ogg';

export const MEDIA_IO_TIMEOUT_MICROSECONDS = 60_000_000;

export const MEDIA_STDERR_MAX_LENGTH = 4096;

export const THUMBNAIL_POSITION_RATIO = 0.1;

export const THUMBNAIL_FILE_NAME = 'thumbnail.jpg';

export const THUMBNAIL_TEMP_DIR_PREFIX = 'video-thumbnail-';

export const REJECTED_FILE_STDERR_MARKERS = [
  'Invalid data found when processing input',
  'not on whitelist',
  'Operation not permitted',
] as const;
