export const ARTIFACT_COPY_FAILURE_CODE = {
  CONTENT_MISMATCH: 'CONTENT_MISMATCH',
  COPY_FAILED: 'COPY_FAILED',
  DESTINATION_READ_FAILED: 'DESTINATION_READ_FAILED',
  INVALID_INPUT: 'INVALID_INPUT',
  MANIFEST_DIGEST_MISMATCH: 'MANIFEST_DIGEST_MISMATCH',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  SOURCE_READ_FAILED: 'SOURCE_READ_FAILED',
  TOOL_FAILED: 'TOOL_FAILED',
} as const;

export type ArtifactCopyFailureCode =
  (typeof ARTIFACT_COPY_FAILURE_CODE)[keyof typeof ARTIFACT_COPY_FAILURE_CODE];

/** Sanitized failure safe for automation logs and stable test assertions. */
export class ArtifactCopyFailure extends Error {
  constructor(
    readonly code: ArtifactCopyFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactCopyFailure';
  }
}

export function failArtifactCopy(
  code: ArtifactCopyFailureCode,
  message: string,
): never {
  throw new ArtifactCopyFailure(code, message);
}
