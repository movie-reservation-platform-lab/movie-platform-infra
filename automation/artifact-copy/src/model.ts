export const ARTIFACT_COPY_VERIFICATION_METHOD = 'exact-manifest-digest-v1';
export const ARTIFACT_TRANSFER_VERIFICATION_METHOD = 'exact-manifest-digest-v2';

export const ARTIFACT_TRANSFER_OPERATION = {
  COPY_AND_VERIFY: 'copy-and-verify',
  VERIFY_EXISTING: 'verify-existing',
} as const;

export type ArtifactTransferOperation =
  (typeof ARTIFACT_TRANSFER_OPERATION)[keyof typeof ARTIFACT_TRANSFER_OPERATION];

export const ARTIFACT_TRANSFER_OUTCOME = {
  COPIED: 'copied',
  ALREADY_PRESENT: 'already-present',
} as const;

export type ArtifactTransferOutcome =
  (typeof ARTIFACT_TRANSFER_OUTCOME)[keyof typeof ARTIFACT_TRANSFER_OUTCOME];

/** Caller-selected immutable source and credential-file boundaries. */
export interface ArtifactCopyRequest {
  readonly sourceReference: string;
  readonly destinationRepository: string;
  readonly expectedDigest: string;
  readonly sourceAuthFile?: string;
  readonly destinationAuthFile: string;
}

/** V2 caller-selected operation over the same immutable artifact identity. */
export interface ArtifactTransferRequest extends ArtifactCopyRequest {
  readonly operation: ArtifactTransferOperation;
}

/** One raw-manifest registry read. Absence of auth means anonymous access. */
export interface RawManifestReadRequest {
  readonly reference: string;
  readonly authFile?: string;
}

/** Exact registry-to-registry transfer parameters, including the retention tag. */
export interface RegistryCopyRequest {
  readonly sourceReference: string;
  readonly destinationReference: string;
  readonly sourceAuthFile?: string;
  readonly destinationAuthFile: string;
}

/** Narrow port implemented by the Skopeo process adapter. */
export interface RegistryImageClient {
  readonly readRawManifest: (request: RawManifestReadRequest) => Promise<Buffer>;
  readonly copy: (request: RegistryCopyRequest) => Promise<void>;
}

/** Parsed content identity from one supported single-image manifest. */
export interface ImageManifestIdentity {
  readonly mediaType: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly layerDigests: readonly string[];
}

/** Sanitized evidence emitted only after destination verification succeeds. */
export interface ArtifactCopyVerification {
  readonly verificationMethod: typeof ARTIFACT_COPY_VERIFICATION_METHOD;
  readonly sourceManifestDigest: string;
  readonly destinationManifestDigest: string;
  readonly configDigest: string;
  readonly layerDigests: readonly string[];
}

/** Sanitized v2 evidence emitted after exact destination verification succeeds. */
export interface ArtifactTransferVerification {
  readonly verificationMethod: typeof ARTIFACT_TRANSFER_VERIFICATION_METHOD;
  readonly outcome: ArtifactTransferOutcome;
  readonly sourceManifestDigest: string;
  readonly destinationManifestDigest: string;
  readonly configDigest: string;
  readonly layerDigests: readonly string[];
}
