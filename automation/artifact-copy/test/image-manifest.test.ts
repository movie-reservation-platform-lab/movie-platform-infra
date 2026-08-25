import {
  ARTIFACT_COPY_FAILURE_CODE,
  ArtifactCopyFailure,
} from '../src/artifact-copy-error';
import {
  DOCKER_V2_IMAGE_MANIFEST_MEDIA_TYPE,
  assertEquivalentImageManifests,
  calculateSha256Digest,
  inspectRawImageManifest,
} from '../src/image-manifest';
import type { ImageManifestIdentity } from '../src/model';
import {
  CONFIG_DIGEST,
  LAYER_DIGEST_A,
  LAYER_DIGEST_B,
  createImageManifest,
} from './test-support';

test('hashes and reads an exact OCI single-image manifest', () => {
  const rawManifest = createImageManifest();
  const digest = calculateSha256Digest(rawManifest);

  expect(inspectRawImageManifest(rawManifest, digest, 'source')).toEqual({
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    manifestDigest: digest,
    configDigest: CONFIG_DIGEST,
    layerDigests: [LAYER_DIGEST_A, LAYER_DIGEST_B],
  });
});

test('accepts a Docker v2 single-image manifest without converting it', () => {
  const rawManifest = createImageManifest({
    mediaType: DOCKER_V2_IMAGE_MANIFEST_MEDIA_TYPE,
    config: {
      mediaType: 'application/vnd.docker.container.image.v1+json',
      digest: CONFIG_DIGEST,
      size: 321,
    },
    layers: [
      {
        mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
        digest: LAYER_DIGEST_A,
        size: 1_024,
      },
    ],
  });
  const digest = calculateSha256Digest(rawManifest);

  expect(inspectRawImageManifest(rawManifest, digest, 'source')).toMatchObject({
    mediaType: DOCKER_V2_IMAGE_MANIFEST_MEDIA_TYPE,
    configDigest: CONFIG_DIGEST,
    layerDigests: [LAYER_DIGEST_A],
  });
});

test.each([
  ['OCI index', 'application/vnd.oci.image.index.v1+json'],
  ['Docker manifest list', 'application/vnd.docker.distribution.manifest.list.v2+json'],
  ['Docker schema 1', 'application/vnd.docker.distribution.manifest.v1+json'],
])('rejects an unsupported %s before any copy can run', (_name, mediaType) => {
  const rawManifest = createImageManifest({ mediaType });

  expect(() =>
    inspectRawImageManifest(rawManifest, calculateSha256Digest(rawManifest), 'source'),
  ).toThrow(expect.objectContaining({
    code: ARTIFACT_COPY_FAILURE_CODE.MANIFEST_INVALID,
    message: 'source mediaType is not a supported single-image manifest',
  }));
});

test.each([
  ['JSON', Buffer.from('{'), 'manifest is not valid JSON'],
  [
    'UTF-8 JSON',
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    'manifest is not valid UTF-8',
  ],
  [
    'schema version',
    createImageManifest({ schemaVersion: 1 }),
    'schemaVersion must equal 2',
  ],
  [
    'config descriptor',
    createImageManifest({ config: null }),
    'config must be a descriptor object',
  ],
  [
    'layers collection',
    createImageManifest({ layers: null }),
    'layers must be an array',
  ],
  [
    'layer digest',
    createImageManifest({
      layers: [{ mediaType: 'application/test', digest: `sha256:${'A'.repeat(64)}`, size: 1 }],
    }),
    'layers[0].digest must be a lowercase sha256 digest',
  ],
  [
    'descriptor size',
    createImageManifest({
      config: { mediaType: 'application/test', digest: CONFIG_DIGEST, size: -1 },
    }),
    'config.size must be a non-negative integer',
  ],
])('rejects malformed %s with a sanitized reason', (_name, rawManifest, reason) => {
  expect(() =>
    inspectRawImageManifest(rawManifest, calculateSha256Digest(rawManifest), 'source'),
  ).toThrow(expect.objectContaining({
    code: ARTIFACT_COPY_FAILURE_CODE.MANIFEST_INVALID,
    message: `source ${reason}`,
  }));
});

test('hashes exact raw bytes rather than normalized JSON', () => {
  const compact = createImageManifest();
  const reformatted = Buffer.from(
    JSON.stringify(JSON.parse(compact.toString('utf8')) as unknown, undefined, 2),
  );

  expect(() =>
    inspectRawImageManifest(reformatted, calculateSha256Digest(compact), 'destination'),
  ).toThrow(expect.objectContaining({
    code: ARTIFACT_COPY_FAILURE_CODE.MANIFEST_DIGEST_MISMATCH,
    message: 'destination manifest bytes do not match the expected digest',
  }));
});

test.each([
  ['top-level manifest digest', { manifestDigest: `sha256:${'d'.repeat(64)}` }],
  ['config digest', { configDigest: `sha256:${'d'.repeat(64)}` }],
  ['ordered layer digests', { layerDigests: [LAYER_DIGEST_B, LAYER_DIGEST_A] }],
])('rejects destination %s drift explicitly', (field, overrides) => {
  const source: ImageManifestIdentity = {
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    manifestDigest: `sha256:${'e'.repeat(64)}`,
    configDigest: CONFIG_DIGEST,
    layerDigests: [LAYER_DIGEST_A, LAYER_DIGEST_B],
  };
  const destination: ImageManifestIdentity = { ...source, ...overrides };

  expect(() => assertEquivalentImageManifests(source, destination)).toThrow(
    expect.objectContaining({
      code: ARTIFACT_COPY_FAILURE_CODE.CONTENT_MISMATCH,
      message: `destination ${field} does not match the source`,
    }),
  );
});

test('uses the dedicated failure type for manifest rejection', () => {
  const rawManifest = Buffer.from('null');

  expect(() =>
    inspectRawImageManifest(rawManifest, calculateSha256Digest(rawManifest), 'source'),
  ).toThrow(ArtifactCopyFailure);
});
