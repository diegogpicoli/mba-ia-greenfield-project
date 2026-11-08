export const SIGNED_URL_TTL_SECONDS = {
  UPLOAD_PART: 60 * 60,
  CLIENT_READ: 6 * 60 * 60,
  WORKER_READ: 60 * 60,
} as const;

export const LIST_PARTS_PAGE_SIZE = 1000;

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

export const S3_ERRORS = {
  BUCKET_ALREADY_OWNED_BY_YOU: 'BucketAlreadyOwnedByYou',
  NO_SUCH_UPLOAD: 'NoSuchUpload',
  NOT_FOUND: 'NotFound',
} as const;
