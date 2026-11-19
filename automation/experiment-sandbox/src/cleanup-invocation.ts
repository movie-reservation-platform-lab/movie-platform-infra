/**
 * Runs the protected cleanup Lambda once on the operator's request and reads its result.
 * The operator never deletes workload resources itself; only the protected function does.
 */

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';
import { parseCleanupResult, type SandboxRecord } from '@movie-platform/experiment-sandbox';

import { lambdaInvokeResponseSchema, parseAwsResponse } from './aws-responses';
import type { AwsRunner } from './aws-runner';
import {
  assertProtectsRecordedWorkload,
  readControlStackOutputs,
  requiredOutput,
} from './control-stack-outputs';
import type { CleanupResult } from './lifecycle';
import { sandboxAccountId } from './operator-access';

/**
 * Invokes the cleanup function named by the control stack and validates its response.
 *
 * @throws Error when the function is not the sandbox account's own, fails, or answers
 *   with an invalid result
 */
export function invokeCleanup(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  record: SandboxRecord,
): CleanupResult {
  const outputs = readControlStackOutputs(run, access, record);

  assertProtectsRecordedWorkload(outputs, record);

  const cleanupArn = requiredOutput(outputs, 'CleanupArn');
  const ownFunctionPrefix = `arn:aws:lambda:${record.region}:${sandboxAccountId(record)}:function:`;

  if (!cleanupArn.startsWith(ownFunctionPrefix)) {
    throw new Error('Exact cleanup function output missing');
  }

  const response = invokeWithPrivateResponseFile(run, access, cleanupArn, record.id);
  const result = parseCleanupResult(response);

  if (result.experimentId !== record.id) {
    throw new Error('Invalid protected cleanup result');
  }

  return result;
}

/**
 * Invokes the function and reads its response from an owner-only temporary file, which
 * is removed afterwards. The AWS CLI writes Lambda responses to a file, not stdout.
 */
function invokeWithPrivateResponseFile(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  functionArn: string,
  experimentId: string,
): unknown {
  const cleanupArtifactDirectory = mkdtempSync(join(tmpdir(), 'experiment-cleanup-'));
  const responseFile = join(cleanupArtifactDirectory, 'response.json');

  closeSync(openSync(responseFile, 'wx', 0o600));

  try {
    const invocation = parseAwsResponse(
      lambdaInvokeResponseSchema,
      run(access, [
        'lambda',
        'invoke',
        '--function-name',
        functionArn,
        '--cli-binary-format',
        'raw-in-base64-out',
        '--payload',
        JSON.stringify({ experimentId }),
        responseFile,
      ]),
      'lambda invoke',
    );

    if (invocation.FunctionError) {
      throw new Error('Protected cleanup execution failed; inspect durable inventory');
    }

    return JSON.parse(readFileSync(responseFile, 'utf8')) as unknown;
  } finally {
    rmSync(cleanupArtifactDirectory, { recursive: true, force: true });
  }
}
