import { cli, type CliIo } from '../src/cli';
import type { LaunchRequest, Scheduler } from '../src/run-case';

const environment = {
  EXPERIMENT_ID: 'exp-test',
  SANDBOX_ACCOUNT_ID: '111111111111',
  SANDBOX_REGION: 'eu-central-1',
  LAUNCHER_ARN: 'arn:aws:lambda:eu-central-1:111111111111:function:protected-launcher',
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/synthetic-credentials',
};

function fixture() {
  const requests: LaunchRequest[] = [];

  const scheduler: Scheduler = {
    now: () => 0,
    sleep: async () => {},
    invoke: async (request) => {
      requests.push(request);

      return { ...request, taskArn: 'synthetic-observed-task', status: 'SUCCEEDED' };
    },
  };

  const createScheduler = jest.fn(() => scheduler);

  const readJson = jest.fn(async () => {
    throw new Error('delegate must not read operator record');
  });

  const io: CliIo = { env: { ...environment }, readJson, write: () => {}, createScheduler };

  return { io, requests, createScheduler, readJson };
}

test('delegate schedules the fixed step from its installed context without an operator record', async () => {
  const f = fixture();

  expect(await cli(['delegate', 'good', '--step', 'gate'], f.io)).toBe(0);
  expect(f.createScheduler).toHaveBeenCalledWith('eu-central-1', environment.LAUNCHER_ARN);
  expect(f.requests).toEqual([{ experimentId: 'exp-test', caseId: 'good', stepId: 'gate' }]);
  expect(f.readJson).not.toHaveBeenCalled();
});

test.each([
  { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '' },
  { LAUNCHER_ARN: 'arn:aws:lambda:eu-central-1:222222222222:function:wrong-account' },
  { SANDBOX_REGION: 'us-east-1' },
  { EXPERIMENT_ID: 'shared-production' },
])('invalid delegate context fails before creating the scheduler: %j', async (changes) => {
  const f = fixture();

  Object.assign(f.io.env, changes);

  await expect(cli(['delegate', 'good', '--step', 'gate'], f.io)).rejects.toThrow();
  expect(f.createScheduler).not.toHaveBeenCalled();
  expect(f.readJson).not.toHaveBeenCalled();
});
