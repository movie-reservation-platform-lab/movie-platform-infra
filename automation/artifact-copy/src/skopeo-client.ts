import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import {
  ARTIFACT_COPY_FAILURE_CODE,
  failArtifactCopy,
} from './artifact-copy-error';
import type {
  RawManifestReadRequest,
  RegistryCopyRequest,
  RegistryImageClient,
} from './model';

const INSPECT_TIMEOUT_MILLISECONDS = 30_000;
const COPY_TIMEOUT_MILLISECONDS = 5 * 60_000;
const MAX_CAPTURED_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ProcessInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes: number;
  readonly shell: false;
}

export interface ProcessResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error?: Error;
}

export type ProcessRunner = (invocation: ProcessInvocation) => ProcessResult;

export interface SkopeoRegistryClientOptions {
  readonly executablePath: string;
}

/** Create the replaceable no-shell adapter used by artifact-copy orchestration. */
export function createSkopeoRegistryClient(
  options: SkopeoRegistryClientOptions,
  runner: ProcessRunner = runProcess,
): RegistryImageClient {
  const executablePath = validateExecutablePath(options.executablePath);
  return Object.freeze({
    readRawManifest: async (request: RawManifestReadRequest) => {
      const { reference, authFile } = request;
      const authArguments = authFile === undefined
        ? ['--no-creds']
        : ['--authfile', authFile];
      const result = runSkopeo(
        runner,
        executablePath,
        [
          'inspect',
          '--raw',
          '--tls-verify=true',
          ...authArguments,
          `docker://${reference}`,
        ],
        INSPECT_TIMEOUT_MILLISECONDS,
        'inspect',
      );
      if (result.stdout.length === 0) {
        failTool('skopeo inspect returned no manifest bytes');
      }
      return Buffer.from(result.stdout);
    },
    copy: async (request: RegistryCopyRequest) => {
      const {
        sourceReference,
        destinationReference,
        sourceAuthFile,
        destinationAuthFile,
      } = request;
      const sourceAuthArguments = sourceAuthFile === undefined
        ? ['--src-no-creds']
        : ['--src-authfile', sourceAuthFile];
      runSkopeo(
        runner,
        executablePath,
        [
          'copy',
          '--quiet',
          '--preserve-digests',
          '--src-tls-verify=true',
          '--dest-tls-verify=true',
          ...sourceAuthArguments,
          '--dest-authfile',
          destinationAuthFile,
          `docker://${sourceReference}`,
          `docker://${destinationReference}`,
        ],
        COPY_TIMEOUT_MILLISECONDS,
        'copy',
      );
    },
  });
}

function runSkopeo(
  runner: ProcessRunner,
  executablePath: string,
  arguments_: readonly string[],
  timeoutMilliseconds: number,
  operation: 'copy' | 'inspect',
): ProcessResult {
  const result = runner(Object.freeze({
    executable: executablePath,
    arguments: Object.freeze([...arguments_]),
    timeoutMilliseconds,
    maxOutputBytes: MAX_CAPTURED_OUTPUT_BYTES,
    shell: false,
  }));
  if (result.error !== undefined || result.status !== 0) {
    failTool(`skopeo ${operation} failed`);
  }
  return result;
}

function validateExecutablePath(value: string): string {
  if (
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    failTool('skopeo executable path must be a normalized absolute path');
  }
  return value;
}

function runProcess(invocation: ProcessInvocation): ProcessResult {
  const result = spawnSync(invocation.executable, invocation.arguments, {
    encoding: 'buffer',
    killSignal: 'SIGKILL',
    maxBuffer: invocation.maxOutputBytes,
    shell: invocation.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: invocation.timeoutMilliseconds,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    error: result.error,
  };
}

function failTool(message: string): never {
  failArtifactCopy(ARTIFACT_COPY_FAILURE_CODE.TOOL_FAILED, message);
}
