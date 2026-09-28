import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fail } from './preflight-error';
import { parseAwsTargetJson, type AwsTarget } from './target-schema';

const TARGET_FILE_NAME = 'aws-target.json';

/**
 * Resolve, protect, read, and validate the operator-owned target manifest.
 *
 * @internal
 */
export function loadAwsTarget(environment: NodeJS.ProcessEnv): AwsTarget {
  const targetFile = resolveTargetFile(environment);
  const metadata = readTargetMetadata(targetFile);

  if (metadata.isSymbolicLink()) {
    fail('the target file must not be a symbolic link');
  }
  if (!metadata.isFile()) {
    fail('the target file must be a regular file');
  }

  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    fail('the target file owner cannot be verified on this operating system');
  }
  if (metadata.uid !== currentUid) {
    fail('the target file must be owned by the current operator');
  }
  if ((metadata.mode & 0o077) !== 0) {
    fail('the target file must deny all group and other access');
  }

  let contents: string;
  try {
    contents = readFileSync(targetFile, 'utf8');
  } catch {
    fail('the target file must be readable by its owner');
  }

  return parseAwsTargetJson(contents);
}

/** Resolve the private target location without printing operator-owned paths. */
function resolveTargetFile(environment: NodeJS.ProcessEnv): string {
  const override = environment.MOVIE_PLATFORM_AWS_TARGET_FILE;
  if (override !== undefined && override.length > 0) {
    if (!isAbsolute(override)) {
      fail('MOVIE_PLATFORM_AWS_TARGET_FILE must be an absolute path');
    }
    return override;
  }

  const xdgConfigHome = environment.XDG_CONFIG_HOME;
  if (xdgConfigHome !== undefined && xdgConfigHome.length > 0) {
    if (!isAbsolute(xdgConfigHome)) {
      fail('XDG_CONFIG_HOME must be an absolute path');
    }
    return join(xdgConfigHome, 'movie-platform', TARGET_FILE_NAME);
  }

  const home = environment.HOME;
  if (home === undefined || !isAbsolute(home)) {
    fail('HOME must be an absolute path when XDG_CONFIG_HOME is unset');
  }
  return join(home, '.config', 'movie-platform', TARGET_FILE_NAME);
}

function readTargetMetadata(targetFile: string): Stats {
  try {
    return lstatSync(targetFile);
  } catch {
    fail('the target file must be a regular file');
  }
}
