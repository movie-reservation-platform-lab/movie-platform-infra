import {
  ECSClient,
  DescribeServicesCommand,
  type DescribeServicesCommandInput,
  ListServiceDeploymentsCommand,
  type ListServiceDeploymentsCommandInput,
  ListTasksCommand,
  type ListTasksCommandInput,
  DescribeTasksCommand,
  type DescribeTasksCommandInput,
  DescribeTaskDefinitionCommand,
  type DescribeTaskDefinitionCommandInput,
  RegisterTaskDefinitionCommand,
  type RegisterTaskDefinitionCommandInput,
  UpdateServiceCommand,
  type UpdateServiceCommandInput,
} from '@aws-sdk/client-ecs';
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  type DescribeAlarmsCommandInput,
  PutMetricDataCommand,
  type PutMetricDataCommandInput,
} from '@aws-sdk/client-cloudwatch';
import {
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandInput,
  UpdateItemCommand,
  type UpdateItemCommandInput,
} from '@aws-sdk/client-dynamodb';

/** Fixed AWS operations available to the protected trial runtime; IAM further scopes each task. */
export type TaskRequest =
  | ['ecs', 'describe-services', DescribeServicesCommandInput]
  | ['ecs', 'list-service-deployments', ListServiceDeploymentsCommandInput]
  | ['ecs', 'list-tasks', ListTasksCommandInput]
  | ['ecs', 'describe-tasks', DescribeTasksCommandInput]
  | ['ecs', 'describe-task-definition', DescribeTaskDefinitionCommandInput]
  | ['ecs', 'register-task-definition', RegisterTaskDefinitionCommandInput]
  | ['ecs', 'update-service', UpdateServiceCommandInput]
  | ['cloudwatch', 'describe-alarms', DescribeAlarmsCommandInput]
  | ['cloudwatch', 'put-metric-data', PutMetricDataCommandInput]
  | ['dynamodb', 'get-item', GetItemCommandInput]
  | ['dynamodb', 'update-item', UpdateItemCommandInput];

/** Service responses retain the JSON representation used by the runtime validators. */
export type TaskCall = (...request: TaskRequest) => Promise<Record<string, unknown>>;

/** Identifies a failed task operation without exposing SDK error payloads or request data. */
export class TaskCommandError extends Error {
  constructor(readonly operation: TaskRequest[1]) {
    super(`AWS ${operation} failed`);
  }
}

/** Reuses the task's credential chain and HTTP connections across discovery and heartbeats. */
export function createTaskTransport(region: string) {
  const config = { region, maxAttempts: 2 };
  const ecs = new ECSClient(config);
  const cloudwatch = new CloudWatchClient(config);
  const dynamodb = new DynamoDBClient(config);

  function send(request: TaskRequest) {
    const [, operation, input] = request;
    const options = { abortSignal: AbortSignal.timeout(30_000) };

    switch (operation) {
      case 'describe-services':
        return ecs.send(new DescribeServicesCommand(input), options);
      case 'list-service-deployments':
        return ecs.send(new ListServiceDeploymentsCommand(input), options);
      case 'list-tasks':
        return ecs.send(new ListTasksCommand(input), options);
      case 'describe-tasks':
        return ecs.send(new DescribeTasksCommand(input), options);
      case 'describe-task-definition':
        return ecs.send(new DescribeTaskDefinitionCommand(input), options);
      case 'register-task-definition':
        return ecs.send(new RegisterTaskDefinitionCommand(input), options);
      case 'update-service':
        return ecs.send(new UpdateServiceCommand(input), options);
      case 'describe-alarms':
        return cloudwatch.send(new DescribeAlarmsCommand(input), options);
      case 'put-metric-data':
        return cloudwatch.send(new PutMetricDataCommand(input), options);
      case 'get-item':
        return dynamodb.send(new GetItemCommand(input), options);
      case 'update-item':
        return dynamodb.send(new UpdateItemCommand(input), options);
    }
  }

  const call: TaskCall = async (...request) => {
    try {
      const { $metadata: _metadata, ...response } = await send(request);

      // The CLI adapter supplied ISO timestamps. Preserve this boundary for deployment history.
      return JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
    } catch {
      throw new TaskCommandError(request[1]);
    }
  };

  function close(): void {
    ecs.destroy();
    cloudwatch.destroy();
    dynamodb.destroy();
  }

  return { call, close };
}
