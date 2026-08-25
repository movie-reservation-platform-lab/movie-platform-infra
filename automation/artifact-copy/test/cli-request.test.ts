import {
  ARTIFACT_COPY_CLI_REQUEST_VERSION,
  ArtifactCopyCliInputFailure,
  MAX_ARTIFACT_COPY_REQUEST_BYTES,
  parseArtifactCopyCliRequest,
} from '../src/cli-request';
import { createCopyFixture } from './test-support';

function validRequest(overrides: Readonly<Record<string, unknown>> = {}): Buffer {
  const fixture = createCopyFixture();
  return Buffer.from(JSON.stringify({
    requestVersion: ARTIFACT_COPY_CLI_REQUEST_VERSION,
    ...fixture.request,
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
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request.copyRequest)).toBe(true);
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
  ['unsupported request version', { requestVersion: 'artifact-copy-request-v2' }],
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

test('does not confuse braces or escaped quotes inside string values with JSON structure', () => {
  const request = parseArtifactCopyCliRequest(validRequest({
    sourceReference: 'ghcr.io/example/service-{quoted}@sha256:' + 'a'.repeat(64),
  }));

  expect(request.copyRequest.sourceReference).toContain('{quoted}');
});
