import { AbstractFileProviderService, MedusaError } from '@medusajs/framework/utils';
import { FileTypes, Logger } from '@medusajs/framework/types';
import path from 'path';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ObjectCannedACL,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { PassThrough, Readable, Writable } from 'stream';
import { ulid } from 'ulid';

// External options shape (snake_case, as set in medusa-config.ts)
type S3Options = {
  file_url: string;
  access_key_id: string;
  secret_access_key: string;
  region: string;
  bucket: string;
  endpoint: string;
  prefix?: string;
  private_bucket?: string;
  private_file_url?: string;
  cache_control?: string;
  download_file_duration?: number;
};

// Internal config shape (camelCase)
type S3Config = {
  fileUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  endpoint: string;
  prefix: string;
  privateBucket?: string;
  privateFileUrl?: string;
  cacheControl?: string;
  downloadFileDuration: number;
};

type InjectedDependencies = {
  logger: Logger;
};

const DEFAULT_DOWNLOAD_EXPIRATION_DURATION_SECONDS = 60 * 60;

const appendTrailingSlash = (prefix?: string) => (!prefix || prefix.endsWith('/') ? (prefix ?? '') : `${prefix}/`);

// The Medusa fileKey encodes the bucket type to enable correct bucket routing.
// Format: "pub|<s3key>" for public bucket, "prv|<s3key>" for private bucket.
const BUCKET_PREFIX_PUBLIC = 'pub';
const BUCKET_PREFIX_PRIVATE = 'prv';
const BUCKET_PREFIX_SEP = '|';

export class CloudflareR2ProviderService extends AbstractFileProviderService {
  static identifier = 'r2';
  protected config_: S3Config;
  protected logger_: Logger;
  protected client_: S3Client;

  constructor({ logger }: InjectedDependencies, options: S3Options) {
    super();

    if (!options.access_key_id || !options.secret_access_key) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Access key ID and secret access key are required'
      );
    }

    this.config_ = {
      fileUrl: options.file_url,
      accessKeyId: options.access_key_id,
      secretAccessKey: options.secret_access_key,
      region: options.region,
      bucket: options.bucket,
      endpoint: options.endpoint,
      prefix: appendTrailingSlash(options.prefix),
      privateBucket: options.private_bucket,
      privateFileUrl: options.private_file_url,
      cacheControl: options.cache_control,
      downloadFileDuration: options.download_file_duration ?? DEFAULT_DOWNLOAD_EXPIRATION_DURATION_SECONDS,
    };

    this.logger_ = logger;
    this.client_ = this.getClient();
  }

  protected getClient(): S3Client {
    return new S3Client({
      region: this.config_.region,
      credentials: {
        accessKeyId: this.config_.accessKeyId,
        secretAccessKey: this.config_.secretAccessKey,
      },
      endpoint: this.config_.endpoint,
    });
  }

  /**
   * Parses a Medusa fileKey into its bucket type and the actual S3 object key.
   * Keys are stored as "pub|<s3key>" or "prv|<s3key>" to encode the target bucket.
   * Legacy keys without a prefix are treated as public bucket keys.
   */
  private parseFileKey(fileKey: string): { isPublic: boolean; s3Key: string } {
    const sepIndex = fileKey.indexOf(BUCKET_PREFIX_SEP);
    if (sepIndex === -1) {
      // Legacy key without bucket prefix — default to public bucket
      return { isPublic: true, s3Key: fileKey };
    }
    const bucketPrefix = fileKey.substring(0, sepIndex);
    const s3Key = fileKey.substring(sepIndex + 1);
    return { isPublic: bucketPrefix === BUCKET_PREFIX_PUBLIC, s3Key };
  }

  private getBucket(isPublic: boolean): string {
    if (isPublic) {
      return this.config_.bucket;
    }
    if (!this.config_.privateBucket) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Private bucket is not configured but a private file operation was requested'
      );
    }
    return this.config_.privateBucket;
  }

  private encodeFileKey(isPublic: boolean, s3Key: string): string {
    const prefix = isPublic ? BUCKET_PREFIX_PUBLIC : BUCKET_PREFIX_PRIVATE;
    return `${prefix}${BUCKET_PREFIX_SEP}${s3Key}`;
  }

  private getFileUrl(isPublic: boolean, s3Key: string): string {
    const baseUrl = isPublic
      ? this.config_.fileUrl
      : (this.config_.privateFileUrl ?? this.config_.fileUrl);
    return `${baseUrl}/${s3Key}`;
  }

  async upload(file: FileTypes.ProviderUploadFileDTO): Promise<FileTypes.ProviderFileResultDTO> {
    if (!file) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `No file provided`);
    }
    if (!file.filename) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `No filename provided`);
    }

    const isPublic = file.access === 'public';
    const parsedFilename = path.parse(file.filename);
    const baseName = parsedFilename.dir
      ? `${parsedFilename.dir}/${parsedFilename.name}`
      : parsedFilename.name;
    const s3Key = `${this.config_.prefix}${baseName}-${ulid()}${parsedFilename.ext}`;
    const fileKey = this.encodeFileKey(isPublic, s3Key);

    let content: Buffer;
    try {
      const decoded = Buffer.from(file.content, 'base64');
      if (decoded.toString('base64') === file.content) {
        content = decoded;
      } else {
        content = Buffer.from(file.content, 'utf8');
      }
    } catch {
      content = Buffer.from(file.content, 'binary');
    }

    const command = new PutObjectCommand({
      ACL: isPublic ? 'public-read' : 'private',
      Bucket: this.getBucket(isPublic),
      Body: content,
      Key: s3Key,
      ContentType: file.mimeType,
      CacheControl: this.config_.cacheControl,
      Metadata: {
        'original-filename': encodeURIComponent(file.filename),
      },
    });

    try {
      await this.client_.send(command);
    } catch (e) {
      this.logger_.error(e);
      throw e;
    }

    return {
      url: this.getFileUrl(isPublic, s3Key),
      key: fileKey,
    };
  }

  async delete(files: FileTypes.ProviderDeleteFileDTO | FileTypes.ProviderDeleteFileDTO[]): Promise<void> {
    const fileArray = Array.isArray(files) ? files : [files];

    const publicS3Keys: string[] = [];
    const privateS3Keys: string[] = [];

    for (const file of fileArray) {
      const { isPublic, s3Key } = this.parseFileKey(file.fileKey);
      if (isPublic) {
        publicS3Keys.push(s3Key);
      } else {
        privateS3Keys.push(s3Key);
      }
    }

    const deleteFromBucket = async (bucket: string, keys: string[]) => {
      if (keys.length === 0) return;
      try {
        if (keys.length === 1) {
          await this.client_.send(new DeleteObjectCommand({ Bucket: bucket, Key: keys[0] }));
        } else {
          await this.client_.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }));
        }
      } catch (e) {
        this.logger_.error(e);
      }
    };

    await Promise.all([
      deleteFromBucket(this.config_.bucket, publicS3Keys),
      this.config_.privateBucket
        ? deleteFromBucket(this.config_.privateBucket, privateS3Keys)
        : Promise.resolve(),
    ]);
  }

  async getPresignedDownloadUrl(fileData: FileTypes.ProviderGetFileDTO): Promise<string> {
    const { isPublic, s3Key } = this.parseFileKey(fileData.fileKey);

    // Public files are served via CDN — return the direct URL instead of a presigned one
    if (isPublic) {
      return this.getFileUrl(true, s3Key);
    }

    const command = new GetObjectCommand({
      Bucket: this.getBucket(false),
      Key: s3Key,
    });

    return await getSignedUrl(this.client_ as any, command as any, {
      expiresIn: this.config_.downloadFileDuration,
    });
  }

  async getDownloadStream(fileData: FileTypes.ProviderGetFileDTO): Promise<Readable> {
    if (!fileData?.fileKey) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `No fileKey provided`);
    }
    const { isPublic, s3Key } = this.parseFileKey(fileData.fileKey);
    const response = await this.client_.send(new GetObjectCommand({
      Bucket: this.getBucket(isPublic),
      Key: s3Key,
    }));
    return response.Body as Readable;
  }

  async getAsBuffer(fileData: FileTypes.ProviderGetFileDTO): Promise<Buffer> {
    if (!fileData?.fileKey) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `No fileKey provided`);
    }
    const { isPublic, s3Key } = this.parseFileKey(fileData.fileKey);
    const response = await this.client_.send(new GetObjectCommand({
      Bucket: this.getBucket(isPublic),
      Key: s3Key,
    }));
    return Buffer.from(await (response.Body as any).transformToByteArray());
  }

  async getPresignedUploadUrl(
    fileData: FileTypes.ProviderGetPresignedUploadUrlDTO
  ): Promise<FileTypes.ProviderFileResultDTO> {
    if (!fileData?.filename) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `No filename provided`);
    }

    const isPublic = fileData.access === 'public';
    const s3Key = `${this.config_.prefix}${fileData.filename}`;
    const fileKey = this.encodeFileKey(isPublic, s3Key);

    let acl: ObjectCannedACL | undefined;
    if (fileData.access) {
      acl = isPublic ? 'public-read' : 'private';
    }

    const command = new PutObjectCommand({
      Bucket: this.getBucket(isPublic),
      ContentType: fileData.mimeType,
      ACL: acl,
      Key: s3Key,
    });

    const signedUrl = await getSignedUrl(this.client_, command, {
      expiresIn: fileData.expiresIn ?? DEFAULT_DOWNLOAD_EXPIRATION_DURATION_SECONDS,
    });

    return { url: signedUrl, key: fileKey };
  }

  async getUploadStream(fileData: FileTypes.ProviderUploadStreamDTO): Promise<{
    writeStream: Writable;
    promise: Promise<FileTypes.ProviderFileResultDTO>;
    url: string;
    fileKey: string;
  }> {
    if (!fileData.filename) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `No filename provided`);
    }

    const isPublic = fileData.access === 'public';
    const parsedFilename = path.parse(fileData.filename);
    const s3Key = `${this.config_.prefix}${parsedFilename.name}-${ulid()}${parsedFilename.ext}`;
    const fileKey = this.encodeFileKey(isPublic, s3Key);
    const url = this.getFileUrl(isPublic, s3Key);

    const pass = new PassThrough();
    const upload = new Upload({
      client: this.client_,
      params: {
        ACL: isPublic ? 'public-read' : 'private',
        Bucket: this.getBucket(isPublic),
        Key: s3Key,
        Body: pass,
        ContentType: fileData.mimeType,
        CacheControl: this.config_.cacheControl,
        Metadata: {
          'original-filename': encodeURIComponent(fileData.filename),
        },
      },
    });

    const promise = upload.done().then(() => ({ url, key: fileKey }));

    return { writeStream: pass, promise, url, fileKey };
  }
}
