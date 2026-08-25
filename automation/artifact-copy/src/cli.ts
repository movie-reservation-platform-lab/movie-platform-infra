import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import {
  ARTIFACT_COPY_FAILURE_STAGE,
  ArtifactCopyFailure,
} from './artifact-copy-error';
import { copyAndVerifyArtifact } from './artifact-copy';
import {
  ArtifactCopyCliInputFailure,
  MAX_ARTIFACT_COPY_REQUEST_BYTES,
  parseArtifactCopyCliRequest,
} from './cli-request';
import type {
  ArtifactCopyRequest,
  ArtifactCopyVerification,
  RegistryImageClient,
} from './model';
import { createSkopeoRegistryClient } from './skopeo-client';

export const ARTIFACT_COPY_CLI_EXIT_CODE = {
  SUCCESS: 0,
  INTERNAL_ERROR: 1,
  INVALID_INPUT: 2,
  SOURCE_REJECTED: 3,
  COPY_FAILED: 4,
  DESTINATION_VERIFICATION_FAILED: 5,
} as const;

export const ARTIFACT_COPY_CLI_FAILURE = {
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  SOURCE_REJECTED: 'SOURCE_REJECTED',
  COPY_FAILED: 'COPY_FAILED',
  DESTINATION_VERIFICATION_FAILED: 'DESTINATION_VERIFICATION_FAILED',
} as const;

type ArtifactCopyCliFailure =
  (typeof ARTIFACT_COPY_CLI_FAILURE)[keyof typeof ARTIFACT_COPY_CLI_FAILURE];

export interface ArtifactCopyCliStreams {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface ArtifactCopyCliDependencies {
  readonly readRequestFile: (requestFilePath: string) => Buffer;
  readonly createRegistryClient: (trustedSkopeoExecutable: string) => RegistryImageClient;
  readonly copyArtifact: (
    request: ArtifactCopyRequest,
    client: RegistryImageClient,
  ) => Promise<ArtifactCopyVerification>;
}

interface CliOptions {
  readonly help: boolean;
  readonly requestFile?: string;
  readonly skopeoExecutable?: string;
}

class ArtifactCopyCliArgumentFailure extends Error {
  constructor() {
    super('artifact-copy CLI arguments are invalid');
    this.name = 'ArtifactCopyCliArgumentFailure';
  }
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const PROCESS_STREAMS: ArtifactCopyCliStreams = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};
const PRODUCTION_DEPENDENCIES: ArtifactCopyCliDependencies = {
  readRequestFile: readBoundedRequestFile,
  createRegistryClient: (trustedSkopeoExecutable) =>
    createSkopeoRegistryClient({ executablePath: trustedSkopeoExecutable }),
  copyArtifact: copyAndVerifyArtifact,
};
const CLI_OPTIONS = {
  help: {
    type: 'boolean',
    short: 'h',
  },
  'request-file': {
    type: 'string',
  },
  'skopeo-executable': {
    type: 'string',
  },
} as const;
const USAGE = [
  'Usage: npm run copy:artifact -- --request-file <absolute-path> \\',
  '         --skopeo-executable <normalized-absolute-path>',
  '       npm run copy:artifact -- --help',
  '',
  'Copies and verifies one approved, digest-pinned single-image manifest.',
  'The request file must be strict artifact-copy-request-v1 JSON. The pinned',
  'private workflow separately supplies the trusted Skopeo executable path.',
  'Registry credentials remain in referenced auth files and are never accepted',
  'inline.',
  '',
  'Destination policy is owned by the caller. Private admission must construct',
  'destinationRepository from its committed trusted binding; this CLI validates',
  'the reference and exact copied content, while repository-scoped IAM is the',
  'AWS enforcement backstop.',
  '',
].join('\n');

/** Run the sanitized executable boundary over the existing artifact-copy library. */
export async function runCli(
  arguments_: readonly string[],
  streams: ArtifactCopyCliStreams = PROCESS_STREAMS,
  dependencies: ArtifactCopyCliDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  try {
    const options = parseCliOptions(arguments_);
    if (options.help) {
      streams.stdout(USAGE);
      return ARTIFACT_COPY_CLI_EXIT_CODE.SUCCESS;
    }

    const requestFile = options.requestFile ?? failCliArguments();
    const skopeoExecutable = options.skopeoExecutable ?? failCliArguments();
    const rawRequest = readRequest(requestFile, dependencies.readRequestFile);
    const request = parseArtifactCopyCliRequest(rawRequest);
    const client = dependencies.createRegistryClient(skopeoExecutable);
    const result = await dependencies.copyArtifact(request.copyRequest, client);
    streams.stdout(`${JSON.stringify(result)}\n`);
    return ARTIFACT_COPY_CLI_EXIT_CODE.SUCCESS;
  } catch (error: unknown) {
    const failure = classifyFailure(error);
    streams.stderr(`Artifact copy failed: ${failure}\n`);
    return exitCodeForFailure(failure);
  }
}

function parseCliOptions(arguments_: readonly string[]): CliOptions {
  try {
    const { values } = parseArgs({
      args: [...arguments_],
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: false,
    });
    if (
      values.help === true &&
      (values['request-file'] !== undefined || values['skopeo-executable'] !== undefined)
    ) {
      failCliArguments();
    }
    if (
      values.help !== true &&
      (values['request-file'] === undefined || values['skopeo-executable'] === undefined)
    ) {
      failCliArguments();
    }
    return Object.freeze({
      help: values.help ?? false,
      requestFile: values['request-file'],
      skopeoExecutable: values['skopeo-executable'],
    });
  } catch (error: unknown) {
    if (error instanceof ArtifactCopyCliArgumentFailure) {
      throw error;
    }
    failCliArguments();
  }
}

function readRequest(
  requestFilePath: string,
  readRequestFile: (requestFilePath: string) => Buffer,
): Buffer {
  if (
    requestFilePath.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(requestFilePath) ||
    !path.isAbsolute(requestFilePath) ||
    path.normalize(requestFilePath) !== requestFilePath
  ) {
    failCliArguments();
  }
  try {
    return readRequestFile(requestFilePath);
  } catch {
    throw new ArtifactCopyCliInputFailure();
  }
}

function readBoundedRequestFile(requestFilePath: string): Buffer {
  const descriptor = openSync(requestFilePath, 'r');
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_ARTIFACT_COPY_REQUEST_BYTES) {
      throw new ArtifactCopyCliInputFailure();
    }
    const rawRequest = readFileSync(descriptor);
    if (rawRequest.length > MAX_ARTIFACT_COPY_REQUEST_BYTES) {
      throw new ArtifactCopyCliInputFailure();
    }
    return rawRequest;
  } finally {
    closeSync(descriptor);
  }
}

function classifyFailure(error: unknown): ArtifactCopyCliFailure {
  if (
    error instanceof ArtifactCopyCliArgumentFailure ||
    error instanceof ArtifactCopyCliInputFailure
  ) {
    return ARTIFACT_COPY_CLI_FAILURE.INVALID_INPUT;
  }
  if (!(error instanceof ArtifactCopyFailure)) {
    return ARTIFACT_COPY_CLI_FAILURE.INTERNAL_ERROR;
  }

  switch (error.stage) {
    case ARTIFACT_COPY_FAILURE_STAGE.INPUT:
    case ARTIFACT_COPY_FAILURE_STAGE.TOOL:
      return ARTIFACT_COPY_CLI_FAILURE.INVALID_INPUT;
    case ARTIFACT_COPY_FAILURE_STAGE.SOURCE:
      return ARTIFACT_COPY_CLI_FAILURE.SOURCE_REJECTED;
    case ARTIFACT_COPY_FAILURE_STAGE.COPY:
      return ARTIFACT_COPY_CLI_FAILURE.COPY_FAILED;
    case ARTIFACT_COPY_FAILURE_STAGE.DESTINATION:
      return ARTIFACT_COPY_CLI_FAILURE.DESTINATION_VERIFICATION_FAILED;
    case ARTIFACT_COPY_FAILURE_STAGE.UNKNOWN:
      return ARTIFACT_COPY_CLI_FAILURE.INTERNAL_ERROR;
  }
}

function exitCodeForFailure(failure: ArtifactCopyCliFailure): number {
  switch (failure) {
    case ARTIFACT_COPY_CLI_FAILURE.INVALID_INPUT:
      return ARTIFACT_COPY_CLI_EXIT_CODE.INVALID_INPUT;
    case ARTIFACT_COPY_CLI_FAILURE.SOURCE_REJECTED:
      return ARTIFACT_COPY_CLI_EXIT_CODE.SOURCE_REJECTED;
    case ARTIFACT_COPY_CLI_FAILURE.COPY_FAILED:
      return ARTIFACT_COPY_CLI_EXIT_CODE.COPY_FAILED;
    case ARTIFACT_COPY_CLI_FAILURE.DESTINATION_VERIFICATION_FAILED:
      return ARTIFACT_COPY_CLI_EXIT_CODE.DESTINATION_VERIFICATION_FAILED;
    case ARTIFACT_COPY_CLI_FAILURE.INTERNAL_ERROR:
      return ARTIFACT_COPY_CLI_EXIT_CODE.INTERNAL_ERROR;
  }
}

function failCliArguments(): never {
  throw new ArtifactCopyCliArgumentFailure();
}
