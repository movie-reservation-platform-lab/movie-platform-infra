import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const CONTRACT_ARTIFACTS = [
  'manifest.json',
  'platform-audit-event-v1.schema.json',
  'examples/authentication-accepted-v1.json',
  'examples/authentication-rejected-v1.json',
] as const;

/**
 * Place of origin of the audit contract.
 *
 * Used to validate if the contract is coming from a trustable source
 */
interface Provenance {
  readonly artifact_sha256: Readonly<Record<string, string>>;
  readonly contract: string;
  readonly eventbridge: unknown;
  readonly source_repository: string;
  readonly source_revision: string;
}

export interface VendorAuditContractOptions {
  /** Directory containing the reviewed producer contract bundle. */
  readonly sourceBundleDirectory: string;
  /** Exact producer Git commit from which the bundle was obtained. */
  readonly sourceRevision: string;
  /** Consumer directory containing provenance.json and bundle/. */
  readonly destinationContractDirectory: string;
}

/**
 * Vendor one reviewed audit-contract release into a consumer repository.
 *
 * vendoring = copying from a source repository into the current repository
 * The complete source bundle is read and validated before any destination file
 * is changed. The copied artifact hashes and producer revision are then written
 * to provenance.json so offline CI can verify the committed contract later.
 */
export function vendorAuditContract(
  options: VendorAuditContractOptions,
): void {
  const {
    destinationContractDirectory,
    sourceBundleDirectory,
    sourceRevision,
  } = options;

  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new Error('Source revision must be a 40-character lowercase Git SHA.');
  }

  const manifestRawContent = readFileSync(join(sourceBundleDirectory, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRawContent) as { readonly contract?: unknown };
  if (manifest.contract !== 'platform-audit/1') {
    throw new Error(
      `${basename(sourceBundleDirectory)} is not a platform-audit/1 bundle.`,
    );
  }

  const artifacts = CONTRACT_ARTIFACTS.map((relativePath) => ({
    contents: readFileSync(join(sourceBundleDirectory, relativePath)),
    relativePath,
  }));
  const provenancePath = join(destinationContractDirectory, 'provenance.json');
  const provenanceRawContent = readFileSync(provenancePath, 'utf8');
  const provenance = JSON.parse(provenanceRawContent,) as Provenance;
  const hashes: Record<string, string> = {};

  for (const { contents, relativePath } of artifacts) {
    const destinationPath = join(
      destinationContractDirectory,
      'bundle',
      relativePath,
    );
    mkdirSync(dirname(destinationPath), { recursive: true });
    writeFileSync(destinationPath, contents);
    hashes[relativePath] = createHash('sha256').update(contents).digest('hex');
  }

  const serializedDestionationProvenance = JSON.stringify({
    ...provenance,
    artifact_sha256: hashes,
    source_revision: sourceRevision,
  }, null, 2)
  const destinationProvenanceContent = `${serializedDestionationProvenance}\n`;
  writeFileSync(provenancePath, destinationProvenanceContent);
}
