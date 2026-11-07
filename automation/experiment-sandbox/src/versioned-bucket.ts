/**
 * Empties and deletes a versioned S3 bucket: every object version, delete marker and
 * unfinished multipart upload, then the bucket. Each run does a bounded amount of work;
 * repeat it until the bucket is gone.
 */

import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';

import {
  deleteObjectsResponseSchema,
  multipartUploadPageSchema,
  objectVersionPageSchema,
  parseAwsResponse,
} from './aws-responses';
import type { AwsRunner } from './aws-runner';

/** Batches of deletions per run; a bigger bucket needs another `finalize-controls`. */
const MAX_CLEANUP_BATCHES = 10;

/** S3 deletes at most 1000 objects per DeleteObjects call. */
const MAX_OBJECTS_PER_BATCH = 1000;

/** Multipart uploads listed per batch. */
const UPLOADS_PER_BATCH = 100;

/**
 * Deletes the bucket after removing all its contents. Every call names the expected
 * bucket owner, so a same-named bucket in another account is never touched.
 *
 * @throws Error when contents remain after the batch limit, or S3 reports a failed deletion
 */
export function deleteVersionedBucket(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  bucket: string,
  ownerAccountId: string,
): void {
  const pinnedBucket = ['--bucket', bucket, '--expected-bucket-owner', ownerAccountId];

  deleteAllObjectVersions(run, access, pinnedBucket);
  abortAllMultipartUploads(run, access, pinnedBucket);
  run(access, ['s3api', 'delete-bucket', ...pinnedBucket]);
}

/** Lists and deletes object versions and delete markers, batch by batch, until none are left. */
function deleteAllObjectVersions(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  pinnedBucket: readonly string[],
): void {
  for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch++) {
    const page = parseAwsResponse(
      objectVersionPageSchema,
      run(access, [
        's3api',
        'list-object-versions',
        ...pinnedBucket,
        '--max-keys',
        String(MAX_OBJECTS_PER_BATCH),
        '--no-paginate',
      ]),
      'list-object-versions',
    );

    const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];

    if (versions.length === 0) {
      if (page.IsTruncated) {
        throw new Error('Ambiguous empty bucket version page');
      }

      return;
    }

    if (versions.length > MAX_OBJECTS_PER_BATCH) {
      throw new Error('Bucket version batch exceeds bound');
    }

    const objects = versions.map(({ Key, VersionId }) => ({ Key, VersionId }));

    const result = parseAwsResponse(
      deleteObjectsResponseSchema,
      run(access, [
        's3api',
        'delete-objects',
        ...pinnedBucket,
        '--delete',
        JSON.stringify({ Objects: objects, Quiet: true }),
      ]),
      'delete-objects',
    );

    if (result.Errors?.length) {
      throw new Error('Versioned control bucket deletion failed; preserve manifest and retry');
    }
  }

  throw new Error(
    'Control bucket exceeds ten cleanup batches; preserve manifest and repeat finalize-controls',
  );
}

/** Aborts unfinished multipart uploads, batch by batch, until none are left. */
function abortAllMultipartUploads(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  pinnedBucket: readonly string[],
): void {
  for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch++) {
    const page = parseAwsResponse(
      multipartUploadPageSchema,
      run(access, [
        's3api',
        'list-multipart-uploads',
        ...pinnedBucket,
        '--max-uploads',
        String(UPLOADS_PER_BATCH),
        '--no-paginate',
      ]),
      'list-multipart-uploads',
    );

    const uploads = page.Uploads ?? [];

    if (uploads.length === 0) {
      if (page.IsTruncated) {
        throw new Error('Ambiguous multipart upload page');
      }

      return;
    }

    for (const upload of uploads) {
      run(access, [
        's3api',
        'abort-multipart-upload',
        ...pinnedBucket,
        '--key',
        upload.Key,
        '--upload-id',
        upload.UploadId,
      ]);
    }
  }

  throw new Error('Control multipart uploads exceed cleanup bound; repeat finalize-controls');
}
