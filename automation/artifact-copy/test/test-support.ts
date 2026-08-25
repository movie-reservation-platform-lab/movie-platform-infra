import {
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  calculateSha256Digest,
} from '../src/image-manifest';
import type { ArtifactCopyRequest } from '../src/model';

export const CONFIG_DIGEST = `sha256:${'a'.repeat(64)}`;
export const LAYER_DIGEST_A = `sha256:${'b'.repeat(64)}`;
export const LAYER_DIGEST_B = `sha256:${'c'.repeat(64)}`;

export function createImageManifest(
  overrides: Readonly<Record<string, unknown>> = {},
): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: CONFIG_DIGEST,
      size: 321,
    },
    layers: [
      {
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        digest: LAYER_DIGEST_A,
        size: 1_024,
      },
      {
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        digest: LAYER_DIGEST_B,
        size: 2_048,
      },
    ],
    ...overrides,
  }));
}

export function createCopyFixture(rawManifest: Buffer = createImageManifest()): {
  readonly rawManifest: Buffer;
  readonly digest: string;
  readonly request: ArtifactCopyRequest;
} {
  const digest = calculateSha256Digest(rawManifest);
  return Object.freeze({
    rawManifest,
    digest,
    request: Object.freeze({
      sourceReference:
        `ghcr.io/movie-reservation-platform-lab/movie-reservation-service@${digest}`,
      destinationRepository:
        '111111111111.dkr.ecr.eu-central-1.amazonaws.com/movie-reservation-service',
      expectedDigest: digest,
      destinationAuthFile: '/tmp/movie-platform/ecr-auth.json',
    }),
  });
}
