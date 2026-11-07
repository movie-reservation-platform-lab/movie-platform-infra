/**
 * The error every AWS CLI failure becomes. Only the stable service error code (for
 * example `AccessDeniedException`) crosses the subprocess boundary; raw stderr can hold
 * account details and is never kept.
 */

/** An AWS CLI call that failed, timed out or could not start. */
export class AwsOperationError extends Error {
  /**
   * @param code - the AWS error code, or undefined when the call timed out, could not
   *   start, or failed without one; then the outcome on AWS's side is unknown
   */
  constructor(readonly code: string | undefined) {
    super(code ? `AWS CLI operation failed with ${code}` : 'AWS CLI operation failed or timed out');
    this.name = 'AwsOperationError';
  }
}
