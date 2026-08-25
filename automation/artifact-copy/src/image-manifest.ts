import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  ARTIFACT_COPY_FAILURE_CODE,
  ARTIFACT_COPY_FAILURE_STAGE,
  failArtifactCopy,
} from './artifact-copy-error';
import type { ImageManifestIdentity } from './model';

export const OCI_IMAGE_MANIFEST_MEDIA_TYPE =
  'application/vnd.oci.image.manifest.v1+json';
export const DOCKER_V2_IMAGE_MANIFEST_MEDIA_TYPE =
  'application/vnd.docker.distribution.manifest.v2+json';

const SUPPORTED_IMAGE_MANIFEST_MEDIA_TYPES = new Set([
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  DOCKER_V2_IMAGE_MANIFEST_MEDIA_TYPE,
]);
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DESCRIPTOR_MEDIA_TYPE_PATTERN = /^application\/[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

type ManifestLocation = 'source' | 'destination';

interface JsonObject {
  readonly [key: string]: unknown;
}

export function calculateSha256Digest(rawManifest: Buffer): string {
  return `sha256:${createHash('sha256').update(rawManifest).digest('hex')}`;
}

/** Hash and parse one exact OCI or Docker v2 single-image manifest. */
export function inspectRawImageManifest(
  rawManifest: Buffer,
  expectedDigest: string,
  location: ManifestLocation,
): ImageManifestIdentity {
  const actualDigest = calculateSha256Digest(rawManifest);
  if (actualDigest !== expectedDigest) {
    failArtifactCopy(
      ARTIFACT_COPY_FAILURE_CODE.MANIFEST_DIGEST_MISMATCH,
      `${location} manifest bytes do not match the expected digest`,
      location === 'source'
        ? ARTIFACT_COPY_FAILURE_STAGE.SOURCE
        : ARTIFACT_COPY_FAILURE_STAGE.DESTINATION,
    );
  }

  let manifestText: string;
  try {
    manifestText = UTF8_DECODER.decode(rawManifest);
  } catch {
    failInvalidManifest(location, 'manifest is not valid UTF-8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText) as unknown;
  } catch {
    failInvalidManifest(location, 'manifest is not valid JSON');
  }

  if (!isJsonObject(parsed)) {
    failInvalidManifest(location, 'manifest must be a JSON object');
  }
  if (parsed.schemaVersion !== 2) {
    failInvalidManifest(location, 'schemaVersion must equal 2');
  }
  if (
    typeof parsed.mediaType !== 'string' ||
    !SUPPORTED_IMAGE_MANIFEST_MEDIA_TYPES.has(parsed.mediaType)
  ) {
    failInvalidManifest(location, 'mediaType is not a supported single-image manifest');
  }

  const configDigest = readDescriptorDigest(parsed.config, location, 'config');
  if (!Array.isArray(parsed.layers)) {
    failInvalidManifest(location, 'layers must be an array');
  }
  const layerDigests = parsed.layers.map((layer, index) =>
    readDescriptorDigest(layer, location, `layers[${index}]`),
  );

  return Object.freeze({
    mediaType: parsed.mediaType,
    manifestDigest: actualDigest,
    configDigest,
    layerDigests: Object.freeze(layerDigests),
  });
}

/** Explicitly compare the content graph fields required by the admission contract. */
export function assertEquivalentImageManifests(
  source: ImageManifestIdentity,
  destination: ImageManifestIdentity,
): void {
  if (source.manifestDigest !== destination.manifestDigest) {
    failContentMismatch('top-level manifest digest');
  }
  if (source.configDigest !== destination.configDigest) {
    failContentMismatch('config digest');
  }
  if (
    source.layerDigests.length !== destination.layerDigests.length ||
    source.layerDigests.some(
      (digest, index) => digest !== destination.layerDigests[index],
    )
  ) {
    failContentMismatch('ordered layer digests');
  }
}

function readDescriptorDigest(
  value: unknown,
  location: ManifestLocation,
  fieldName: string,
): string {
  if (!isJsonObject(value)) {
    failInvalidManifest(location, `${fieldName} must be a descriptor object`);
  }
  if (
    typeof value.mediaType !== 'string' ||
    !DESCRIPTOR_MEDIA_TYPE_PATTERN.test(value.mediaType)
  ) {
    failInvalidManifest(location, `${fieldName}.mediaType is invalid`);
  }
  if (typeof value.digest !== 'string' || !SHA256_DIGEST_PATTERN.test(value.digest)) {
    failInvalidManifest(location, `${fieldName}.digest must be a lowercase sha256 digest`);
  }
  if (
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  ) {
    failInvalidManifest(location, `${fieldName}.size must be a non-negative integer`);
  }
  return value.digest;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failInvalidManifest(location: ManifestLocation, detail: string): never {
  failArtifactCopy(
    ARTIFACT_COPY_FAILURE_CODE.MANIFEST_INVALID,
    `${location} ${detail}`,
    location === 'source'
      ? ARTIFACT_COPY_FAILURE_STAGE.SOURCE
      : ARTIFACT_COPY_FAILURE_STAGE.DESTINATION,
  );
}

function failContentMismatch(field: string): never {
  failArtifactCopy(
    ARTIFACT_COPY_FAILURE_CODE.CONTENT_MISMATCH,
    `destination ${field} does not match the source`,
    ARTIFACT_COPY_FAILURE_STAGE.DESTINATION,
  );
}
