/**
 * Acceptance tests for the ENGINEER-OWNED slice in lib/canary-service.ts.
 *
 * They describe the synthesized AWS::ECS::Service, not the CDK code that
 * produces it. They fail against the rolling placeholder by design.
 */
import { Match, type Template } from 'aws-cdk-lib/assertions';
import type { SpikeProfile } from '../lib/spike-config';
import { synthServiceTemplate } from './spike-template';

/** Logical IDs of the blue (initial production) and green target groups. */
function targetGroupIds(template: Template): { blue: string; green: string } {
  const rules = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
  const blue: string = rules[0].Properties.Actions[0].TargetGroupArn.Ref;
  const green = Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'))
    .find((id) => id !== blue);
  if (green === undefined) {
    throw new Error('expected a second target group');
  }
  return { blue, green };
}

function onlyListenerRuleId(template: Template): string {
  return Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'))[0];
}

function alarmRef(template: Template, alarmName: string): { Ref: string } {
  const type = alarmName.endsWith('-Rollback') ? 'AWS::CloudWatch::CompositeAlarm' : 'AWS::CloudWatch::Alarm';
  const [id] = Object.keys(template.findResources(type, { Properties: { AlarmName: alarmName } }));
  return { Ref: id };
}

describe('canary service deployment wiring (engineer-owned)', () => {
  it('runs one Fargate task with a public IP in the spike subnets', () => {
    synthServiceTemplate().hasResourceProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE',
      DesiredCount: 1,
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }),
      },
    });
  });

  it('uses the ECS-native canary strategy: 10% for 5 minutes, then a 5 minute bake', () => {
    synthServiceTemplate().hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        Strategy: 'CANARY',
        CanaryConfiguration: { CanaryPercent: 10, CanaryBakeTimeInMinutes: 5 },
        BakeTimeInMinutes: 5,
      }),
    });
  });

  it.each([
    ['halt', false],
    ['revert', true],
    ['breaker', true],
  ] as [SpikeProfile, boolean][])('watches all deployment alarms with profile %s (Rollback=%s)', (profile, rollback) => {
    const template = synthServiceTemplate({ profile });
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        Alarms: {
          AlarmNames: [
            alarmRef(template, 'EcsCanarySpike-ErrorRate'),
            alarmRef(template, 'EcsCanarySpike-WatchVerdict'),
            alarmRef(template, 'EcsCanarySpike-Rollback'),
          ],
          Enable: true,
          Rollback: rollback,
        },
      }),
    });
  });

  it('watches only the member alarms when the composite is excluded', () => {
    const template = synthServiceTemplate({ deploymentAlarmSet: 'members' });
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        Alarms: Match.objectLike({
          AlarmNames: [
            alarmRef(template, 'EcsCanarySpike-ErrorRate'),
            alarmRef(template, 'EcsCanarySpike-WatchVerdict'),
          ],
        }),
      }),
    });
  });

  it.each(['halt', 'revert'] as SpikeProfile[])('has no circuit breaker with profile %s', (profile) => {
    synthServiceTemplate({ profile }).hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({ DeploymentCircuitBreaker: Match.absent() }),
    });
  });

  it('enables the circuit breaker without rollback with profile breaker', () => {
    synthServiceTemplate({ profile: 'breaker' }).hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: false },
      }),
    });
  });

  it('binds blue as the production target group and green as the alternate', () => {
    const template = synthServiceTemplate();
    const { blue, green } = targetGroupIds(template);
    template.hasResourceProperties('AWS::ECS::Service', {
      LoadBalancers: [{
        ContainerName: 'fixture',
        ContainerPort: 8080,
        TargetGroupArn: { Ref: blue },
        AdvancedConfiguration: {
          AlternateTargetGroupArn: { Ref: green },
          ProductionListenerRule: { Ref: onlyListenerRuleId(template) },
          RoleArn: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] },
        },
      }],
    });
  });

  it('gives ECS an infrastructure role that may rewrite load balancer rules', () => {
    synthServiceTemplate().hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'ecs.amazonaws.com' } }),
        ]),
      },
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp('AmazonECSInfrastructureRolePolicyForLoadBalancers')]),
          ]),
        }),
      ]),
    });
  });
});
