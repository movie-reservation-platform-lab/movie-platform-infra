/**
 * Lets one operator command at a time change an experiment record. The lock is a file
 * next to the record, created exclusively and holding the owner's process ID.
 */

import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

import { checkPrivatePath } from './record-file';

const CREATE_EXCLUSIVE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Runs `action` while holding the record's lock, and releases it afterwards.
 *
 * A process killed mid-command (for example with Ctrl-C during an AWS call) leaves the
 * lock behind. The next run then reports whether its owner is still running, so the
 * operator knows when it is safe to remove it.
 * If the action and lock release both fail, an AggregateError preserves both errors.
 *
 * @throws Error when another command holds the lock, or the lock is stale
 */
export async function withRecordLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  checkPrivatePath(path);

  const lockPath = `${path}.lock`;
  const fd = acquireLock(lockPath);
  let outcome: { success: true; value: T } | { success: false; error: unknown };

  try {
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);

    const value = await action();

    outcome = { success: true, value };
  } catch (error) {
    outcome = { success: false, error };
  }

  try {
    releaseLock(fd, lockPath);
  } catch (releaseError) {
    if (!outcome.success) {
      throw new AggregateError(
        [outcome.error, releaseError],
        'Sandbox command failed and its record lock could not be released',
        { cause: releaseError },
      );
    }

    throw releaseError;
  }

  if (!outcome.success) {
    throw outcome.error;
  }

  return outcome.value;
}

/** Attempts to remove the lock even when closing its descriptor fails. */
function releaseLock(fd: number, lockPath: string): void {
  try {
    closeSync(fd);
  } finally {
    removeLock(lockPath);
  }
}

function acquireLock(lockPath: string): number {
  try {
    return openSync(lockPath, CREATE_EXCLUSIVE, 0o600);
  } catch (error) {
    if (isErrorCode(error, 'EEXIST')) {
      throw new Error(describeHeldLock(lockPath), { cause: error });
    }

    throw error;
  }
}

/** Explains who holds an existing lock, and what the operator can do about it. */
function describeHeldLock(lockPath: string): string {
  const ownerPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);

  if (Number.isInteger(ownerPid) && isProcessRunning(ownerPid)) {
    return `Record is locked by running process ${ownerPid}; wait for it to finish`;
  }

  return `Stale record lock ${lockPath} (owner ${Number.isInteger(ownerPid) ? ownerPid : 'unknown'} is not running); remove it if no other sandbox command is running`;
}

/** Whether a process exists; signal 0 checks without sending anything. */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return isErrorCode(error, 'EPERM');
  }
}

/** Removes the lock; one that is already gone is fine and must not hide the action's error. */
function removeLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
