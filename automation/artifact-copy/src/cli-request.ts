import { TextDecoder } from 'node:util';

import {
  ARTIFACT_TRANSFER_OPERATION,
  type ArtifactCopyRequest,
  type ArtifactTransferOperation,
  type ArtifactTransferRequest,
} from './model';

export const ARTIFACT_COPY_CLI_REQUEST_VERSION = 'artifact-copy-request-v1';
export const ARTIFACT_COPY_CLI_REQUEST_VERSION_V2 = 'artifact-copy-request-v2';
export const MAX_ARTIFACT_COPY_REQUEST_BYTES = 64 * 1024;

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const V1_ALLOWED_FIELDS = new Set([
  'requestVersion',
  'sourceReference',
  'destinationRepository',
  'expectedDigest',
  'sourceAuthFile',
  'destinationAuthFile',
]);
const V2_ALLOWED_FIELDS = new Set([...V1_ALLOWED_FIELDS, 'operation']);

interface JsonObject {
  readonly [key: string]: unknown;
}

export interface ArtifactCopyCliRequestV1 {
  readonly requestVersion: typeof ARTIFACT_COPY_CLI_REQUEST_VERSION;
  readonly copyRequest: ArtifactCopyRequest;
}

export interface ArtifactCopyCliRequestV2 {
  readonly requestVersion: typeof ARTIFACT_COPY_CLI_REQUEST_VERSION_V2;
  readonly transferRequest: ArtifactTransferRequest;
}

export type ArtifactCopyCliRequest =
  | ArtifactCopyCliRequestV1
  | ArtifactCopyCliRequestV2;

export class ArtifactCopyCliInputFailure extends Error {
  constructor() {
    super('artifact-copy CLI request is invalid');
    this.name = 'ArtifactCopyCliInputFailure';
  }
}

/** Parse the untrusted transport document without duplicating copy policy. */
export function parseArtifactCopyCliRequest(rawRequest: Buffer): ArtifactCopyCliRequest {
  if (rawRequest.length === 0 || rawRequest.length > MAX_ARTIFACT_COPY_REQUEST_BYTES) {
    failCliInput();
  }

  let requestText: string;
  try {
    requestText = UTF8_DECODER.decode(rawRequest);
  } catch {
    failCliInput();
  }

  assertNoDuplicateJsonObjectKeys(requestText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(requestText) as unknown;
  } catch {
    failCliInput();
  }
  if (!isJsonObject(parsed)) {
    failCliInput();
  }

  const requestVersion = parsed.requestVersion;
  const allowedFields = requestVersion === ARTIFACT_COPY_CLI_REQUEST_VERSION
    ? V1_ALLOWED_FIELDS
    : requestVersion === ARTIFACT_COPY_CLI_REQUEST_VERSION_V2
      ? V2_ALLOWED_FIELDS
      : failCliInput();
  const fields = Object.keys(parsed);
  if (fields.some((field) => !allowedFields.has(field))) {
    failCliInput();
  }

  const sourceReference = readRequiredString(parsed, 'sourceReference');
  const destinationRepository = readRequiredString(parsed, 'destinationRepository');
  const expectedDigest = readRequiredString(parsed, 'expectedDigest');
  const destinationAuthFile = readRequiredString(parsed, 'destinationAuthFile');
  const sourceAuthFile = readOptionalString(parsed, 'sourceAuthFile');

  const commonRequest = {
    sourceReference,
    destinationRepository,
    expectedDigest,
    ...(sourceAuthFile === undefined ? {} : { sourceAuthFile }),
    destinationAuthFile,
  };

  if (requestVersion === ARTIFACT_COPY_CLI_REQUEST_VERSION) {
    return Object.freeze({
      requestVersion,
      copyRequest: Object.freeze(commonRequest),
    });
  }
  if (requestVersion !== ARTIFACT_COPY_CLI_REQUEST_VERSION_V2) {
    failCliInput();
  }

  const operation = readOperation(parsed);
  return Object.freeze({
    requestVersion,
    transferRequest: Object.freeze({ ...commonRequest, operation }),
  });
}

function readOperation(object: JsonObject): ArtifactTransferOperation {
  const operation = object.operation;
  if (
    operation !== ARTIFACT_TRANSFER_OPERATION.COPY_AND_VERIFY &&
    operation !== ARTIFACT_TRANSFER_OPERATION.VERIFY_EXISTING
  ) {
    failCliInput();
  }
  return operation;
}

function readRequiredString(object: JsonObject, field: string): string {
  const value = object[field];
  if (typeof value !== 'string' || value.length === 0) {
    failCliInput();
  }
  return value;
}

function readOptionalString(object: JsonObject, field: string): string | undefined {
  const value = object[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    failCliInput();
  }
  return value;
}

/** JSON.parse keeps the last duplicate key, so reject duplicates before parsing. */
function assertNoDuplicateJsonObjectKeys(jsonText: string): void {
  const objectKeySets: Set<string>[] = [];

  for (let index = 0; index < jsonText.length; index += 1) {
    const character = jsonText[index];
    if (character === '{') {
      objectKeySets.push(new Set());
      continue;
    }
    if (character === '}') {
      objectKeySets.pop();
      continue;
    }
    if (character !== '"') {
      continue;
    }

    const stringStart = index;
    index = findJsonStringEnd(jsonText, stringStart);
    let nextIndex = index + 1;
    while (isJsonWhitespace(jsonText[nextIndex])) {
      nextIndex += 1;
    }
    if (jsonText[nextIndex] !== ':') {
      continue;
    }

    const currentKeys = objectKeySets.at(-1);
    if (currentKeys === undefined) {
      failCliInput();
    }
    let key: unknown;
    try {
      key = JSON.parse(jsonText.slice(stringStart, index + 1)) as unknown;
    } catch {
      failCliInput();
    }
    if (typeof key !== 'string' || currentKeys.has(key)) {
      failCliInput();
    }
    currentKeys.add(key);
  }
}

function findJsonStringEnd(jsonText: string, start: number): number {
  for (let index = start + 1; index < jsonText.length; index += 1) {
    if (jsonText[index] === '\\') {
      index += 1;
      continue;
    }
    if (jsonText[index] === '"') {
      return index;
    }
  }
  failCliInput();
}

function isJsonWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\n' || character === '\r' || character === '\t';
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failCliInput(): never {
  throw new ArtifactCopyCliInputFailure();
}
