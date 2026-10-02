import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vendorAuditContract } from '../vendor-audit-contract';

const SOURCE_REVISION = 'a'.repeat(40);
const ARTIFACTS = {
  'manifest.json': '{"contract":"platform-audit/1"}\n',
  'platform-audit-event-v1.schema.json': '{"type":"object"}\n',
  'examples/authentication-accepted-v1.json': '{"status":"accepted"}\n',
  'examples/authentication-rejected-v1.json': '{"status":"rejected"}\n',
} as const;

describe('audit contract vendor', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'audit-contract-vendor-'));
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });

  it('copies the reviewed bundle and records its revision and hashes', () => {
    const sourceBundleDirectory = join(temporaryDirectory, 'source');
    const destinationContractDirectory = join(temporaryDirectory, 'destination');
    writeArtifacts(sourceBundleDirectory, ARTIFACTS);
    writeProvenance(destinationContractDirectory);

    vendorAuditContract({
      destinationContractDirectory,
      sourceBundleDirectory,
      sourceRevision: SOURCE_REVISION,
    });

    const provenance = JSON.parse(
      readFileSync(
        join(destinationContractDirectory, 'provenance.json'),
        'utf8',
      ),
    ) as {
      readonly artifact_sha256: Readonly<Record<string, string>>;
      readonly source_revision: string;
    };

    expect(provenance.source_revision).toBe(SOURCE_REVISION);
    for (const [relativePath, contents] of Object.entries(ARTIFACTS)) {
      expect(
        readFileSync(
          join(destinationContractDirectory, 'bundle', relativePath),
          'utf8',
        ),
      ).toBe(contents);
      expect(provenance.artifact_sha256[relativePath]).toBe(
        createHash('sha256').update(contents).digest('hex'),
      );
    }
  });

  it('rejects an unrelated bundle before changing the destination', () => {
    const sourceBundleDirectory = join(temporaryDirectory, 'unrelated');
    const destinationContractDirectory = join(temporaryDirectory, 'destination');
    writeArtifacts(sourceBundleDirectory, {
      ...ARTIFACTS,
      'manifest.json': '{"contract":"something-else/1"}\n',
    });
    writeProvenance(destinationContractDirectory);

    expect(() =>
      vendorAuditContract({
        destinationContractDirectory,
        sourceBundleDirectory,
        sourceRevision: SOURCE_REVISION,
      }),
    ).toThrow('is not a platform-audit/1 bundle');
    expect(
      readFileSync(
        join(destinationContractDirectory, 'provenance.json'),
        'utf8',
      ),
    ).toContain('old-revision');
  });
});

function writeArtifacts(
  root: string,
  artifacts: Readonly<Record<string, string>>,
): void {
  for (const [relativePath, contents] of Object.entries(artifacts)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}

function writeProvenance(destinationContractDirectory: string): void {
  mkdirSync(destinationContractDirectory, { recursive: true });
  writeFileSync(
    join(destinationContractDirectory, 'provenance.json'),
    `${JSON.stringify({
      artifact_sha256: {},
      contract: 'platform-audit/1',
      eventbridge: {},
      source_repository: 'example/producer',
      source_revision: 'old-revision',
    })}\n`,
  );
}
