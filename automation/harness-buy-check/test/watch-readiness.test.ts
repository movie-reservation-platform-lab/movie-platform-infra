// Exercise observer publication ordering with an interleaved release-side read.
import { object } from '../src/json';
import { parseRuntimeConfig } from '../src/runtime-config';
import { runTask, RuntimePorts } from '../src/task-runtime';

const image = '111111111111.dkr.ecr.eu-central-1.amazonaws.com/recommendation@sha256:';

const config = parseRuntimeConfig({
  experimentId: 'synthetic',
  region: 'eu-central-1',
  cluster: 'cluster',
  service: 'service',
  recipeTaskDefinitionArn: 'recipe:1',
  containerName: 'recommendation',
  goodImage: image + 'a'.repeat(64),
  badImage: image + 'b'.repeat(64),
  stateTableName: 'state',
  probeAlarmName: 'probe',
});

test('release-side readiness reads stay true between metric publication and the next successful alarm response', async () => {
  let currentTime = 0;
  let publishedReady = false;
  let alarmReads = 0;
  let readinessDuringSecondAlarmRead: boolean | undefined;
  const stopAfterRead = new Error('bounded fake observer complete');

  const ports: RuntimePorts = {
    now: () => currentTime,
    sleep: async (milliseconds) => {
      if (alarmReads >= 2) {
        throw stopAfterRead;
      }

      currentTime += milliseconds;
    },
    probe: async () => true,
    call: async (_service, operation, input) => {
      if (operation === 'update-item') {
        const values = object(input.ExpressionAttributeValues);

        publishedReady = object(values[':ready']).BOOL === true;

        return {};
      }

      if (operation === 'describe-alarms') {
        alarmReads += 1;

        if (alarmReads === 2) {
          readinessDuringSecondAlarmRead = publishedReady;
        }

        return { MetricAlarms: [{ AlarmName: 'probe', StateValue: 'OK' }] };
      }

      return baselineResponse(operation);
    },
  };

  await expect(runTask('watch', 'good', config, ports)).rejects.toBe(stopAfterRead);
  expect(readinessDuringSecondAlarmRead).toBe(true);
});

test('a failed publication drains pending work before the final failure report', async () => {
  jest.useFakeTimers({ now: 0 });
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const failure = new Error('simulated heartbeat write failure');
  let writes = 0;
  let inFlight = 0;
  const reports: unknown[] = [];

  const ports: RuntimePorts = {
    now: Date.now,
    sleep: pause,
    probe: async () => true,
    call: async (_service, operation, input) => {
      inFlight += 1;

      try {
        await pause(100);

        if (operation === 'update-item') {
          writes += 1;

          if (writes === 2) {
            throw failure;
          }

          reports.push(input.ExpressionAttributeValues);

          return {};
        }

        if (operation === 'describe-alarms') {
          return { MetricAlarms: [{ AlarmName: 'probe', StateValue: 'OK' }] };
        }

        return baselineResponse(operation);
      } finally {
        inFlight -= 1;
      }
    },
  };

  try {
    const finished = expect(runTask('watch', 'good', config, ports)).rejects.toBe(failure);

    await jest.advanceTimersByTimeAsync(15_000);
    await finished;
    expect(reports).toHaveLength(2);

    expect(reports.at(-1)).toMatchObject({
      ':ready': { BOOL: false },
      ':verdict': { S: 'FAIL' },
      ':candidate': { S: 'PENDING' },
    });

    expect(inFlight).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

function baselineResponse(operation: string): Record<string, unknown> {
  if (operation === 'describe-services') {
    return {
      services: [
        {
          taskDefinition: 'recipe:1',
          deploymentConfiguration: { alarms: { enable: false, alarmNames: ['probe'] } },
        },
      ],
    };
  }

  if (operation === 'list-service-deployments') {
    return {
      serviceDeployments: [
        {
          serviceDeploymentArn: 'baseline',
          status: 'SUCCESSFUL',
          createdAt: '2026-10-24T10:00:00Z',
        },
      ],
    };
  }

  if (operation === 'list-tasks') {
    return { taskArns: ['task1', 'task2'] };
  }

  if (operation === 'describe-tasks') {
    return {
      tasks: [1, 2].map((taskNumber) => ({
        taskArn: `task${taskNumber}`,
        taskDefinitionArn: 'recipe:1',
        lastStatus: 'RUNNING',
        containers: [{ name: 'recommendation', imageDigest: 'sha256:' + 'a'.repeat(64) }],
        attachments: [{ details: [{ name: 'privateIPv4Address', value: `10.0.0.${taskNumber}` }] }],
      })),
    };
  }

  if (operation === 'put-metric-data') {
    return {};
  }

  throw new Error('unexpected observer operation');
}
