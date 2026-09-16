import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as discovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

interface PrivateTempoProps {
  readonly vpc: ec2.Vpc;
  readonly cluster: ecs.Cluster;
  readonly workloadSubnets: ec2.SubnetSelection;
  readonly applicationSecurityGroup: ec2.SecurityGroup;
  readonly endpointSecurityGroup: ec2.SecurityGroup;
  readonly repositoryRoot: string;
}

/** Disposable monolith. Its restart must not restart the application task. */
export class PrivateTempo extends Construct {
  readonly otlpEndpoint = 'tempo.aws-demo.internal:4317';
  readonly queryUrl = 'http://tempo.aws-demo.internal:3200';
  readonly grafanaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: PrivateTempoProps) {
    super(scope, id);
    this.grafanaSecurityGroup = new ec2.SecurityGroup(this, 'GrafanaConnection', {
      vpc: props.vpc, description: 'AMG outbound private data-source connection; no inbound rules',
    });
    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc, description: 'Tempo: collector ingestion and Grafana query only',
    });
    securityGroup.addIngressRule(props.applicationSecurityGroup, ec2.Port.tcp(4317), 'ADOT OTLP ingestion');
    securityGroup.addIngressRule(this.grafanaSecurityGroup, ec2.Port.tcp(3200), 'AMG query API');
    props.endpointSecurityGroup.addIngressRule(securityGroup, ec2.Port.tcp(443), 'Tempo image pulls and logs');
    props.endpointSecurityGroup.addIngressRule(this.grafanaSecurityGroup, ec2.Port.tcp(443), 'AMG AWS data sources');

    const namespace = new discovery.PrivateDnsNamespace(this, 'Namespace', {
      name: 'aws-demo.internal', vpc: props.vpc,
    });
    const image = new ecrAssets.DockerImageAsset(this, 'Image', {
      directory: path.join(props.repositoryRoot, 'tempo'), platform: ecrAssets.Platform.LINUX_AMD64,
    });
    const task = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: 'aws-demo-tempo', cpu: 512, memoryLimitMiB: 1024,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    (task.node.defaultChild as ecs.CfnTaskDefinition).overrideLogicalId('TempoTaskDefinition');
    task.addContainer('Tempo', {
      containerName: 'tempo', image: ecs.ContainerImage.fromDockerImageAsset(image),
      essential: true, user: '10001', memoryLimitMiB: 1024,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'tempo', logGroup: new logs.LogGroup(this, 'Logs', {
          retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      portMappings: [{ containerPort: 3200 }, { containerPort: 4317 }],
      stopTimeout: cdk.Duration.seconds(30),
      healthCheck: {
        command: ['CMD', '/busybox', 'wget', '-q', '-T', '3', '-O', '/dev/null', 'http://127.0.0.1:3200/ready'],
        interval: cdk.Duration.seconds(15), timeout: cdk.Duration.seconds(5),
        retries: 3, startPeriod: cdk.Duration.seconds(60),
      },
    });
    const service = new ecs.FargateService(this, 'Service', {
      serviceName: 'aws-demo-tempo', cluster: props.cluster, taskDefinition: task,
      desiredCount: 1, assignPublicIp: false, vpcSubnets: props.workloadSubnets,
      securityGroups: [securityGroup], circuitBreaker: { rollback: true },
      minHealthyPercent: 0, maxHealthyPercent: 100,
      cloudMapOptions: { name: 'tempo', cloudMapNamespace: namespace, dnsRecordType: discovery.DnsRecordType.A, dnsTtl: cdk.Duration.seconds(10) },
    });
    (service.node.defaultChild as ecs.CfnService).overrideLogicalId('TempoService');

    const stack = cdk.Stack.of(this);
    new cdk.CfnOutput(stack, 'TempoQueryUrl', { value: this.queryUrl });
    new cdk.CfnOutput(stack, 'TempoOtlpEndpoint', { value: this.otlpEndpoint });
    new cdk.CfnOutput(stack, 'GrafanaVpcId', { value: props.vpc.vpcId });
    new cdk.CfnOutput(stack, 'GrafanaVpcSubnetIds', {
      value: cdk.Fn.join(',', props.vpc.selectSubnets({ subnetGroupName: 'workload' }).subnetIds),
    });
    new cdk.CfnOutput(stack, 'GrafanaVpcSecurityGroupId', { value: this.grafanaSecurityGroup.securityGroupId });
  }
}
