import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchRequest, LaunchStatus, Scheduler } from './run-case';
import { object } from './json';

const execute = promisify(execFile);

export type AwsCall = (
  service: string,
  operation: string,
  args: readonly string[],
) => Promise<Record<string, unknown>>;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** No shell, no implicit local profile: task credentials or an explicit human profile. */
export function awsCli(region: string, profile?: string): AwsCall {
  return async (service, operation, args) => {
    try {
      const result = await execute(
        'aws',
        [
          service,
          operation,
          ...args,
          '--region',
          region,
          '--no-cli-pager',
          '--output',
          'json',
          '--cli-connect-timeout',
          '5',
          '--cli-read-timeout',
          '20',
          ...(profile ? ['--profile', profile] : []),
        ],
        {
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, AWS_MAX_ATTEMPTS: '2', AWS_RETRY_MODE: 'standard' },
        },
      );

      return object(JSON.parse(result.stdout));
    } catch {
      throw new Error(`AWS ${service} ${operation} failed; inspect protected task logs`);
    }
  };
}

export function launcherScheduler(call: AwsCall, launcherArn: string): Scheduler {
  return {
    now: Date.now,
    sleep,
    invoke: async (launchRequest: LaunchRequest): Promise<LaunchStatus> => {
      const tempLaunchDir = await mkdtemp(join(tmpdir(), 'harness-launch-'));

      try {
        const path = join(tempLaunchDir, 'response.json');

        const response = await call('lambda', 'invoke', [
          '--function-name',
          launcherArn,
          '--cli-binary-format',
          'raw-in-base64-out',
          '--payload',
          JSON.stringify(launchRequest),
          path,
        ]);

        if (response.FunctionError || response.StatusCode !== 200) {
          throw new Error('protected launcher failed');
        }

        const payload = object(JSON.parse(await readFile(path, 'utf8')));

        if (
          payload.experimentId !== launchRequest.experimentId ||
          payload.caseId !== launchRequest.caseId ||
          payload.stepId !== launchRequest.stepId ||
          !['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'STOPPED'].includes(String(payload.status))
        ) {
          throw new Error('invalid protected launcher response');
        }

        return {
          ...launchRequest,
          status: payload.status as LaunchStatus['status'],
          ...(typeof payload.taskArn === 'string' ? { taskArn: payload.taskArn } : {}),
        };
      } finally {
        await rm(tempLaunchDir, { recursive: true, force: true });
      }
    },
  };
}
