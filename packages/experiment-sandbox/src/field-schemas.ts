import { z } from 'zod';

const MAX_TEXT_LENGTH = 2048;
// eslint-disable-next-line no-control-regex -- reject control characters in operator input
const CONTROL_CHARACTERS = /[\x00-\x1f]/;

/**
 * Non-empty operator text of at most 2048 characters with no control
 * characters. Every string field in the record builds on this, so a value
 * loaded from disk can never smuggle newlines or terminal escapes into logs.
 */
export const boundedTextSchema = z
  .string()
  .min(1)
  .max(MAX_TEXT_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value), 'must not contain control characters');

/**
 * Bounded text that must also match `pattern`.
 *
 * @param pattern - full-string pattern, anchored by the caller
 */
export function textMatching(pattern: RegExp): z.ZodString {
  return boundedTextSchema.regex(pattern);
}

/** Twelve-digit AWS account ID. */
export const awsAccountIdSchema = textMatching(/^\d{12}$/);

/** Absolute filesystem path, used for operator target files. */
export const absolutePathSchema = textMatching(/^\//);

/**
 * UTC timestamp in ISO 8601 form, such as `2026-10-24T10:00:00Z` or
 * `2026-10-24T10:00:00.123Z` (the output of `Date.prototype.toISOString`).
 *
 * The trailing `Z` is required. A value without a zone would be read in the
 * local time of whichever machine parses it, so a laptop and a Lambda would
 * disagree about lease and evidence deadlines. Impossible dates such as
 * February 30 are rejected rather than rolled into March.
 */
export const isoTimestampSchema = z.iso.datetime({
  error: 'must be a UTC ISO 8601 timestamp such as 2026-10-24T10:00:00Z',
});

/**
 * Whether `value` is a UTC ISO 8601 timestamp accepted by
 * {@link isoTimestampSchema}. For hand-written validators that cannot use the
 * schema directly, such as the CDK app's config check.
 */
export function isUtcTimestamp(value: string): boolean {
  return isoTimestampSchema.safeParse(value).success;
}

/**
 * Finite number that is zero or greater, such as a dollar amount. In zod 4,
 * `z.number()` already rejects `Infinity` and `NaN`.
 */
export const nonNegativeNumberSchema = z.number().nonnegative();
