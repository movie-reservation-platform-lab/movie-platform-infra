import {
  ARTIFACT_COPY_FAILURE_CODE,
  ArtifactCopyFailure,
} from '../src/artifact-copy-error';
import { copyAndVerifyArtifact, transferAndVerifyArtifact } from '../src/artifact-copy';
import {
  ARTIFACT_COPY_VERIFICATION_METHOD,
  ARTIFACT_TRANSFER_OPERATION,
  ARTIFACT_TRANSFER_OUTCOME,
  ARTIFACT_TRANSFER_VERIFICATION_METHOD,
  type ArtifactTransferRequest,
  type RegistryImageClient,
} from '../src/model';
import { CONFIG_DIGEST, LAYER_DIGEST_A, LAYER_DIGEST_B, createCopyFixture } from './test-support';

test('verifies source before copying and destination after copying', async () => {
  const fixture = createCopyFixture();
  const events: string[] = [];
  const client: RegistryImageClient = {
    readRawManifest: async ({ reference, authFile }) => {
      events.push(`read:${reference}:${authFile ?? 'anonymous'}`);
      return fixture.rawManifest;
    },
    copy: async ({ sourceReference, destinationReference }) => {
      events.push(`copy:${sourceReference}:${destinationReference}`);
    },
  };

  const result = await copyAndVerifyArtifact(fixture.request, client);

  expect(result).toEqual({
    verificationMethod: ARTIFACT_COPY_VERIFICATION_METHOD,
    sourceManifestDigest: fixture.digest,
    destinationManifestDigest: fixture.digest,
    configDigest: CONFIG_DIGEST,
    layerDigests: [LAYER_DIGEST_A, LAYER_DIGEST_B],
  });
  const destinationDigestReference =
    `${fixture.request.destinationRepository}@${fixture.digest}`;
  const destinationCopyReference =
    `${fixture.request.destinationRepository}:sha256-${fixture.digest.slice('sha256:'.length)}`;
  expect(events).toEqual([
    `read:${fixture.request.sourceReference}:anonymous`,
    `copy:${fixture.request.sourceReference}:${destinationCopyReference}`,
    `read:${destinationDigestReference}:${fixture.request.destinationAuthFile}`,
  ]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.layerDigests)).toBe(true);
});

test('passes separate source and destination auth files to the registry port', async () => {
  const fixture = createCopyFixture();
  const client: RegistryImageClient = {
    readRawManifest: jest.fn(async () => fixture.rawManifest),
    copy: jest.fn(async () => undefined),
  };
  const request = {
    ...fixture.request,
    sourceAuthFile: '/tmp/movie-platform/ghcr-auth.json',
  };

  await copyAndVerifyArtifact(request, client);

  expect(client.copy).toHaveBeenCalledWith({
    sourceReference: request.sourceReference,
    destinationReference:
      `${request.destinationRepository}:sha256-${request.expectedDigest.slice('sha256:'.length)}`,
    sourceAuthFile: request.sourceAuthFile,
    destinationAuthFile: request.destinationAuthFile,
  });
});

test('v2 copy-and-verify preserves source-read, copy, destination-read ordering', async () => {
  const fixture = createCopyFixture();
  const events: string[] = [];
  const client: RegistryImageClient = {
    readRawManifest: async ({ reference }) => {
      events.push(`read:${reference}`);
      return fixture.rawManifest;
    },
    copy: async ({ destinationReference }) => {
      events.push(`copy:${destinationReference}`);
    },
  };

  const result = await transferAndVerifyArtifact({
    ...fixture.request,
    operation: ARTIFACT_TRANSFER_OPERATION.COPY_AND_VERIFY,
  }, client);

  expect(result).toEqual({
    verificationMethod: ARTIFACT_TRANSFER_VERIFICATION_METHOD,
    outcome: ARTIFACT_TRANSFER_OUTCOME.COPIED,
    sourceManifestDigest: fixture.digest,
    destinationManifestDigest: fixture.digest,
    configDigest: CONFIG_DIGEST,
    layerDigests: [LAYER_DIGEST_A, LAYER_DIGEST_B],
  });
  expect(events).toEqual([
    `read:${fixture.request.sourceReference}`,
    `copy:${fixture.request.destinationRepository}:sha256-${fixture.digest.slice('sha256:'.length)}`,
    `read:${fixture.request.destinationRepository}@${fixture.digest}`,
  ]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.layerDigests)).toBe(true);
});

test('v2 verify-existing performs two reads and never invokes the mutating port', async () => {
  const fixture = createCopyFixture();
  const readRawManifest = jest.fn(async () => fixture.rawManifest);
  const copy = jest.fn(async () => undefined);
  const client: RegistryImageClient = { readRawManifest, copy };

  const result = await transferAndVerifyArtifact({
    ...fixture.request,
    operation: ARTIFACT_TRANSFER_OPERATION.VERIFY_EXISTING,
  }, client);

  expect(result).toEqual({
    verificationMethod: ARTIFACT_TRANSFER_VERIFICATION_METHOD,
    outcome: ARTIFACT_TRANSFER_OUTCOME.ALREADY_PRESENT,
    sourceManifestDigest: fixture.digest,
    destinationManifestDigest: fixture.digest,
    configDigest: CONFIG_DIGEST,
    layerDigests: [LAYER_DIGEST_A, LAYER_DIGEST_B],
  });
  expect(readRawManifest).toHaveBeenNthCalledWith(1, {
    reference: fixture.request.sourceReference,
    authFile: undefined,
  });
  expect(readRawManifest).toHaveBeenNthCalledWith(2, {
    reference: `${fixture.request.destinationRepository}@${fixture.digest}`,
    authFile: fixture.request.destinationAuthFile,
  });
  expect(copy).not.toHaveBeenCalled();
});

test('v2 verify-existing does not copy when destination verification fails', async () => {
  const fixture = createCopyFixture();
  let reads = 0;
  const copy = jest.fn(async () => undefined);
  const client: RegistryImageClient = {
    readRawManifest: async () => {
      reads += 1;
      if (reads === 2) {
        throw new Error('destination absent');
      }
      return fixture.rawManifest;
    },
    copy,
  };

  await expect(transferAndVerifyArtifact({
    ...fixture.request,
    operation: ARTIFACT_TRANSFER_OPERATION.VERIFY_EXISTING,
  }, client)).rejects.toMatchObject({
    code: ARTIFACT_COPY_FAILURE_CODE.DESTINATION_READ_FAILED,
  });
  expect(copy).not.toHaveBeenCalled();
});

test('v2 rejects an unknown operation before invoking the registry port', async () => {
  const fixture = createCopyFixture();
  const client: RegistryImageClient = {
    readRawManifest: jest.fn(async () => fixture.rawManifest),
    copy: jest.fn(async () => undefined),
  };
  const request = {
    ...fixture.request,
    operation: 'copy-if-needed',
  } as unknown as ArtifactTransferRequest;

  await expect(transferAndVerifyArtifact(request, client)).rejects.toEqual(
    new ArtifactCopyFailure(
      ARTIFACT_COPY_FAILURE_CODE.INVALID_INPUT,
      'operation must be copy-and-verify or verify-existing',
    ),
  );
  expect(client.readRawManifest).not.toHaveBeenCalled();
  expect(client.copy).not.toHaveBeenCalled();
});

test('rejects invalid source bytes before invoking the mutating port', async () => {
  const fixture = createCopyFixture();
  const copy = jest.fn(async () => undefined);
  const client: RegistryImageClient = {
    readRawManifest: async () => Buffer.from('{}'),
    copy,
  };

  await expect(copyAndVerifyArtifact(fixture.request, client)).rejects.toMatchObject({
    code: ARTIFACT_COPY_FAILURE_CODE.MANIFEST_DIGEST_MISMATCH,
  });
  expect(copy).not.toHaveBeenCalled();
});

test('does not read destination state after a failed copy', async () => {
  const fixture = createCopyFixture();
  const readRawManifest = jest.fn(async () => fixture.rawManifest);
  const client: RegistryImageClient = {
    readRawManifest,
    copy: async () => {
      throw new Error('private registry diagnostic');
    },
  };

  await expect(copyAndVerifyArtifact(fixture.request, client)).rejects.toEqual(
    new ArtifactCopyFailure(
      ARTIFACT_COPY_FAILURE_CODE.COPY_FAILED,
      'registry copy failed before destination verification',
    ),
  );
  expect(readRawManifest).toHaveBeenCalledTimes(1);
});

test.each([
  [
    'digest shape',
    { expectedDigest: `sha512:${'a'.repeat(64)}` },
    'expectedDigest must be a lowercase sha256 digest',
  ],
  [
    'missing source reference',
    { sourceReference: undefined as unknown as string },
    'sourceReference must be a fully qualified repository at expectedDigest',
  ],
  [
    'source tag',
    { sourceReference: 'ghcr.io/example/service:latest' },
    'sourceReference must be a fully qualified repository at expectedDigest',
  ],
  [
    'source digest disagreement',
    { sourceReference: `ghcr.io/example/service@sha256:${'f'.repeat(64)}` },
    'sourceReference must be a fully qualified repository at expectedDigest',
  ],
  [
    'short destination name',
    { destinationRepository: 'movie-reservation-service' },
    'destinationRepository must be a fully qualified untagged repository',
  ],
  [
    'tagged destination',
    { destinationRepository: 'registry.example.com/example/service:latest' },
    'destinationRepository must be a fully qualified untagged repository',
  ],
  [
    'relative destination auth path',
    { destinationAuthFile: 'ecr-auth.json' },
    'destinationAuthFile must be a normalized absolute path',
  ],
])('rejects invalid %s before invoking the registry client', async (_name, overrides, message) => {
  const fixture = createCopyFixture();
  const client: RegistryImageClient = {
    readRawManifest: jest.fn(async () => fixture.rawManifest),
    copy: jest.fn(async () => undefined),
  };

  await expect(
    copyAndVerifyArtifact({ ...fixture.request, ...overrides }, client),
  ).rejects.toEqual(
    new ArtifactCopyFailure(ARTIFACT_COPY_FAILURE_CODE.INVALID_INPUT, message),
  );
  expect(client.readRawManifest).not.toHaveBeenCalled();
  expect(client.copy).not.toHaveBeenCalled();
});

test.each([
  ['source', 1, ARTIFACT_COPY_FAILURE_CODE.SOURCE_READ_FAILED],
  ['destination', 2, ARTIFACT_COPY_FAILURE_CODE.DESTINATION_READ_FAILED],
] as const)('sanitizes a failed %s registry read', async (_location, failingRead, code) => {
  const fixture = createCopyFixture();
  let reads = 0;
  const client: RegistryImageClient = {
    readRawManifest: async () => {
      reads += 1;
      if (reads === failingRead) {
        throw new Error('private auth-file and registry diagnostic');
      }
      return fixture.rawManifest;
    },
    copy: async () => undefined,
  };

  const failure = await copyAndVerifyArtifact(fixture.request, client).catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ code });
  expect(String(failure)).not.toContain('private auth-file');
});
