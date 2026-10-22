// Object storage for saved sign-in state: any S3-compatible service (AWS S3, Cloudflare R2, Aliyun OSS, MinIO).
// Objects are sealed with the server key before they leave the process.
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from './config.js';
import { openBytes, sealBytes } from './crypto.js';

export interface Storage {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export async function createStorage(config: Config): Promise<Storage> {
  const { bucket, ...s3 } = config.s3;
  // Checksums only where S3 requires them: the SDK's default CRC32 on every upload isn't accepted by R2 and some others.
  const client = new S3Client({ endpoint: s3.endpoint, region: s3.region, forcePathStyle: s3.forcePathStyle, credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  // Development creates its bucket; in production it must already exist.
  if (process.env.NODE_ENV !== 'production') await client.send(new HeadBucketCommand({ Bucket: bucket })).catch(() => client.send(new CreateBucketCommand({ Bucket: bucket })));
  return {
    put: async (key, body) => { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: sealBytes(body) })); },
    get: async key => openBytes(Buffer.from(await (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray())),
    delete: async key => { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); }
  };
}
