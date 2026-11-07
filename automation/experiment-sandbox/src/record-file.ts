/**
 * The operator's private files: the experiment record, the render inputs and the
 * rendered CDK config. They hold account IDs and evidence, so they must stay out of every
 * Git worktree, be owned by the operator with mode 0600, and never be half-written.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { parseSandboxRecord, type SandboxRecord } from '@movie-platform/experiment-sandbox';

/** Owner read and write only. */
const PRIVATE_FILE_MODE = 0o600;

/** Largest private file read, in bytes; records are a few kilobytes. */
const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;

/** Flags for a new file that must not exist yet and must not be a symbolic link. */
const CREATE_EXCLUSIVE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Checks that a private file path is absolute, has no symbolic links in its parents, and
 * lies outside every Git worktree, including ignored folders inside one.
 *
 * @param path - absolute path to a private file outside every Git worktree
 * @param allowMissingParent - accept parents that do not exist yet, checking the nearest
 *   existing one; used for target files the operator creates later
 * @throws Error naming the rule the path breaks
 */
export function checkPrivatePath(path: string, allowMissingParent = false): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error('Private file path must be absolute and outside Git');
  }

  let parent = dirname(path);

  if (allowMissingParent) {
    while (!existsSync(parent) && dirname(parent) !== parent) {
      parent = dirname(parent);
    }
  }

  if (realpathSync(parent) !== parent) {
    throw new Error('Private file parent must not traverse symbolic links');
  }

  for (let folder = parent; ; folder = dirname(folder)) {
    if (existsSync(join(folder, '.git'))) {
      throw new Error('Runtime records and targets must be outside Git worktrees');
    }

    if (dirname(folder) === folder) {
      break;
    }
  }

  if (parse(path).base.startsWith('.')) {
    throw new Error('Private file name must be explicit, not hidden');
  }
}

/**
 * Reads a private JSON file without following symbolic links.
 *
 * @throws Error when the file is not a regular file owned by the operator with mode 0600
 *   and under 1 MiB, or is not valid JSON
 */
export function readPrivateJson(path: string): unknown {
  checkPrivatePath(path);

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const stat = fstatSync(fd);

    const isPrivateFile =
      stat.isFile() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o777) === PRIVATE_FILE_MODE &&
      stat.size <= MAX_PRIVATE_FILE_BYTES;

    if (!isPrivateFile) {
      throw new Error('Private JSON must be owned regular mode-0600 file smaller than 1MiB');
    }

    try {
      return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
    } catch {
      throw new Error('Private file must contain valid JSON');
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads and validates the experiment record, and checks that its target files are
 * private paths too.
 */
export function readRecord(path: string): SandboxRecord {
  const record = parseSandboxRecord(readPrivateJson(path));

  for (const target of [record.managementTargetFile, record.sandboxTargetFile]) {
    if (target) {
      checkPrivatePath(target, true);
    }
  }

  return record;
}

/**
 * Writes a new private JSON file atomically.
 *
 * @throws Error when the file already exists; private files are never overwritten here
 */
export function createPrivateJson(path: string, value: unknown): void {
  checkPrivatePath(path);

  const temporary = writeTemporaryJson(path, value);

  try {
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }

  syncDirectory(dirname(path));
}

/**
 * Validates and saves the record atomically: readers see the old record or the new one,
 * never a mix. The caller holds the record lock (`withRecordLock`).
 *
 * @param path - absolute path of the private experiment record
 * @param record - complete record to validate before writing
 * @param create - true for a new record; refuses to replace an existing file
 */
export function saveRecord(path: string, record: SandboxRecord, create = false): void {
  checkPrivatePath(path);
  parseSandboxRecord(record);

  if (!create) {
    readRecord(path);
  }

  const temporary = writeTemporaryJson(path, record);

  try {
    if (create) {
      linkSync(temporary, path);
    } else {
      renameSync(temporary, path);
    }
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }

  syncDirectory(dirname(path));
}

/**
 * Writes `value` as JSON to a new, uniquely named file next to `path` and flushes it to
 * disk, so it can be linked or renamed into place in one step.
 *
 * @returns the temporary file's path
 */
function writeTemporaryJson(path: string, value: unknown): string {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, CREATE_EXCLUSIVE, PRIVATE_FILE_MODE);

  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  return temporary;
}

/** Flushes a directory entry change (link, rename) to disk. */
function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
