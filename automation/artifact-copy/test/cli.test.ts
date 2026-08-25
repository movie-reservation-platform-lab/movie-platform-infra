import { copyAndVerifyArtifact } from '../src/artifact-copy';
import {
  ARTIFACT_COPY_CLI_EXIT_CODE,
  ARTIFACT_COPY_CLI_FAILURE,
  runCli,
  type ArtifactCopyCliDependencies,
} from '../src/cli';
import { ARTIFACT_COPY_CLI_REQUEST_VERSION } from '../src/cli-request';
import {
  ARTIFACT_COPY_VERIFICATION_METHOD,
  type ArtifactCopyVerification,
  type RegistryImageClient,
} from '../src/model';
import { createSkopeoRegistryClient } from '../src/skopeo-client';
import {
  CONFIG_DIGEST,
  LAYER_DIGEST_A,
  LAYER_DIGEST_B,
  createCopyFixture,
} from './test-support';

const REQUEST_FILE = '/tmp/movie-platform/artifact-copy-request.json';
const SKOPEO_EXECUTABLE = '/usr/bin/skopeo';
const EXECUTION_ARGUMENTS = [
  '--request-file',
  REQUEST_FILE,
  '--skopeo-executable',
  SKOPEO_EXECUTABLE,
] as const;

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function requestDocument(overrides: Readonly<Record<string, unknown>> = {}): Buffer {
  const fixture = createCopyFixture();
  return Buffer.from(JSON.stringify({
    requestVersion: ARTIFACT_COPY_CLI_REQUEST_VERSION,
    ...fixture.request,
    ...overrides,
  }));
}

async function run(
  arguments_: readonly string[],
  dependencies: ArtifactCopyCliDependencies,
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const status = await runCli(
    arguments_,
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    dependencies,
  );
  return { status, stdout, stderr };
}

function successfulVerification(): ArtifactCopyVerification {
  const fixture = createCopyFixture();
  return Object.freeze({
    verificationMethod: ARTIFACT_COPY_VERIFICATION_METHOD,
    sourceManifestDigest: fixture.digest,
    destinationManifestDigest: fixture.digest,
    configDigest: CONFIG_DIGEST,
    layerDigests: Object.freeze([LAYER_DIGEST_A, LAYER_DIGEST_B]),
  });
}

function successfulDependencies(
  events: string[] = [],
  rawRequest: Buffer = requestDocument(),
): ArtifactCopyCliDependencies {
  const client: RegistryImageClient = {
    readRawManifest: async () => Buffer.alloc(0),
    copy: async () => undefined,
  };
  return {
    readRequestFile: (requestFilePath) => {
      events.push(`read:${requestFilePath}`);
      return rawRequest;
    },
    createRegistryClient: (trustedSkopeoExecutable) => {
      events.push(`client:${trustedSkopeoExecutable}`);
      return client;
    },
    copyArtifact: async (request, receivedClient) => {
      events.push(`copy:${request.sourceReference}:${request.destinationRepository}`);
      expect(receivedClient).toBe(client);
      return successfulVerification();
    },
  };
}

test.each([['--help'], ['-h']])('prints help without reading a request for %s', async (argument) => {
  const successful = successfulDependencies();
  const dependencies: ArtifactCopyCliDependencies = {
    readRequestFile: jest.fn(successful.readRequestFile),
    createRegistryClient: jest.fn(successful.createRegistryClient),
    copyArtifact: jest.fn(successful.copyArtifact),
  };

  const result = await run([argument], dependencies);

  expect(result.status).toBe(ARTIFACT_COPY_CLI_EXIT_CODE.SUCCESS);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('artifact-copy-request-v1');
  expect(result.stdout).toContain('credentials remain in referenced auth files');
  expect(result.stdout).toContain('Destination policy is owned by the caller');
  expect(dependencies.readRequestFile).not.toHaveBeenCalled();
  expect(dependencies.createRegistryClient).not.toHaveBeenCalled();
  expect(dependencies.copyArtifact).not.toHaveBeenCalled();
});

test('emits only the existing sanitized immutable verification result as JSON', async () => {
  const events: string[] = [];
  const fixture = createCopyFixture();

  const result = await run(
    EXECUTION_ARGUMENTS,
    successfulDependencies(events, requestDocument({
      sourceAuthFile: '/tmp/movie-platform/ghcr-auth.json',
    })),
  );

  expect(result.status).toBe(ARTIFACT_COPY_CLI_EXIT_CODE.SUCCESS);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual(successfulVerification());
  expect(result.stdout).not.toContain('/tmp/movie-platform');
  expect(result.stdout).not.toContain('111111111111');
  expect(result.stdout).not.toContain('ghcr.io');
  expect(events).toEqual([
    `read:${REQUEST_FILE}`,
    `client:${SKOPEO_EXECUTABLE}`,
    `copy:${fixture.request.sourceReference}:${fixture.request.destinationRepository}`,
  ]);
});

test.each([
  ['missing request file option', [], undefined],
  ['missing trusted executable option', ['--request-file', REQUEST_FILE], undefined],
  [
    'relative request file',
    ['--request-file', 'request.json', '--skopeo-executable', SKOPEO_EXECUTABLE],
    undefined,
  ],
  ['unknown option', ['--token', 'inline-secret'], undefined],
  [
    'malformed request JSON',
    EXECUTION_ARGUMENTS,
    Buffer.from('{"destinationAuthFile":"/private/auth.json"'),
  ],
  [
    'unknown inline credential',
    EXECUTION_ARGUMENTS,
    requestDocument({ token: 'inline-secret' }),
  ],
  [
    'malformed digest',
    EXECUTION_ARGUMENTS,
    requestDocument({ expectedDigest: `sha512:${'a'.repeat(64)}` }),
  ],
  [
    'tagged source selector',
    EXECUTION_ARGUMENTS,
    requestDocument({ sourceReference: 'ghcr.io/example/service:latest' }),
  ],
])('returns stable invalid-input status for %s', async (_name, arguments_, rawRequest) => {
  const successful = successfulDependencies([], rawRequest);
  const dependencies: ArtifactCopyCliDependencies = {
    ...successful,
    copyArtifact: copyAndVerifyArtifact,
  };

  const result = await run(arguments_, dependencies);

  expect(result).toEqual({
    status: ARTIFACT_COPY_CLI_EXIT_CODE.INVALID_INPUT,
    stdout: '',
    stderr: `Artifact copy failed: ${ARTIFACT_COPY_CLI_FAILURE.INVALID_INPUT}\n`,
  });
  expect(result.stderr).not.toContain('inline-secret');
  expect(result.stderr).not.toContain('/private/auth.json');
});

test('classifies invalid Skopeo selection without exposing the executable path', async () => {
  const dependencies: ArtifactCopyCliDependencies = {
    ...successfulDependencies(),
    createRegistryClient: (executablePath) =>
      createSkopeoRegistryClient({ executablePath }),
  };

  const result = await run([
    '--request-file',
    REQUEST_FILE,
    '--skopeo-executable',
    'relative/untrusted-skopeo',
  ], dependencies);

  expect(result).toEqual({
    status: ARTIFACT_COPY_CLI_EXIT_CODE.INVALID_INPUT,
    stdout: '',
    stderr: `Artifact copy failed: ${ARTIFACT_COPY_CLI_FAILURE.INVALID_INPUT}\n`,
  });
  expect(result.stderr).not.toContain('relative/untrusted-skopeo');
});

test('returns stable source-rejection status and never copies an invalid source', async () => {
  const fixture = createCopyFixture();
  const copy = jest.fn(async () => undefined);
  const client: RegistryImageClient = {
    readRawManifest: async () => Buffer.from('{}'),
    copy,
  };
  const dependencies: ArtifactCopyCliDependencies = {
    ...successfulDependencies(),
    createRegistryClient: () => client,
    copyArtifact: copyAndVerifyArtifact,
  };

  const result = await run(EXECUTION_ARGUMENTS, dependencies);

  expect(result).toEqual({
    status: ARTIFACT_COPY_CLI_EXIT_CODE.SOURCE_REJECTED,
    stdout: '',
    stderr: `Artifact copy failed: ${ARTIFACT_COPY_CLI_FAILURE.SOURCE_REJECTED}\n`,
  });
  expect(copy).not.toHaveBeenCalled();
  expect(fixture.rawManifest).not.toEqual(Buffer.from('{}'));
});

test('returns stable copy-failure status without destination inspection', async () => {
  const fixture = createCopyFixture();
  const readRawManifest = jest.fn(async () => fixture.rawManifest);
  const dependencies: ArtifactCopyCliDependencies = {
    ...successfulDependencies(),
    createRegistryClient: () => ({
      readRawManifest,
      copy: async () => {
        throw new Error('private registry response');
      },
    }),
    copyArtifact: copyAndVerifyArtifact,
  };

  const result = await run(EXECUTION_ARGUMENTS, dependencies);

  expect(result).toEqual({
    status: ARTIFACT_COPY_CLI_EXIT_CODE.COPY_FAILED,
    stdout: '',
    stderr: `Artifact copy failed: ${ARTIFACT_COPY_CLI_FAILURE.COPY_FAILED}\n`,
  });
  expect(readRawManifest).toHaveBeenCalledTimes(1);
  expect(result.stderr).not.toContain('private registry response');
});

test('returns stable destination-verification status after copied content drifts', async () => {
  const fixture = createCopyFixture();
  let reads = 0;
  const dependencies: ArtifactCopyCliDependencies = {
    ...successfulDependencies(),
    createRegistryClient: () => ({
      readRawManifest: async () => {
        reads += 1;
        return reads === 1 ? fixture.rawManifest : Buffer.from('{}');
      },
      copy: async () => undefined,
    }),
    copyArtifact: copyAndVerifyArtifact,
  };

  const result = await run(EXECUTION_ARGUMENTS, dependencies);

  expect(result).toEqual({
    status: ARTIFACT_COPY_CLI_EXIT_CODE.DESTINATION_VERIFICATION_FAILED,
    stdout: '',
    stderr:
      `Artifact copy failed: ${ARTIFACT_COPY_CLI_FAILURE.DESTINATION_VERIFICATION_FAILED}\n`,
  });
  expect(reads).toBe(2);
});

test('sanitizes unexpected failures under a distinct internal-error classification', async () => {
  const dependencies: ArtifactCopyCliDependencies = {
    ...successfulDependencies(),
    copyArtifact: async () => {
      throw new Error('private internal diagnostic');
    },
  };

  const result = await run(EXECUTION_ARGUMENTS, dependencies);

  expect(result).toEqual({
    status: ARTIFACT_COPY_CLI_EXIT_CODE.INTERNAL_ERROR,
    stdout: '',
    stderr: `Artifact copy failed: ${ARTIFACT_COPY_CLI_FAILURE.INTERNAL_ERROR}\n`,
  });
  expect(result.stderr).not.toContain('private internal diagnostic');
});
