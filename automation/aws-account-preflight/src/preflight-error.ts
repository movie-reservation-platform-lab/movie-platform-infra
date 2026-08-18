/**
 * Expected, sanitized failure at the operator-facing preflight boundary.
 *
 * @internal
 */
export class PreflightFailure extends Error {}

/**
 * Stop the current preflight path with an operator-safe explanation.
 *
 * The `never` return type tells TypeScript that execution cannot continue,
 * allowing callers to narrow values after a failed validation branch.
 *
 * @internal
 */
export function fail(message: string): never {
  throw new PreflightFailure(message);
}
