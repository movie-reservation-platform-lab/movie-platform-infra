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

export const ARTIFACT_COPY_FAILURE_STAGE = {
  COPY: 'copy',
  DESTINATION: 'destination',
  INPUT: 'input',
  SOURCE: 'source',
  TOOL: 'tool',
  UNKNOWN: 'unknown',
} as const;

export type ArtifactCopyFailureStage =
  (typeof ARTIFACT_COPY_FAILURE_STAGE)[keyof typeof ARTIFACT_COPY_FAILURE_STAGE];

/** Sanitized failure safe for automation logs and stable test assertions. */
export class ArtifactCopyFailure extends Error {
  readonly #stage: ArtifactCopyFailureStage;

  constructor(
    readonly code: ArtifactCopyFailureCode,
    message: string,
    stage: ArtifactCopyFailureStage = ARTIFACT_COPY_FAILURE_STAGE.UNKNOWN,
  ) {
    super(message);
    this.name = 'ArtifactCopyFailure';
    this.#stage = stage;
  }

  /** Structured operation boundary used by adapters without parsing error prose. */
  get stage(): ArtifactCopyFailureStage {
    return this.#stage;
  }
}

export function failArtifactCopy(
  code: ArtifactCopyFailureCode,
  message: string,
  stage: ArtifactCopyFailureStage = ARTIFACT_COPY_FAILURE_STAGE.UNKNOWN,
): never {
  throw new ArtifactCopyFailure(code, message, stage);
}
