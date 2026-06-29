import {
  GetObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3 } from "./s3.js";

/**
 * Presigning, post-gateway (§7.3). Every tenant upload/download URL is signed
 * with the single Hetzner MASTER credential via the AWS SDK presigner — the
 * browser talks to Hetzner directly. Authorization (org owns bucket+key) is
 * enforced by the API route BEFORE calling these (§9), never by the signature.
 *
 * We retired per-org `api_keys` signing (`selectOrgPresignKey`) and the custom
 * `@medialocker/s3-protocol` SigV4 generator; `api_keys` keep their REST bearer
 * role only.
 */

/** Presigned GET for downloading/viewing an object. */
export async function presignGet(
  bucket: string,
  key: string,
  expiresIn: number,
): Promise<string> {
  return getSignedUrl(getS3(), new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn,
  });
}

/**
 * Presigned single-shot PUT upload. Tagging (§10.8 flat labels) is baked into
 * the signed request as `x-amz-tagging` so the client must send it verbatim and
 * the store applies it atomically with the object.
 *
 * NOTE: presigned PUT cannot enforce a size cap. The optimistic check at presign
 * + authoritative true-up at confirm bounds quota (§8). A `content-length-range`
 * POST policy (gate §3.3) would harden the common path — deferred until Hetzner
 * POST-policy support is confirmed.
 */
export async function presignPut(
  bucket: string,
  key: string,
  expiresIn: number,
  opts?: { tagging?: string },
): Promise<string> {
  return getSignedUrl(
    getS3(),
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(opts?.tagging ? { Tagging: opts.tagging } : {}),
    }),
    { expiresIn, ...(opts?.tagging ? { unhoistableHeaders: new Set(["x-amz-tagging"]) } : {}) },
  );
}

/** Presigned POST `{key}?uploads` to initiate a multipart upload. */
export async function presignCreateMultipart(
  bucket: string,
  key: string,
  expiresIn: number,
): Promise<string> {
  return getSignedUrl(
    getS3(),
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    { expiresIn },
  );
}

/** Presigned PUT `{key}?partNumber&uploadId` for a single multipart part. */
export async function presignUploadPart(
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn: number,
): Promise<string> {
  return getSignedUrl(
    getS3(),
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn },
  );
}

/**
 * Presigned POST `{key}?uploadId` to complete a multipart upload. The client
 * sends the CompleteMultipartUpload XML (collected part numbers + ETags) as the
 * body. The authoritative size/quota true-up happens at `/presign/confirm`,
 * which HEADs the assembled object (§8.2).
 */
export async function presignCompleteMultipart(
  bucket: string,
  key: string,
  uploadId: string,
  expiresIn: number,
): Promise<string> {
  return getSignedUrl(
    getS3(),
    new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
    { expiresIn },
  );
}

/** Build the flat `x-amz-tagging` header value from §10.8 tag labels. */
export function buildTaggingValue(tags?: string[]): string | undefined {
  if (!tags || tags.length === 0) return undefined;
  return tags.map((t) => encodeURIComponent(t)).join("&");
}
