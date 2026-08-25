import {
  ARTIFACT_COPY_CLI_REQUEST_VERSION,
  ARTIFACT_COPY_CLI_REQUEST_VERSION_V2,
  ArtifactCopyCliInputFailure,
  MAX_ARTIFACT_COPY_REQUEST_BYTES,
  parseArtifactCopyCliRequest,
} from '../src/cli-request';
import { ARTIFACT_TRANSFER_OPERATION } from '../src/model';
import { createCopyFixture } from './test-support';

function validRequest(overrides: Readonly<Record<string, unknown>> = {}): Buffer {
  const fixture = createCopyFixture();
  return Buffer.from(JSON.stringify({
    requestVersion: ARTIFACT_COPY_CLI_REQUEST_VERSION,
    ...fixture.request,
    ...overrides,
  }));
}

function validV2Request(overrides: Readonly<Record<string, unknown>> = {}): Buffer {
  const fixture = createCopyFixture();
  return Buffer.from(JSON.stringify({
    requestVersion: ARTIFACT_COPY_CLI_REQUEST_VERSION_V2,
    ...fixture.request,
    operation: ARTIFACT_TRANSFER_OPERATION.VERIFY_EXISTING,
    ...overrides,
  }));
}

test('parses the exact versioned transport fields into the library request', () => {
  const fixture = createCopyFixture();

  const request = parseArtifactCopyCliRequest(validRequest({
    sourceAuthFile: '/tmp/movie-platform/ghcr-auth.json',
  }));

  expect(request).toEqual({
    requestVersion: ARTIFACT_COPY_CLI_REQUEST_VERSION,
    copyRequest: {
      ...fixture.request,
      sourceAuthFile: '/tmp/movie-platform/ghcr-auth.json',
    },
  });
  expect(request.requestVersion).toBe(ARTIFACT_COPY_CLI_REQUEST_VERSION);
  if (request.requestVersion !== ARTIFACT_COPY_CLI_REQUEST_VERSION) {
    throw new Error('expected v1 request');
  }
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request.copyRequest)).toBe(true);
});

test.each([
  ARTIFACT_TRANSFER_OPERATION.COPY_AND_VERIFY,
  ARTIFACT_TRANSFER_OPERATION.VERIFY_EXISTING,
])('parses the exact v2 transport for %s', (operation) => {
  const fixture = createCopyFixture();

  const request = parseArtifactCopyCliRequest(validV2Request({ operation }));

  expect(request).toEqual({
    requestVersion: ARTIFACT_COPY_CLI_REQUEST_VERSION_V2,
    transferRequest: {
      ...fixture.request,
      operation,
    },
  });
  expect(Object.isFrozen(request)).toBe(true);
  expect(
    request.requestVersion === ARTIFACT_COPY_CLI_REQUEST_VERSION_V2 &&
    Object.isFrozen(request.transferRequest),
  ).toBe(true);
});

test.each([
  ['empty input', Buffer.alloc(0)],
  ['malformed JSON', Buffer.from('{')],
  ['non-object JSON', Buffer.from('[]')],
  ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
  [
    'oversized input',
    Buffer.alloc(MAX_ARTIFACT_COPY_REQUEST_BYTES + 1, ' '),
  ],
])('rejects %s', (_name, rawRequest) => {
  expect(() => parseArtifactCopyCliRequest(rawRequest)).toThrow(
    ArtifactCopyCliInputFailure,
  );
});

test.each([
  [
    'literal duplicate key',
    '{"requestVersion":"artifact-copy-request-v1","requestVersion":"artifact-copy-request-v1"}',
  ],
  [
    'escape-equivalent duplicate key',
    '{"requestVersion":"artifact-copy-request-v1","request\\u0056ersion":"artifact-copy-request-v1"}',
  ],
  [
    'nested duplicate key',
    '{"requestVersion":"artifact-copy-request-v1","extra":{"token":"a","token":"b"}}',
  ],
])('rejects a %s before JSON.parse can retain the last value', (_name, json) => {
  expect(() => parseArtifactCopyCliRequest(Buffer.from(json))).toThrow(
    ArtifactCopyCliInputFailure,
  );
});

test.each([
  ['unknown field', { token: 'inline-secret' }],
  ['unsupported request version', { requestVersion: 'artifact-copy-request-v3' }],
  ['missing required field', { destinationAuthFile: undefined }],
  ['non-string required field', { expectedDigest: 123 }],
  ['empty required field', { destinationAuthFile: '' }],
  ['inline credential field', { password: 'inline-secret' }],
  ['untrusted executable selection', { skopeoExecutablePath: '/tmp/attacker/skopeo' }],
  ['null optional auth file', { sourceAuthFile: null }],
])('rejects %s', (_name, overrides) => {
  expect(() => parseArtifactCopyCliRequest(validRequest(overrides))).toThrow(
    ArtifactCopyCliInputFailure,
  );
});

test('preserves the closed v1 contract by rejecting the v2 operation field', () => {
  expect(() => parseArtifactCopyCliRequest(validRequest({
    operation: ARTIFACT_TRANSFER_OPERATION.VERIFY_EXISTING,
  }))).toThrow(ArtifactCopyCliInputFailure);
});

test.each([
  ['missing operation', { operation: undefined }],
  ['unknown operation', { operation: 'copy-if-needed' }],
  ['non-string operation', { operation: 1 }],
  ['unknown v2 field', { accountId: '111111111111' }],
  ['inline v2 credential', { token: 'inline-secret' }],
])('rejects v2 with %s', (_name, overrides) => {
  expect(() => parseArtifactCopyCliRequest(validV2Request(overrides))).toThrow(
    ArtifactCopyCliInputFailure,
  );
});

test('does not confuse braces or escaped quotes inside string values with JSON structure', () => {
  const request = parseArtifactCopyCliRequest(validRequest({
    sourceReference: 'ghcr.io/example/service-{quoted}@sha256:' + 'a'.repeat(64),
  }));

  expect(request.requestVersion).toBe(ARTIFACT_COPY_CLI_REQUEST_VERSION);
  if (request.requestVersion !== ARTIFACT_COPY_CLI_REQUEST_VERSION) {
    throw new Error('expected v1 request');
  }
  expect(request.copyRequest.sourceReference).toContain('{quoted}');
});
