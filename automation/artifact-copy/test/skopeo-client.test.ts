import {
  ARTIFACT_COPY_FAILURE_CODE,
  ArtifactCopyFailure,
} from '../src/artifact-copy-error';
import {
  createSkopeoRegistryClient,
  type ProcessInvocation,
  type ProcessResult,
} from '../src/skopeo-client';

const SOURCE = `ghcr.io/example/service@sha256:${'a'.repeat(64)}`;
const DESTINATION_DIGEST =
  `111111111111.dkr.ecr.eu-central-1.amazonaws.com/service@sha256:${'a'.repeat(64)}`;
const DESTINATION_TAG =
  `111111111111.dkr.ecr.eu-central-1.amazonaws.com/service:sha256-${'a'.repeat(64)}`;
const RAW_MANIFEST = Buffer.from('{"schemaVersion":2}');
const SKOPEO_EXECUTABLE = '/usr/bin/skopeo';

function success(stdout: Buffer = Buffer.alloc(0)): ProcessResult {
  return { status: 0, stdout, stderr: Buffer.alloc(0) };
}

test('reads public manifest bytes anonymously without text conversion', async () => {
  const invocations: ProcessInvocation[] = [];
  const client = createSkopeoRegistryClient({ executablePath: SKOPEO_EXECUTABLE }, (invocation) => {
    invocations.push(invocation);
    return success(RAW_MANIFEST);
  });

  await expect(client.readRawManifest({ reference: SOURCE })).resolves.toEqual(RAW_MANIFEST);
  expect(invocations).toEqual([
    {
      executable: SKOPEO_EXECUTABLE,
      arguments: [
        'inspect',
        '--raw',
        '--tls-verify=true',
        '--no-creds',
        `docker://${SOURCE}`,
      ],
      timeoutMilliseconds: 30_000,
      maxOutputBytes: 4 * 1024 * 1024,
      shell: false,
    },
  ]);
});

test('uses an explicit auth file for a private manifest read', async () => {
  const invocations: ProcessInvocation[] = [];
  const runner = (invocation: ProcessInvocation) => {
    invocations.push(invocation);
    return success(RAW_MANIFEST);
  };
  const client = createSkopeoRegistryClient({ executablePath: SKOPEO_EXECUTABLE }, runner);

  await client.readRawManifest({
    reference: DESTINATION_DIGEST,
    authFile: '/tmp/movie-platform/ecr-auth.json',
  });

  expect(invocations[0]?.arguments).toEqual([
    'inspect',
    '--raw',
    '--tls-verify=true',
    '--authfile',
    '/tmp/movie-platform/ecr-auth.json',
    `docker://${DESTINATION_DIGEST}`,
  ]);
});

test('copies a digest to its retention tag with preservation, TLS, and separate auth', async () => {
  const invocations: ProcessInvocation[] = [];
  const runner = (invocation: ProcessInvocation) => {
    invocations.push(invocation);
    return success();
  };
  const client = createSkopeoRegistryClient({ executablePath: SKOPEO_EXECUTABLE }, runner);

  await client.copy({
    sourceReference: SOURCE,
    destinationReference: DESTINATION_TAG,
    sourceAuthFile: '/tmp/movie-platform/ghcr-auth.json',
    destinationAuthFile: '/tmp/movie-platform/ecr-auth.json',
  });

  expect(invocations).toEqual([{
    executable: SKOPEO_EXECUTABLE,
    arguments: [
      'copy',
      '--quiet',
      '--preserve-digests',
      '--src-tls-verify=true',
      '--dest-tls-verify=true',
      '--src-authfile',
      '/tmp/movie-platform/ghcr-auth.json',
      '--dest-authfile',
      '/tmp/movie-platform/ecr-auth.json',
      `docker://${SOURCE}`,
      `docker://${DESTINATION_TAG}`,
    ],
    timeoutMilliseconds: 5 * 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
    shell: false,
  }]);
});

test('forces anonymous source access when no source auth file is supplied', async () => {
  const invocations: ProcessInvocation[] = [];
  const runner = (invocation: ProcessInvocation) => {
    invocations.push(invocation);
    return success();
  };
  const client = createSkopeoRegistryClient({ executablePath: SKOPEO_EXECUTABLE }, runner);

  await client.copy({
    sourceReference: SOURCE,
    destinationReference: DESTINATION_TAG,
    destinationAuthFile: '/tmp/movie-platform/ecr-auth.json',
  });

  expect(invocations[0]?.arguments).toContain('--src-no-creds');
  expect(invocations[0]?.arguments).not.toContain('--src-authfile');
});

test.each([
  ['non-zero exit', { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('secret') }],
  [
    'process error',
    {
      status: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('secret'),
      error: new Error('spawn secret'),
    },
  ],
] as const)('sanitizes a Skopeo %s', async (_name, result) => {
  const client = createSkopeoRegistryClient(
    { executablePath: SKOPEO_EXECUTABLE },
    () => result,
  );

  await expect(client.readRawManifest({ reference: SOURCE })).rejects.toEqual(
    new ArtifactCopyFailure(
      ARTIFACT_COPY_FAILURE_CODE.TOOL_FAILED,
      'skopeo inspect failed',
    ),
  );
});

test('rejects an empty successful inspect result', async () => {
  const client = createSkopeoRegistryClient(
    { executablePath: SKOPEO_EXECUTABLE },
    () => success(),
  );

  await expect(client.readRawManifest({ reference: SOURCE })).rejects.toEqual(
    new ArtifactCopyFailure(
      ARTIFACT_COPY_FAILURE_CODE.TOOL_FAILED,
      'skopeo inspect returned no manifest bytes',
    ),
  );
});

test('rejects PATH-based or ambiguous executable selection', () => {
  expect(() => createSkopeoRegistryClient({ executablePath: 'skopeo' })).toThrow(
    new ArtifactCopyFailure(
      ARTIFACT_COPY_FAILURE_CODE.TOOL_FAILED,
      'skopeo executable path must be a normalized absolute path',
    ),
  );
});
