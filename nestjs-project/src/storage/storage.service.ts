import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { UploadNotFoundException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import {
  LIST_PARTS_PAGE_SIZE,
  S3_ERRORS,
  SIGNED_URL_TTL_SECONDS,
  THUMBNAIL_CONTENT_TYPE,
} from './storage.constants';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface StoredObject {
  size: number;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

function isS3Error(error: unknown, name: string): boolean {
  return error instanceof S3ServiceException && error.name === name;
}

function toSignedUrl(url: string, ttlSeconds: number): SignedUrl {
  return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
}

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.internalClient = this.createClient(config.endpoint);
    this.publicClient = this.createClient(config.publicEndpoint);
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket(this.config.bucketVideos);
    await this.ensureBucket(this.config.bucketThumbnails);
    await this.internalClient.send(
      new PutBucketPolicyCommand({
        Bucket: this.config.bucketThumbnails,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: '*',
              Action: 's3:GetObject',
              Resource: `arn:aws:s3:::${this.config.bucketThumbnails}/*`,
            },
          ],
        }),
      }),
    );
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucketVideos,
        Key: key,
        ContentType: contentType,
      }),
    );
    return UploadId!;
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.translateUploadErrors(() =>
        this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.config.bucketVideos,
            Key: key,
            UploadId: uploadId,
            MaxParts: LIST_PARTS_PAGE_SIZE,
            PartNumberMarker: marker,
          }),
        ),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber!,
          etag: part.ETag!,
          size: part.Size!,
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker !== undefined);
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.translateUploadErrors(() =>
      this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucketVideos,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map(({ partNumber, etag }) => ({
              PartNumber: partNumber,
              ETag: etag,
            })),
          },
        }),
      ),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.translateUploadErrors(() =>
      this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucketVideos,
          Key: key,
          UploadId: uploadId,
        }),
      ),
    );
  }

  async headObject(key: string): Promise<StoredObject | null> {
    try {
      const { ContentLength } = await this.internalClient.send(
        new HeadObjectCommand({
          Bucket: this.config.bucketVideos,
          Key: key,
        }),
      );
      return { size: ContentLength! };
    } catch (error) {
      if (isS3Error(error, S3_ERRORS.NOT_FOUND)) {
        return null;
      }
      throw error;
    }
  }

  async signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<SignedUrl> {
    const expiresIn = SIGNED_URL_TTL_SECONDS.UPLOAD_PART;
    const url = await getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.bucketVideos,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
    return toSignedUrl(url, expiresIn);
  }

  async signClientRead(
    key: string,
    contentDisposition?: string,
  ): Promise<SignedUrl> {
    const expiresIn = SIGNED_URL_TTL_SECONDS.CLIENT_READ;
    const url = await getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.config.bucketVideos,
        Key: key,
        ResponseContentDisposition: contentDisposition,
      }),
      { expiresIn },
    );
    return toSignedUrl(url, expiresIn);
  }

  async signWorkerRead(key: string): Promise<SignedUrl> {
    const expiresIn = SIGNED_URL_TTL_SECONDS.WORKER_READ;
    const url = await getSignedUrl(
      this.internalClient,
      new GetObjectCommand({
        Bucket: this.config.bucketVideos,
        Key: key,
      }),
      { expiresIn },
    );
    return toSignedUrl(url, expiresIn);
  }

  getThumbnailUrl(key: string): string {
    return `${this.config.publicEndpoint}/${this.config.bucketThumbnails}/${key}`;
  }

  async putThumbnail(key: string, body: Buffer): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucketThumbnails,
        Key: key,
        Body: body,
        ContentType: THUMBNAIL_CONTENT_TYPE,
      }),
    );
  }

  private createClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  private async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.internalClient.send(
        new CreateBucketCommand({ Bucket: bucket }),
      );
    } catch (error) {
      if (!isS3Error(error, S3_ERRORS.BUCKET_ALREADY_OWNED_BY_YOU)) {
        throw error;
      }
    }
  }

  private async translateUploadErrors<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isS3Error(error, S3_ERRORS.NO_SUCH_UPLOAD)) {
        throw new UploadNotFoundException();
      }
      throw error;
    }
  }
}
