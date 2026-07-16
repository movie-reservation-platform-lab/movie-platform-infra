import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Loads the Dockerfile-specific ignore policy used for both direct Docker builds
 * and CDK asset staging.
 */
export function readDockerfileIgnorePatterns(contextDirectory: string, dockerfile: string): string[] {
  const ignoreFile = path.join(contextDirectory, `${dockerfile}.dockerignore`);

  return fs
    .readFileSync(ignoreFile, 'utf8')
    .split(/\r?\n/)
    .filter((pattern) => pattern.length > 0);
}
