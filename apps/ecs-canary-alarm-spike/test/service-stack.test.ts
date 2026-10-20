import { Match } from 'aws-cdk-lib/assertions';
import { Annotations } from 'aws-cdk-lib/assertions';
import { IMAGE_DIGEST_PATTERN } from '../lib/service-stack';
import { synthRepositoryTemplate, synthServiceStack, synthServiceTemplate } from './spike-template';

describe('fixture image repository', () => {
  it('is immutable, scanned, and removed with its images on teardown', () => {
    const template = synthRepositoryTemplate();
    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
      EmptyOnDelete: true,
    });
    template.hasResource('AWS::ECR::Repository', { DeletionPolicy: 'Delete' });
    template.hasOutput('RepositoryUri', {});
    template.hasOutput('RepositoryName', {});
  });
});

describe('spike service stack infrastructure', () => {
  const template = synthServiceTemplate();

  it('accepts only a sha256 digest as the image parameter', () => {
    template.hasParameter('ImageDigest', { Type: 'String', AllowedPattern: IMAGE_DIGEST_PATTERN });
    const pattern = new RegExp(IMAGE_DIGEST_PATTERN);
    expect(pattern.test(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(pattern.test('latest')).toBe(false);
    expect(pattern.test(`sha256:${'a'.repeat(63)}`)).toBe(false);
    expect(pattern.test(`repo@sha256:${'a'.repeat(64)}`)).toBe(false);
  });

  it('uses public subnets without any NAT gateway', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::Subnet', 2);
  });

  it('admits ALB traffic only from the operator prefix list', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      SourcePrefixListId: 'pl-0123456789abcdef0',
      FromPort: 80,
      ToPort: 80,
    });
    // Inline and standalone inbound rules only: task egress to 0.0.0.0/0 is
    // intended, because tasks pull from ECR through the internet gateway.
    const inlineIngress = Object.values(template.findResources('AWS::EC2::SecurityGroup'))
      .map((group) => group.Properties.SecurityGroupIngress ?? []);
    const standaloneIngress = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'))
      .map((rule) => rule.Properties);
    const ingress = JSON.stringify([inlineIngress, standaloneIngress]);
    expect(ingress).not.toContain('CidrIp');
  });

  it('admits task traffic only from the ALB security group', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 8080,
      ToPort: 8080,
      SourceSecurityGroupId: Match.anyValue(),
    });
  });

  it('routes production traffic through a listener rule behind a fixed 404 default', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: 'fixed-response' })],
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 10,
      Conditions: [Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/*'] } })],
      Actions: [Match.objectLike({ Type: 'forward' })],
    });
  });

  it('creates two IP target groups with a fast /healthz check', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
    template.allResourcesProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetType: 'ip',
      HealthCheckPath: '/healthz',
      HealthCheckIntervalSeconds: 10,
    });
  });

  it('runs a 0.25 vCPU / 0.5 GB task pulling the digest-pinned fixture image', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '512',
      ContainerDefinitions: [Match.objectLike({
        Name: 'fixture',
        PortMappings: [Match.objectLike({ ContainerPort: 8080 })],
      })],
    });
    const taskDefinitions = JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'));
    expect(taskDefinitions).toContain('"@",{"Ref":"ImageDigest"}');
  });

  it('measures the error rate across both target groups at load-balancer level', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'EcsCanarySpike-ErrorRate',
      Threshold: 2,
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: 'IF(requests > 0, 100 * errors / requests, 0)' }),
        Match.objectLike({
          Id: 'errors',
          MetricStat: Match.objectLike({
            Metric: Match.objectLike({
              MetricName: 'HTTPCode_Target_5XX_Count',
              Dimensions: [Match.objectLike({ Name: 'LoadBalancer' })],
            }),
          }),
        }),
      ]),
    });
  });

  it.each([
    ['notBreaching', 'notBreaching'],
    ['breaching', 'breaching'],
    ['missing', 'missing'],
  ] as const)('models the bridge alarm at 10s with missing data treated as %s', (setting, expected) => {
    synthServiceTemplate({ bridgeMissingData: setting }).hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'EcsCanarySpike-WatchVerdict',
      Namespace: 'EcsCanarySpike',
      MetricName: 'WatchVerdict',
      Period: 10,
      TreatMissingData: expected,
    });
  });

  it('combines both member alarms into the rollback composite', () => {
    template.hasResourceProperties('AWS::CloudWatch::CompositeAlarm', {
      AlarmName: 'EcsCanarySpike-Rollback',
      AlarmRule: Match.anyValue(),
    });
    const composite = JSON.stringify(template.findResources('AWS::CloudWatch::CompositeAlarm'));
    expect(composite).toContain('ErrorRateAlarm');
    expect(composite).toContain('WatchVerdictAlarm');
  });

  it('records ECS deployment events for the spike service in a log group', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.ecs'],
        'detail-type': ['ECS Deployment State Change', 'ECS Service Action'],
      }),
    });
  });

  it('keeps every log group short-lived and deleted on teardown', () => {
    template.allResourcesProperties('AWS::Logs::LogGroup', { RetentionInDays: 1 });
    const logGroups = template.findResources('AWS::Logs::LogGroup');
    for (const logGroup of Object.values(logGroups)) {
      expect(logGroup.DeletionPolicy).toBe('Delete');
    }
  });

  it('tags resources for teardown verification', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      // CDK sorts tags by key, and arrayWith matches in order.
      Tags: Match.arrayWith([
        { Key: 'ExpiresOn', Value: '2026-12-31' },
        { Key: 'Lifecycle', Value: 'disposable' },
        { Key: 'Project', Value: 'movie-platform-infra' },
        { Key: 'Spike', Value: 'infra-100' },
      ]),
    });
  });

  it('changes the recipe, not the cluster, when recipeRevision changes', () => {
    synthServiceTemplate({ recipeRevision: 'env-2' }).hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [Match.objectLike({
        Environment: [{ Name: 'SPIKE_RECIPE_REVISION', Value: 'env-2' }],
      })],
    });
    synthServiceTemplate({ infraRevision: 'tag-2' }).hasResourceProperties('AWS::ECS::Cluster', {
      Tags: Match.arrayWith([{ Key: 'InfraRevision', Value: 'tag-2' }]),
    });
    const recipeOf = (infraRevision: string): string => JSON.stringify(
      synthServiceTemplate({ infraRevision }).findResources('AWS::ECS::TaskDefinition'),
    );
    expect(recipeOf('tag-2')).toBe(recipeOf('1'));
  });
});

describe('Session 3 release model: infra deploys carry the running revision', () => {
  const RUNNING = 'arn:aws:ecs:eu-central-1:111111111111:task-definition/Family:7';

  it('points the service at the recipe only for the bootstrap deploy', () => {
    const template = synthServiceTemplate();
    const [recipeId] = Object.keys(template.findResources('AWS::ECS::TaskDefinition'));
    template.hasResourceProperties('AWS::ECS::Service', { TaskDefinition: { Ref: recipeId } });
  });

  it('pins the service to the running revision passed as context', () => {
    synthServiceTemplate({ activeTaskDefinitionArn: RUNNING })
      .hasResourceProperties('AWS::ECS::Service', { TaskDefinition: RUNNING });
  });

  it('has no CloudFormation parameter a raw deploy could reuse for the running revision', () => {
    const parameters = Object.keys(synthServiceTemplate().toJSON().Parameters ?? {});
    expect(parameters.sort()).toEqual(['BootstrapVersion', 'ImageDigest']);
  });

  it('fails validation without the running revision, so a raw deploy stops before AWS', () => {
    Annotations.fromStack(synthServiceStack({ activeTaskDefinitionArn: undefined }))
      .hasError('*', Match.stringLikeRegexp('Missing context activeTaskDefinitionArn'));
    Annotations.fromStack(synthServiceStack({ activeTaskDefinitionArn: RUNNING }))
      .hasNoError('*', Match.anyValue());
  });

  it('exports the recipe ARN for the release script and the infra-deploy wrapper', () => {
    const template = synthServiceTemplate();
    const [recipeId] = Object.keys(template.findResources('AWS::ECS::TaskDefinition'));
    template.hasOutput('RecipeTaskDefinitionArn', { Value: { Ref: recipeId } });
  });

  it('can add a never-signalled wait condition after the service, for run R5c-4', () => {
    expect(synthServiceTemplate().findResources('AWS::CloudFormation::WaitCondition')).toEqual({});
    const template = synthServiceTemplate({ failInfraDeploy: true });
    const [serviceId] = Object.keys(template.findResources('AWS::ECS::Service'));
    template.hasResource('AWS::CloudFormation::WaitCondition', {
      Properties: { Timeout: '30', Count: 1 },
      DependsOn: Match.arrayWith([serviceId]),
    });
  });
});
