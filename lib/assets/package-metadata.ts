import * as fs from 'node:fs';

/** Reads and validates a package version without shelling out during CDK synth. */
export function readPackageVersion(packageJsonPath: string): string {
  const parsedPackage: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  if (typeof parsedPackage !== 'object' || parsedPackage === null || !('version' in parsedPackage)) {
    throw new Error(`${packageJsonPath} must contain a version field`);
  }

  const version = parsedPackage.version;
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error(`${packageJsonPath} must contain a non-empty string version`);
  }

  return version;
}
