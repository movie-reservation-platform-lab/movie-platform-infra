import { Duration } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';
import type { SpikeProfile } from './spike-config';

/**
 * What ECS does when a deployment alarm fires, per spike profile.
 *
 * `Record` over the `SpikeProfile` union makes the mapping exhaustive: adding
 * a profile fails compilation until its alarm behaviour is chosen here.
 */
const ALARM_BEHAVIOR: Record<SpikeProfile, ecs.AlarmBehavior> = {
  halt: ecs.AlarmBehavior.FAIL_ON_ALARM,
  revert: ecs.AlarmBehavior.ROLLBACK_ON_ALARM,
  breaker: ecs.AlarmBehavior.ROLLBACK_ON_ALARM,
};

/** Inputs the service stack hands to the canary service wiring. */
export interface CanaryServiceProps {
  readonly cluster: ecs.ICluster;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly containerName: string;
  readonly containerPort: number;
  /** Public subnets and the task security group (see the plan, Option E). */
  readonly vpcSubnets: ec2.SubnetSelection;
  readonly securityGroup: ec2.ISecurityGroup;
  /** Which rollback behaviour this run exercises (plan §3 profile table). */
  readonly profile: SpikeProfile;
  /** CloudWatch alarm names ECS must watch during each deployment. */
  readonly deploymentAlarmNames: string[];
  /** Target group that receives production traffic before the first deployment. */
  readonly blueTargetGroup: elbv2.ApplicationTargetGroup;
  /** Target group ECS uses for the new revision during a deployment. */
  readonly greenTargetGroup: elbv2.ApplicationTargetGroup;
  /** Listener rule whose forward weights ECS rewrites to shift traffic. */
  readonly productionListenerRule: elbv2.ApplicationListenerRule;
}

/**
 * Create the spike's Fargate service with an ECS-native canary deployment.
 *
 * Each deployment starts the new revision in the green target group, shifts
 * 10% of production traffic to it for the canary bake, then shifts the rest.
 * Blue stays running for the deployment bake, so ECS can still move traffic
 * back until that window closes. Deployment alarms fail the deployment; the
 * profile decides whether ECS also rolls back (abandon) or freezes (halt).
 *
 * Synthesizes `AWS::ECS::Service` with `DeploymentConfiguration.Strategy`
 * `CANARY` and `LoadBalancers[0].AdvancedConfiguration`. `AlternateTarget`
 * also creates the ECS infrastructure role that rewrites the listener rule's
 * target-group weights.
 *
 * Written by the engineer as the hybrid-teaching slice of infra#100.
 */
export function createCanaryService(
  scope: Construct,
  id: string,
  props: CanaryServiceProps,
): ecs.FargateService {
  // Only the `breaker` profile uses the circuit breaker; `undefined` tells
  // CDK to omit DeploymentCircuitBreaker from the template entirely.
  const circuitBreaker: ecs.DeploymentCircuitBreaker | undefined = props.profile === 'breaker'
    ? { enable: true, rollback: false }
    : undefined;

  const service = new ecs.FargateService(scope, id, {
    cluster: props.cluster,
    taskDefinition: props.taskDefinition,
    desiredCount: 1,
    assignPublicIp: true,
    vpcSubnets: props.vpcSubnets,
    securityGroups: [props.securityGroup],
    deploymentStrategy: ecs.DeploymentStrategy.CANARY,
    canaryConfiguration: {
      stepPercent: 10,
      stepBakeTime: Duration.minutes(5),
    },
    bakeTime: Duration.minutes(5),
    deploymentAlarms: {
      alarmNames: props.deploymentAlarmNames,
      behavior: ALARM_BEHAVIOR[props.profile],
    },
    circuitBreaker,
    minHealthyPercent: 100,
  });

  const target = service.loadBalancerTarget({
    containerName: props.containerName,
    containerPort: props.containerPort,
    alternateTarget: new ecs.AlternateTarget('AlternateTarget', {
      alternateTargetGroup: props.greenTargetGroup,
      productionListener: ecs.ListenerRuleConfiguration.applicationListenerRule(
        props.productionListenerRule,
      ),
    }),
  });
  target.attachToApplicationTargetGroup(props.blueTargetGroup);

  return service;
}
