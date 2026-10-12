import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

/**
 * Private operator files: the run file, credentials, and evidence. Messages
 * name the file's role ("credentials file"), never its path or contents.
 */
export class PrivateFileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PrivateFileError';
  }
}

/**
 * Read an owner-only regular file. Opening with `O_NOFOLLOW` and checking the
 * open descriptor (not the path) means a symlink swapped in between the check
 * and the read cannot redirect it.
 */
export function readPrivateFile(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new PrivateFileError(`the ${label} path must be absolute`);
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new PrivateFileError(`the ${label} must be an existing regular file, not a symbolic link`);
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new PrivateFileError(`the ${label} must be a regular file`);
    }
    if (metadata.uid !== process.getuid?.()) {
      throw new PrivateFileError(`the ${label} must be owned by the current operator`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new PrivateFileError(`the ${label} must deny all group and other access (chmod 600)`);
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Create a new owner-only file. Refuses to overwrite an existing file or to
 * follow a symlink, so evidence never lands with looser permissions or in an
 * unexpected place.
 */
export function writeNewPrivateFile(path: string, contents: string, label: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new PrivateFileError(`the ${label} could not be created; it must not exist yet`);
  }
  try {
    fchmodSync(descriptor, 0o600); // The umask may have narrowed it further, never widened; make it exact.
    writeFileSync(descriptor, contents);
  } finally {
    closeSync(descriptor);
  }
}
