/** Exercises the built SDK bundle over loopback inside the trial tools container. */
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { test } = require('node:test');
const { createTaskTransport, TaskCommandError } = require('../dist/task-call.js');

test('packaged task transport handles signed AWS requests and sanitizes errors', async (t) => {
  const epoch = 1767225600;
  const alarm = { AlarmName: 'trial-probe', StateValue: 'OK' };
  const requests = [];

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const target = request.headers['x-amz-target'];
    const operation = target?.split('.').at(-1);
    requests.push({
      operation,
      input: JSON.parse(Buffer.concat(chunks).toString()),
      signed: request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 '),
    });

    response.setHeader('content-type', request.headers['content-type']);
    switch (operation) {
      case 'ListServiceDeployments':
        response.end(JSON.stringify({ serviceDeployments: [{ createdAt: epoch }] }));
        return;
      case 'DescribeAlarms':
        response.end(JSON.stringify({ MetricAlarms: [alarm] }));
        return;
      case 'DescribeServices':
      case 'ListTasks':
      case 'DescribeTasks':
        response.end('{}');
        return;
      case 'PutMetricData':
      case 'UpdateItem':
        response.end();
        return;
      default:
        response.statusCode = 400;
        response.end(
          JSON.stringify({ __type: 'ValidationException', message: 'private server detail' }),
        );
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  Object.assign(process.env, {
    AWS_ENDPOINT_URL: 'http://127.0.0.1:' + server.address().port,
    AWS_ACCESS_KEY_ID: 'dummy',
    AWS_SECRET_ACCESS_KEY: 'dummy',
    AWS_EC2_METADATA_DISABLED: 'true',
  });

  const transport = createTaskTransport('eu-central-1');

  try {
    const listing = { cluster: 'trial', service: 'workload', maxResults: 20 };
    const namedAlarm = { AlarmNames: [alarm.AlarmName], AlarmTypes: ['MetricAlarm'] };
    const heartbeat = {
      TableName: 'trial',
      Key: { experimentId: { S: 'case#watch' } },
      UpdateExpression: 'SET ready = :value',
      ExpressionAttributeValues: { ':value': { BOOL: true } },
    };
    const invalidRead = { TableName: 'missing', Key: heartbeat.Key, ConsistentRead: true };

    const deployments = await transport.call('ecs', 'list-service-deployments', listing);
    assert.deepEqual(deployments, {
      serviceDeployments: [{ createdAt: new Date(epoch * 1000).toISOString() }],
    });
    assert.deepEqual(await transport.call('cloudwatch', 'describe-alarms', namedAlarm), {
      MetricAlarms: [alarm],
    });
    assert.deepEqual(await transport.call('dynamodb', 'update-item', heartbeat), {});

    await assert.rejects(transport.call('dynamodb', 'get-item', invalidRead), (error) => {
      assert.ok(error instanceof TaskCommandError);
      assert.equal(error.operation, 'get-item');
      assert.equal(error.message, 'AWS get-item failed');
      assert.doesNotMatch(error.stack, /private server detail/);
      return true;
    });

    assert.deepEqual(requests, [
      { operation: 'ListServiceDeployments', input: listing, signed: true },
      { operation: 'DescribeAlarms', input: namedAlarm, signed: true },
      { operation: 'UpdateItem', input: heartbeat, signed: true },
      { operation: 'GetItem', input: invalidRead, signed: true },
    ]);
    // Measure the repeat cost after clients, credentials and connections are warm.
    const observe = [
      ['ecs', 'describe-services', { cluster: 'trial', services: ['workload'] }],
      ['ecs', 'list-service-deployments', listing],
      [
        'ecs',
        'list-tasks',
        { cluster: 'trial', serviceName: 'workload', desiredStatus: 'RUNNING' },
      ],
      ['ecs', 'describe-tasks', { cluster: 'trial', tasks: ['task1', 'task2'] }],
    ];
    const publish = [
      [
        'cloudwatch',
        'put-metric-data',
        {
          Namespace: 'HarnessTrial',
          MetricData: [
            { MetricName: 'ProbeFailed', Value: 0, Unit: 'Count', StorageResolution: 1 },
          ],
        },
      ],
      ['dynamodb', 'update-item', heartbeat],
    ];

    async function measure(sequence) {
      const start = performance.now();
      for (const operation of sequence) {
        await transport.call(...operation);
      }
      return Math.round(performance.now() - start);
    }

    await Promise.all([measure(observe), measure(publish)]);
    const [discoveryMs, publicationMs] = await Promise.all([measure(observe), measure(publish)]);
    t.diagnostic(
      `Warm loopback timings in parallel: ECS discovery (4 calls) ${discoveryMs} ms, heartbeat publication (2 calls) ${publicationMs} ms.`,
    );
  } finally {
    transport.close();
  }
});
