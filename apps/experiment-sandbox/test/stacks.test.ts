import * as fs from 'node:fs';
import * as path from 'node:path';

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { parseSandboxConfig, sandboxResourceNames } from '../lib/config';
import { ExperimentControlStack } from '../lib/control-stack';
import { ExperimentWorkloadStack } from '../lib/workload-stack';

// Offline CloudFormation assertions for both stacks, synthesized from the synthetic
// fixture. Config validation itself is tested in the contract package
// (`packages/experiment-sandbox/test/sandbox-config.test.ts`).

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/synthetic.json'), 'utf8'),
);

/** One statement of an IAM policy document, as it appears in the template. */
interface PolicyStatement {
  readonly Action: string | string[];
  readonly Resource: unknown;
  readonly Condition?: unknown;
}

/** A template resource with the fields these tests read. */
interface TemplateResource {
  readonly Type: string;
  readonly DependsOn?: string[];
  readonly DeletionPolicy?: string;
  readonly Properties: Record<string, unknown>;
}

/** Synthesizes both stacks from the fixture, the same way `bin/experiment-sandbox.ts` does. */
function synthesizeTemplates(): { control: Template; workload: Template } {
  const config = parseSandboxConfig(fixture);
  const names = sandboxResourceNames(config);
  const app = new App();
  const env = { account: config.accountId, region: config.region };

  const control = new ExperimentControlStack(app, names.controlStack, config, {
    env,
    stackName: names.controlStack,
  });

  const workload = new ExperimentWorkloadStack(app, names.workloadStack, config, control, {
    env,
    stackName: names.workloadStack,
  });

  return { control: Template.fromStack(control), workload: Template.fromStack(workload) };
}

function resourcesOf(template: Template): Record<string, TemplateResource> {
  return template.toJSON().Resources as Record<string, TemplateResource>;
}

/** Every statement of every `AWS::IAM::Policy` in the template. */
function policyStatements(template: Template): PolicyStatement[] {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as PolicyStatement[],
  );
}

function actionsOf(statement: PolicyStatement): string[] {
  return [statement.Action].flat();
}

/** The single statement granting `action`; fails the test if there is not exactly one. */
function statementGranting(template: Template, action: string): PolicyStatement {
  const matches = policyStatements(template).filter((statement) =>
    actionsOf(statement).includes(action),
  );

  expect(matches).toHaveLength(1);

  return matches[0];
}

/** Policy documents attached to the role with physical name `roleName`, serialized for text checks. */
function policiesOfRole(template: Template, roleName: string): string {
  const resources = Object.entries(resourcesOf(template));

  const [roleId] = resources.find(
    ([, resource]) =>
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === roleName,
  )!;

  return JSON.stringify(
    resources
      .map(([, resource]) => resource)
      .filter(
        (resource) =>
          resource.Type === 'AWS::IAM::Policy' &&
          JSON.stringify(resource.Properties.Roles).includes(`"${roleId}"`),
      ),
  );
}

/**
 * Actions these stacks use that AWS cannot limit to specific resources. A statement
 * that scopes them is silently useless: AWS denies the call at runtime.
 *
 * Source: the AWS Service Authorization Reference, machine-readable form at
 * https://servicereference.us-east-1.amazonaws.com/v1/<service>/<service>.json
 * (actions with an empty `Resources` list), checked 2026-10-25. Add any new
 * action of that kind here when a stack starts using it.
 */
const UNSCOPABLE_ACTIONS = new Set([
  'ecs:DeregisterTaskDefinition',
  'ecs:DescribeTaskDefinition',
  'ecs:ListTaskDefinitions',
  'logs:DescribeLogGroups',
]);

let templates: ReturnType<typeof synthesizeTemplates>;

beforeAll(() => {
  templates = synthesizeTemplates();
});

describe('ExperimentControlStack', () => {
  describe('state and inventory', () => {
    it('keeps a versioned inventory bucket with all public access blocked', () => {
      templates.control.hasResourceProperties('AWS::S3::Bucket', {
        VersioningConfiguration: { Status: 'Enabled' },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it('keys lease state by experimentId with on-demand billing', () => {
      templates.control.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: [{ AttributeName: 'experimentId', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      });
    });

    it('deletes state, inventory and logs when the control stack is destroyed', () => {
      const resources = Object.values(resourcesOf(templates.control));
      const owned = ['AWS::S3::Bucket', 'AWS::DynamoDB::Table', 'AWS::Logs::LogGroup'];

      for (const resource of resources.filter((candidate) => owned.includes(candidate.Type))) {
        expect(resource.DeletionPolicy).toBe('Delete');
      }

      // A versioned bucket only deletes cleanly once emptied.
      expect(resources.some((resource) => resource.Type === 'Custom::S3AutoDeleteObjects')).toBe(
        true,
      );
    });
  });

  describe('launcher', () => {
    it('runs the launcher handler with this experiment and workload stack', () => {
      templates.control.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
        Handler: 'index.launcherHandler',
        Environment: {
          Variables: Match.objectLike({
            EXPERIMENT_ID: 'exp-synthetic',
            WORKLOAD_STACK: 'exp-synthetic-workload',
          }),
        },
      });
    });

    it('may start only the nine trial step task definitions', () => {
      const runTask = statementGranting(templates.control, 'ecs:RunTask');
      const resources = JSON.stringify(runTask.Resource);

      expect([runTask.Resource].flat()).toHaveLength(9);
      expect(resources).toContain('task-definition/exp-synthetic-good-gate:*');
      expect(resources).not.toContain('exp-synthetic-recommendation');
      expect(resources).not.toContain('exp-synthetic-delegate');
      expect(resources).not.toContain('exp-synthetic-*');
    });
  });

  describe('cleanup', () => {
    it('runs cleanup every five minutes for this experiment', () => {
      templates.control.hasResourceProperties('AWS::Events::Rule', {
        State: 'ENABLED',
        ScheduleExpression: 'rate(5 minutes)',
        Targets: Match.arrayWith([
          Match.objectLike({ Input: '{"experimentId":"exp-synthetic","scheduled":true}' }),
        ]),
      });
    });

    it('lets the deletion role tear down route associations, only in the sandbox region', () => {
      const teardown = JSON.stringify(statementGranting(templates.control, 'ec2:DeleteVpc'));

      expect(teardown).toContain('ec2:DisassociateRouteTable');
      expect(teardown).toContain('ec2:DetachInternetGateway');
      expect(teardown).toContain('aws:RequestedRegion');
    });

    it('never lets the deletion role create EC2 resources', () => {
      const allActions = policyStatements(templates.control).flatMap(actionsOf);

      expect(allActions.filter((action) => action.startsWith('ec2:Create'))).toEqual([]);
    });

    it('keeps protected control roles out of the deletion role reach', () => {
      const roleDeletion = statementGranting(templates.control, 'iam:DeleteRole');

      expect(JSON.stringify(roleDeletion.Condition)).toContain('iam:ResourceTag/ProtectedControl');
    });

    it('lets the deletion role invoke the admission provider while deleting the workload', () => {
      expect(policiesOfRole(templates.control, 'exp-synthetic-workload-deletion')).toContain(
        'lambda:InvokeFunction',
      );
    });

    it('discovers log groups everywhere but deletes only experiment log groups', () => {
      const discovery = statementGranting(templates.control, 'logs:DescribeLogGroups');
      const deletion = statementGranting(templates.control, 'logs:DeleteLogGroup');

      expect(discovery.Resource).toBe('*');
      expect(deletion.Resource).not.toEqual('*');
      expect(actionsOf(deletion)).not.toContain('logs:DescribeLogGroups');
    });
  });

  describe('logging', () => {
    it('gives every control Lambda a CloudFormation-owned log group', () => {
      const functions = Object.values(resourcesOf(templates.control)).filter(
        (resource) => resource.Type === 'AWS::Lambda::Function',
      );

      for (const lambdaFunction of functions) {
        expect(lambdaFunction.Properties.LoggingConfig).toMatchObject({
          LogGroup: expect.anything(),
        });
      }
    });
  });
});

describe('ExperimentWorkloadStack', () => {
  describe('network and ingress', () => {
    it('creates no NAT gateway', () => {
      templates.workload.resourceCountIs('AWS::EC2::NatGateway', 0);
    });

    it('opens the internet-facing load balancer only to the configured operator address', () => {
      templates.workload.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
      });

      templates.workload.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ CidrIp: '192.0.2.1/32', FromPort: 80, ToPort: 80 }),
        ]),
      });
    });
  });

  describe('recommendation service', () => {
    it('releases through a native 10% canary with five-minute bakes and alarm rollback', () => {
      templates.workload.hasResourceProperties('AWS::ECS::Service', {
        DesiredCount: 2,
        DeploymentConfiguration: Match.objectLike({
          Strategy: 'CANARY',
          CanaryConfiguration: { CanaryPercent: 10, CanaryBakeTimeInMinutes: 5 },
          BakeTimeInMinutes: 5,
          MinimumHealthyPercent: 100,
          MaximumPercent: 200,
          Alarms: Match.objectLike({ Enable: false, Rollback: true }),
        }),
      });
    });

    it('serves the digest-pinned good image on port 8082 behind both target groups', () => {
      templates.workload.hasResourceProperties('AWS::ECS::Service', {
        LoadBalancers: Match.arrayWith([
          Match.objectLike({
            ContainerName: 'recommendation',
            ContainerPort: 8082,
            AdvancedConfiguration: Match.objectLike({ AlternateTargetGroupArn: Match.anyValue() }),
          }),
        ]),
      });

      templates.workload.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: '256',
        Memory: '512',
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Image: fixture.goodImage,
            PortMappings: [{ ContainerPort: 8082, Protocol: 'tcp' }],
          }),
        ]),
      });
    });
  });

  describe('admission', () => {
    it('makes every workload resource wait for the lease admission check', () => {
      const resources = Object.entries(resourcesOf(templates.workload));

      const [admissionId] = resources.find(
        ([, resource]) => resource.Type === 'AWS::CloudFormation::CustomResource',
      )!;

      for (const [id, resource] of resources) {
        if (id !== admissionId) {
          expect(resource.DependsOn).toContain(admissionId);
        }
      }
    });
  });

  describe('Harness delegate', () => {
    it('may invoke the launcher but cannot start tasks, pass roles or update services', () => {
      const delegatePolicies = policiesOfRole(templates.workload, 'exp-synthetic-delegate');

      expect(delegatePolicies).toContain('lambda:InvokeFunction');
      expect(delegatePolicies).not.toMatch(/ecs:RunTask|iam:PassRole|ecs:UpdateService/);
    });

    it('receives only the fixed experiment context, without an operator record mount', () => {
      templates.workload.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Family: 'exp-synthetic-delegate',
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              { Name: 'EXPERIMENT_ID', Value: 'exp-synthetic' },
              { Name: 'SANDBOX_ACCOUNT_ID', Value: '111111111111' },
              { Name: 'SANDBOX_REGION', Value: 'eu-central-1' },
            ]),
          }),
        ]),
      });
    });
  });

  describe('trial step roles', () => {
    it('gives the gate step no AWS permissions', () => {
      expect(policiesOfRole(templates.workload, 'exp-synthetic-gate')).toBe('[]');
    });
  });
});

describe('IAM in both stacks', () => {
  it('grants actions AWS cannot scope only on "*"', () => {
    const statements = [templates.control, templates.workload].flatMap(policyStatements);

    const wronglyScoped = statements.flatMap((statement) => {
      const resources = [statement.Resource].flat();
      const grantsEverything = resources.length === 1 && resources[0] === '*';

      return grantsEverything
        ? []
        : actionsOf(statement).filter((action) => UNSCOPABLE_ACTIONS.has(action));
    });

    expect(wronglyScoped).toEqual([]);
  });
});
