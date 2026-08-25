import * as path from 'node:path';
import {
  ARTIFACT_COPY_FAILURE_CODE,
  ARTIFACT_COPY_FAILURE_STAGE,
  failArtifactCopy,
} from './artifact-copy-error';
import {
  assertEquivalentImageManifests,
  inspectRawImageManifest,
} from './image-manifest';
import {
  ARTIFACT_COPY_VERIFICATION_METHOD,
  type ArtifactCopyRequest,
  type ArtifactCopyVerification,
  type RegistryImageClient,
} from './model';

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REGISTRY_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::[0-9]{1,5})?$/;
const REPOSITORY_SEGMENT_PATTERN =
  /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

interface ValidatedArtifactCopyRequest extends ArtifactCopyRequest {
  readonly destinationCopyReference: string;
  readonly destinationDigestReference: string;
}

/** Copy an already-approved manifest and independently verify destination content. */
export async function copyAndVerifyArtifact(
  request: ArtifactCopyRequest,
  client: RegistryImageClient,
): Promise<ArtifactCopyVerification> {
  const validated = validateRequest(request);

  const sourceRawManifest = await readManifest(
    client,
    {
      reference: validated.sourceReference,
      authFile: validated.sourceAuthFile,
    },
    'source',
  );
  const sourceManifest = inspectRawImageManifest(
    sourceRawManifest,
    validated.expectedDigest,
    'source',
  );

  try {
    await client.copy({
      sourceReference: validated.sourceReference,
      destinationReference: validated.destinationCopyReference,
      sourceAuthFile: validated.sourceAuthFile,
      destinationAuthFile: validated.destinationAuthFile,
    });
  } catch {
    failArtifactCopy(
      ARTIFACT_COPY_FAILURE_CODE.COPY_FAILED,
      'registry copy failed before destination verification',
      ARTIFACT_COPY_FAILURE_STAGE.COPY,
    );
  }

  const destinationRawManifest = await readManifest(
    client,
    {
      reference: validated.destinationDigestReference,
      authFile: validated.destinationAuthFile,
    },
    'destination',
  );
  const destinationManifest = inspectRawImageManifest(
    destinationRawManifest,
    validated.expectedDigest,
    'destination',
  );
  assertEquivalentImageManifests(sourceManifest, destinationManifest);

  return Object.freeze({
    verificationMethod: ARTIFACT_COPY_VERIFICATION_METHOD,
    sourceManifestDigest: sourceManifest.manifestDigest,
    destinationManifestDigest: destinationManifest.manifestDigest,
    configDigest: sourceManifest.configDigest,
    layerDigests: Object.freeze([...sourceManifest.layerDigests]),
  });
}

async function readManifest(
  client: RegistryImageClient,
  request: { readonly reference: string; readonly authFile?: string },
  location: 'source' | 'destination',
): Promise<Buffer> {
  try {
    return await client.readRawManifest(request);
  } catch {
    failArtifactCopy(
      location === 'source'
        ? ARTIFACT_COPY_FAILURE_CODE.SOURCE_READ_FAILED
        : ARTIFACT_COPY_FAILURE_CODE.DESTINATION_READ_FAILED,
      `${location} manifest read failed`,
      location === 'source'
        ? ARTIFACT_COPY_FAILURE_STAGE.SOURCE
        : ARTIFACT_COPY_FAILURE_STAGE.DESTINATION,
    );
  }
}

function validateRequest(request: ArtifactCopyRequest): ValidatedArtifactCopyRequest {
  if (
    typeof request.expectedDigest !== 'string' ||
    !SHA256_DIGEST_PATTERN.test(request.expectedDigest)
  ) {
    failInvalidInput('expectedDigest must be a lowercase sha256 digest');
  }

  if (typeof request.sourceReference !== 'string') {
    failInvalidInput('sourceReference must be a fully qualified repository at expectedDigest');
  }
  const sourceParts = request.sourceReference.split('@');
  if (
    sourceParts.length !== 2 ||
    sourceParts[1] !== request.expectedDigest ||
    !isValidRepository(sourceParts[0])
  ) {
    failInvalidInput('sourceReference must be a fully qualified repository at expectedDigest');
  }
  if (
    typeof request.destinationRepository !== 'string' ||
    !isValidRepository(request.destinationRepository)
  ) {
    failInvalidInput('destinationRepository must be a fully qualified untagged repository');
  }

  validateAuthFile(request.sourceAuthFile, 'sourceAuthFile', false);
  validateAuthFile(request.destinationAuthFile, 'destinationAuthFile', true);

  return Object.freeze({
    ...request,
    destinationCopyReference:
      `${request.destinationRepository}:sha256-${request.expectedDigest.slice('sha256:'.length)}`,
    destinationDigestReference:
      `${request.destinationRepository}@${request.expectedDigest}`,
  });
}

function isValidRepository(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 255 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    value.includes('://') ||
    value.includes('@')
  ) {
    return false;
  }

  const slashIndex = value.indexOf('/');
  if (slashIndex <= 0 || slashIndex === value.length - 1) {
    return false;
  }
  const host = value.slice(0, slashIndex);
  const repositoryPath = value.slice(slashIndex + 1);
  if (!REGISTRY_HOST_PATTERN.test(host)) {
    return false;
  }

  const portText = host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : undefined;
  if (portText !== undefined && Number(portText) > 65_535) {
    return false;
  }
  return repositoryPath.split('/').every((segment) =>
    REPOSITORY_SEGMENT_PATTERN.test(segment),
  );
}

function validateAuthFile(
  value: unknown,
  fieldName: string,
  required: boolean,
): void {
  if (value === undefined) {
    if (required) {
      failInvalidInput(`${fieldName} is required`);
    }
    return;
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    failInvalidInput(`${fieldName} must be a normalized absolute path`);
  }
}

function failInvalidInput(message: string): never {
  failArtifactCopy(
    ARTIFACT_COPY_FAILURE_CODE.INVALID_INPUT,
    message,
    ARTIFACT_COPY_FAILURE_STAGE.INPUT,
  );
}
