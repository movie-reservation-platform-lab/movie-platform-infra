/**
 * Tests for the record lock: one command at a time, and a clear message for a lock left
 * behind by a killed process.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withRecordLock } from '../src/record-lock';

let directory: string;
let recordPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sandbox-lock-'));
  recordPath = join(directory, 'record.json');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('withRecordLock', () => {
  it('releases the lock after the action, also when it fails', async () => {
    await expect(
      withRecordLock(recordPath, async () => {
        throw new Error('action failed');
      }),
    ).rejects.toThrow('action failed');

    expect(existsSync(`${recordPath}.lock`)).toBe(false);
  });

  it('refuses a second command while the first holds the lock', async () => {
    await withRecordLock(recordPath, async () => {
      await expect(withRecordLock(recordPath, async () => undefined)).rejects.toThrow(
        `locked by running process ${process.pid}`,
      );
    });
  });

  it('reports a stale lock from a process that is no longer running', async () => {
    const deadPid = 2_147_483_646;

    writeFileSync(`${recordPath}.lock`, `${deadPid}\n`, { mode: 0o600 });

    await expect(withRecordLock(recordPath, async () => undefined)).rejects.toThrow(
      `owner ${deadPid} is not running`,
    );
  });

  it('keeps the action error when the lock file was already removed', async () => {
    await expect(
      withRecordLock(recordPath, async () => {
        rmSync(`${recordPath}.lock`);
        throw new Error('action failed');
      }),
    ).rejects.toThrow('action failed');
  });

  it('preserves both errors when the action and lock removal fail', async () => {
    const actionError = new Error('action failed');

    const failure = withRecordLock(recordPath, async () => {
      rmSync(`${recordPath}.lock`);
      mkdirSync(`${recordPath}.lock`);
      throw actionError;
    });

    await expect(failure).rejects.toBeInstanceOf(AggregateError);

    await expect(failure).rejects.toMatchObject({
      errors: [actionError, expect.objectContaining({ code: expect.any(String) })],
    });
  });
});
