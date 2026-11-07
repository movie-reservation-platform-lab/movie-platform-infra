/**
 * Decides which cleanup blocker texts may be stored in the operator record. Only the fixed
 * vocabulary in `CLEANUP_BLOCKERS` is kept; anything else (a raw AWS error, task output)
 * is replaced, so private details never reach the record.
 */

import { CLEANUP_BLOCKERS } from '@movie-platform/experiment-sandbox';

const SAFE_BLOCKERS = new Set<string>(Object.values(CLEANUP_BLOCKERS));

const UNKNOWN_BLOCKER =
  'Cleanup reported an unrecognized blocker; inspect protected inventory and retry';

/**
 * The blockers to store: safe texts kept, everything else replaced by one generic text,
 * duplicates removed. The result has at most four entries, however many came in, so a
 * large or hostile response can never stop cleanup's result from being saved.
 */
export function sanitizedCleanupBlockers(blockers: readonly string[]): string[] {
  const stored = blockers.map((blocker) =>
    SAFE_BLOCKERS.has(blocker) ? blocker : UNKNOWN_BLOCKER,
  );

  return [...new Set(stored)];
}
