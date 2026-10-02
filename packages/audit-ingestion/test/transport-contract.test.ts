import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUDIT_EVENTBRIDGE_DETAIL_TYPE,
  AUDIT_EVENTBRIDGE_ENVELOPE_VERSION,
  AUDIT_EVENTBRIDGE_SOURCES,
} from '../src';

interface TransportProvenance {
  readonly artifact_sha256: Readonly<Record<string, string>>;
  readonly eventbridge: {
    readonly detail_type: string;
    readonly envelope_version: string;
    readonly sources: readonly string[];
  };
  readonly source_revision: string;
}

test('pins routing values to the reviewed audit SDK revision', () => {
  const provenance = JSON.parse(
    readFileSync(join(__dirname, '..', 'contract', 'provenance.json'), 'utf8'),
  ) as TransportProvenance;

  for (const [relativePath, expectedHash] of Object.entries(
    provenance.artifact_sha256,
  )) {
    const contents = readFileSync(
      join(__dirname, '..', 'contract', 'bundle', relativePath),
    );
    expect(createHash('sha256').update(contents).digest('hex')).toBe(expectedHash);
  }

  expect(provenance.source_revision).toMatch(/^[0-9a-f]{40}$/);
  expect(AUDIT_EVENTBRIDGE_DETAIL_TYPE).toBe(provenance.eventbridge.detail_type);
  expect(AUDIT_EVENTBRIDGE_ENVELOPE_VERSION).toBe(
    provenance.eventbridge.envelope_version,
  );
  expect(AUDIT_EVENTBRIDGE_SOURCES).toEqual(provenance.eventbridge.sources);
});
