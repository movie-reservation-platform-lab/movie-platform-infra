import { z } from 'zod';

/** Bounds the error text when a badly broken file produces many issues. */
const MAX_REPORTED_ISSUES = 5;

/**
 * Parses `value` with `schema` and returns the typed result.
 *
 * @param rootLabel - names the whole value in errors, for example `record`
 * @throws Error built by {@link describeIssues}
 */
export function parseWithSchema<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  rootLabel: string,
): z.output<Schema> {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new Error(describeIssues(result.error, rootLabel));
  }

  return result.data;
}

/**
 * Turns zod issues into one message such as
 * `account contains unknown key token; account.state: Invalid option ...`.
 * Unknown keys come first, so a stray `credentials` or `token` field is always
 * named even when the message is truncated. Messages name fields, never their
 * values, so secrets pasted into the wrong field are not echoed into logs.
 */
function describeIssues(error: z.ZodError, rootLabel: string): string {
  const unknownKeyIssues = error.issues.filter((issue) => issue.code === 'unrecognized_keys');
  const otherIssues = error.issues.filter((issue) => issue.code !== 'unrecognized_keys');
  const ordered = [...unknownKeyIssues, ...otherIssues];

  const reported = ordered.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : rootLabel;

    if (issue.code === 'unrecognized_keys') {
      return `${path} contains unknown key ${issue.keys.join(', ')}`;
    }

    return `${path}: ${issue.message}`;
  });

  const hidden = error.issues.length - reported.length;
  const suffix = hidden > 0 ? `; and ${hidden} more` : '';

  return `${reported.join('; ')}${suffix}`;
}
