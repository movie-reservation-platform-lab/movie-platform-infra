import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';
import type { SpikeProfile } from './spike-config';

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
 * ENGINEER-OWNED SLICE (hybrid teaching, infra#100).
 *
 * The body below is a deliberately minimal ROLLING placeholder, so the rest
 * of the spike synthesizes while this slice is in progress. Replace it with
 * the ECS-native canary deployment wiring described in
 * docs/plans/ecs-canary-deployment-alarm-spike.md (§2 and §3).
 *
 * Done when `npm test --workspace @movie-platform/ecs-canary-alarm-spike`
 * passes, including test/canary-service.test.ts.
 */
export function createCanaryService(
  scope: Construct,
  id: string,
  props: CanaryServiceProps,
): ecs.FargateService {
  const service = new ecs.FargateService(scope, id, {
    cluster: props.cluster,
    taskDefinition: props.taskDefinition,
    desiredCount: 1,
    assignPublicIp: true,
    vpcSubnets: props.vpcSubnets,
    securityGroups: [props.securityGroup],
  });
  service.attachToApplicationTargetGroup(props.blueTargetGroup);
  return service;
}
