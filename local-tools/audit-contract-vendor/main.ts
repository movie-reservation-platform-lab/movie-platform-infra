import { isAbsolute, join } from 'node:path';
import { vendorAuditContract } from './vendor-audit-contract';

/** Run the deliberate local workflow that vendors a reviewed producer contract. */
function main(args: readonly string[]): void {
  const [sourceBundleDirectory, sourceRevision] = args;
  if (
    sourceBundleDirectory === undefined
    || !isAbsolute(sourceBundleDirectory)
    || sourceRevision === undefined
  ) {
    throw new Error(
      'Usage: vendor:audit-contract -- <absolute-bundle-directory> <40-character-source-revision>',
    );
  }

  vendorAuditContract({
    destinationContractDirectory: join(
      __dirname,
      '..',
      '..',
      'packages',
      'audit-ingestion',
      'contract',
    ),
    sourceBundleDirectory,
    sourceRevision,
  });
}

main(process.argv.slice(2));
