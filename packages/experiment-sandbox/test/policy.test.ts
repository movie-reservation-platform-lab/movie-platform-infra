import { admissionBlockers, isDigestImageReference, parseSandboxRecord } from '../src';

test('immutable registry image accepts digest and rejects tags', () => {
  expect(
    isDigestImageReference(
      `111111111111.dkr.ecr.eu-central-1.amazonaws.com/recommendation@sha256:${'a'.repeat(64)}`,
    ),
  ).toBe(true);

  expect(isDigestImageReference('repository:latest')).toBe(false);
});

test('runtime record rejects unknown credential keys before trusting TypeScript types', () => {
  expect(() => parseSandboxRecord({ version: 1, credentials: 'secret' })).toThrow(/unknown/);
});

test('malformed records are rejected and produce admission blockers', () => {
  // A partial untrusted record must never be mistaken for a complete approved record.
  expect(() => parseSandboxRecord({ version: 1 })).toThrow();
  expect(admissionBlockers({} as never, new Date()).length).toBeGreaterThan(0);
});
