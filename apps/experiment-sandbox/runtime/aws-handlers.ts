import {
  HOUR_MS,
  SANDBOX_LIMITS,
  sandboxTaskDefinitionOutputKey,
  sandboxTaskFamilies,
} from '@movie-platform/experiment-sandbox';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  ListTasksCommand,
  StopTaskCommand,
  ListTaskDefinitionsCommand,
  DeregisterTaskDefinitionCommand,
  DeleteTaskDefinitionsCommand,
  TaskDefinitionStatus,
} from '@aws-sdk/client-ecs';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  DeleteStackCommand,
  CancelUpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { launch, parseLaunchInput, Lease, CaseId, Status } from './launcher';
import { cleanup, CleanupState } from './cleanup';

const required = (name: string): string => {
  const v = process.env[name];

  if (!v) {
    throw new Error(`Missing ${name}`);
  }

  return v;
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ecs = new ECSClient({});
const cfn = new CloudFormationClient({});
const s3 = new S3Client({});
const exp = () => required('EXPERIMENT_ID');
const table = () => required('STATE_TABLE');
const stackName = () => required('WORKLOAD_STACK');

async function describeWorkloadStack() {
  try {
    return (await cfn.send(new DescribeStacksCommand({ StackName: stackName() }))).Stacks?.[0];
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'ValidationError' &&
      error.message.includes('does not exist')
    ) {
      return undefined;
    }

    throw error;
  }
}

async function readStableWorkloadOutputs(): Promise<Record<string, string>> {
  const found = await describeWorkloadStack();

  if (
    !found ||
    !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(
      found.StackStatus ?? '',
    )
  ) {
    throw new Error('Workload is not stable');
  }

  return Object.fromEntries(
    (found.Outputs ?? [])
      .filter((o) => o.OutputKey && o.OutputValue)
      .map((o) => [o.OutputKey!, o.OutputValue!]),
  );
}

export async function launcherHandler(event: unknown) {
  const input = parseLaunchInput(event, exp());

  const result = await launch(input, {
    readLease: async () => {
      const result = await ddb.send(
        new GetCommand({ TableName: table(), Key: { experimentId: exp() }, ConsistentRead: true }),
      );

      if (!result.Item) {
        throw new Error('Lease not installed');
      }

      return result.Item as Lease;
    },
    compareAndSwap: async (version, state) => {
      try {
        await ddb.send(
          new PutCommand({
            TableName: table(),
            Item: state,
            ConditionExpression: '#v = :v AND disabled = :no',
            ExpressionAttributeNames: { '#v': 'version' },
            ExpressionAttributeValues: { ':v': version, ':no': false },
          }),
        );

        return true;
      } catch (error) {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
          return false;
        }

        throw error;
      }
    },
    observe: async (taskArn) => {
      const response = await ecs.send(
        new DescribeTasksCommand({ cluster: required('CLUSTER_ARN'), tasks: [taskArn] }),
      );

      const task = response.tasks?.[0];

      if (!task || !task.taskDefinitionArn) {
        throw new Error('Task observation unavailable');
      }

      let status: Status = 'PENDING';

      if (task.lastStatus === 'RUNNING') {
        status = 'RUNNING';
      }

      if (task.lastStatus === 'STOPPED') {
        status =
          task.stopCode === 'EssentialContainerExited' &&
          task.containers?.length === 1 &&
          task.containers[0].exitCode === 0
            ? 'SUCCEEDED'
            : 'FAILED';
      }

      return { status, taskDefinitionArn: task.taskDefinitionArn };
    },
    watch: async (caseId: CaseId) => {
      const row = await ddb.send(
        new GetCommand({
          TableName: table(),
          Key: { experimentId: `${exp()}#${caseId}#watch` },
          ConsistentRead: true,
        }),
      );

      return row.Item as
        | {
            ready: boolean;
            heartbeatAt: number;
            verdict: string;
          }
        | undefined;
    },
    recipe: async (request) => {
      const out = await readStableWorkloadOutputs();
      const key = sandboxTaskDefinitionOutputKey(request.caseId, request.stepId);

      if (
        !out[key] ||
        !out.SubnetIds ||
        !out.TaskSecurityGroupId ||
        out.ClusterArn !== required('CLUSTER_ARN')
      ) {
        throw new Error('Trusted workload recipe unavailable');
      }

      return {
        cluster: out.ClusterArn,
        taskDefinition: out[key],
        count: 1,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: out.SubnetIds.split(','),
            securityGroups: [out.TaskSecurityGroupId],
            assignPublicIp: 'ENABLED',
          },
        },
      };
    },
    runTask: async (request) => {
      const response = await ecs.send(
        new RunTaskCommand({ ...request, tags: [{ key: 'ExperimentId', value: exp() }] }),
      );

      if (response.failures?.length || response.tasks?.length !== 1 || !response.tasks[0].taskArn) {
        throw new Error('Launch unresolved; retry the same step IDs');
      }

      return response.tasks[0].taskArn;
    },
    token: (key) => createHash('sha256').update(key).digest('hex'),
    now: Date.now,
  });

  if (input.stepId === 'watch' && result.status === 'RUNNING') {
    const row = await ddb.send(
      new GetCommand({
        TableName: table(),
        Key: { experimentId: `${exp()}#${input.caseId}#watch` },
        ConsistentRead: true,
      }),
    );

    const o = row.Item;

    if (
      !o?.ready ||
      o.verdict !== 'OK' ||
      typeof o.heartbeatAt !== 'number' ||
      Date.now() - o.heartbeatAt > 30000 ||
      o.heartbeatAt > Date.now()
    ) {
      return { ...result, status: 'PENDING' };
    }
  }

  return result;
}

async function listExperimentTaskArns(): Promise<string[]> {
  const result: string[] = [];
  let nextToken: string | undefined;

  do {
    try {
      const response = await ecs.send(
        new ListTasksCommand({ cluster: required('CLUSTER_ARN'), nextToken }),
      );

      result.push(...(response.taskArns ?? []));
      nextToken = response.nextToken;
    } catch (error) {
      if (error instanceof Error && error.name === 'ClusterNotFoundException') {
        return [];
      }

      throw error;
    }
  } while (nextToken);

  return result;
}

async function listExperimentTaskDefinitions(
  statuses: TaskDefinitionStatus[],
  externalOnly = false,
): Promise<string[]> {
  const allowed = new Set(sandboxTaskFamilies(exp()));
  const result: string[] = [];

  for (const status of statuses) {
    let nextToken: string | undefined;

    do {
      const response = await ecs.send(
        new ListTaskDefinitionsCommand({ familyPrefix: `${exp()}-`, nextToken, status }),
      );

      result.push(
        ...(response.taskDefinitionArns ?? []).filter((arn) => {
          const family = arn.split('/')[1]?.split(':')[0];

          return allowed.has(family) && (!externalOnly || family === `${exp()}-recommendation`);
        }),
      );

      nextToken = response.nextToken;
    } while (nextToken);
  }

  return [...new Set(result)];
}

export async function cleanupHandler(event: unknown): Promise<
  | CleanupState
  | {
      experimentId: string;
      status: 'WAITING_FOR_EXPIRY';
      blockers: string[];
      resources: string[];
      accessRevoked: false;
      workloadsRemoved: false;
    }
> {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Exact registered experiment ID required');
  }

  const input = event as Record<string, unknown>;

  if (
    input.experimentId !== exp() ||
    !['experimentId', 'experimentId,scheduled'].includes(Object.keys(input).sort().join(',')) ||
    ('scheduled' in input && input.scheduled !== true)
  ) {
    throw new Error('Exact registered experiment ID required');
  }

  if (input.scheduled && Date.now() < Date.parse(required('EXPIRES_AT'))) {
    return {
      experimentId: exp(),
      status: 'WAITING_FOR_EXPIRY',
      blockers: [],
      resources: [],
      accessRevoked: false,
      workloadsRemoved: false,
    };
  }

  const bucket = required('INVENTORY_BUCKET');
  const key = `inventory/${exp()}.json`;

  return cleanup(exp(), {
    disableAdmission: async () => {
      await ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: { experimentId: exp() },
          UpdateExpression: 'SET disabled = :yes ADD #v :one',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':yes': true, ':one': 1 },
        }),
      );
    },
    inventory: async () => {
      try {
        const old = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

        return (JSON.parse(await old.Body!.transformToString()) as CleanupState).resources ?? [];
      } catch (error) {
        if (error instanceof Error && ['NoSuchKey', 'NotFound'].includes(error.name)) {
          return [];
        }

        throw error;
      }
    },
    discover: async () => {
      const found = await describeWorkloadStack();
      const resources: string[] = [];

      if (found) {
        let NextToken: string | undefined;

        do {
          const response = await cfn.send(
            new ListStackResourcesCommand({ StackName: stackName(), NextToken }),
          );

          resources.push(
            ...(response.StackResourceSummaries ?? [])
              .filter((r) => r.ResourceStatus !== 'DELETE_COMPLETE')
              .flatMap((r) => (r.PhysicalResourceId ? [r.PhysicalResourceId] : [])),
          );

          NextToken = response.NextToken;
        } while (NextToken);
      }

      resources.push(
        ...(await listExperimentTaskArns()),
        ...(await listExperimentTaskDefinitions(
          found ? ['ACTIVE'] : ['ACTIVE', 'INACTIVE', 'DELETE_IN_PROGRESS'],
          !!found,
        )),
      );

      return {
        resources: [...new Set(resources)],
        stackExists: !!found,
        provisioning:
          !!found?.StackStatus?.endsWith('_IN_PROGRESS') &&
          found.StackStatus !== 'DELETE_IN_PROGRESS',
      };
    },
    stopTasks: async () => {
      for (const task of await listExperimentTaskArns()) {
        await ecs.send(
          new StopTaskCommand({
            cluster: required('CLUSTER_ARN'),
            task,
            reason: 'Protected experiment cleanup',
          }),
        );
      }

      const found = await describeWorkloadStack();

      if (found?.StackStatus === 'UPDATE_IN_PROGRESS') {
        await cfn.send(new CancelUpdateStackCommand({ StackName: stackName() }));
      }
    },
    deleteStack: async () => {
      const found = await describeWorkloadStack();

      if (found?.StackStatus !== 'DELETE_IN_PROGRESS') {
        await cfn.send(
          new DeleteStackCommand({
            StackName: stackName(),
            RoleARN: required('WORKLOAD_DELETION_ROLE'),
          }),
        );
      }
    },
    removeExternalTaskDefinitions: async () => {
      const found = await describeWorkloadStack();

      for (const taskDefinition of await listExperimentTaskDefinitions(['ACTIVE'], !!found)) {
        await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition }));
      }

      // CloudFormation first removes services and its recipe resources. Then delete
      // all inactive revisions, including releases registered outside CloudFormation.
      if (!found) {
        const inactive = await listExperimentTaskDefinitions(['INACTIVE']);

        for (let offset = 0; offset < inactive.length; offset += 10) {
          const response = await ecs.send(
            new DeleteTaskDefinitionsCommand({
              taskDefinitions: inactive.slice(offset, offset + 10),
            }),
          );

          if (response.failures?.length) {
            throw new Error('Task definition deletion remains blocked');
          }
        }
      }
    },
    save: async (state) => {
      console.log(JSON.stringify(state));

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify({ ...state, observedAt: new Date().toISOString() }),
          ContentType: 'application/json',
        }),
      );
    },
  });
}

export async function admissionHandler(event: {
  RequestType: string;
  ResourceProperties?: {
    ExperimentId?: string;
  };
}) {
  if (event.ResourceProperties?.ExperimentId !== exp()) {
    throw new Error('Wrong experiment');
  }

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: exp() };
  }

  const row = await ddb.send(
    new GetCommand({ TableName: table(), Key: { experimentId: exp() }, ConsistentRead: true }),
  );

  const lease = row.Item;

  if (
    !lease ||
    lease.disabled ||
    lease.expiresAt !== required('EXPIRES_AT') ||
    lease.rejectNewWorkAt !== required('LAUNCH_CUTOFF_AT') ||
    Date.now() >= Date.parse(lease.rejectNewWorkAt) ||
    Date.parse(lease.expiresAt) - Date.now() > SANDBOX_LIMITS.maxLeaseHours * HOUR_MS
  ) {
    throw new Error('Protected admitted lease required before allocation');
  }

  return { PhysicalResourceId: exp() };
}
