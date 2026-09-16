import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { readFileSync } from 'node:fs';
import { MovieReservationWorkloadStack } from '../lib/infra-stack';
import { APPLICATION_COMPONENT_INPUTS, resolvePlatformConfig } from '../lib/config/platform-config';

interface SynthesizedResource {
  readonly Type: string;
  readonly Properties: Record<string, unknown>;
}

const target = { account: '111111111111', region: 'eu-central-1' };
const baseContext = {
  allowedIngressPrefixListId: 'pl-0123456789abcdef0',
  ...Object.fromEntries(APPLICATION_COMPONENT_INPUTS.flatMap(input => [
    [input.imageReferenceKey, `${target.account}.dkr.ecr.${target.region}.amazonaws.com/${input.repositoryName}@sha256:${'a'.repeat(64)}`],
    [input.serviceVersionKey, 'test'],
  ])),
};
function template(enableTempo: unknown = false): Template {
  return Template.fromStack(new MovieReservationWorkloadStack(new cdk.App(), 'Test', {
    env: target, platformConfig: resolvePlatformConfig({ ...baseContext, enableTempo }, target),
  }));
}
test('Tempo is disabled by default and context fails closed', () => {
  const t = template();
  t.resourceCountIs('AWS::ECS::TaskDefinition', 1);
  t.resourceCountIs('AWS::ServiceDiscovery::PrivateDnsNamespace', 0);
  expect(t.toJSON().Outputs.TempoQueryUrl).toBeUndefined();
  expect(() => template('yes')).toThrow('enableTempo');
});
test('enabled Tempo is a separate private task with non-root readiness and stable contracts', () => {
  const t = template(true);
  t.resourceCountIs('AWS::ECS::TaskDefinition', 2);
  t.resourceCountIs('AWS::EC2::NatGateway', 0);
  const resources = t.toJSON().Resources;
  expect(resources.TempoTaskDefinition.Properties).toMatchObject({
    Family: 'aws-demo-tempo', Cpu: '512', Memory: '1024',
    ContainerDefinitions: [expect.objectContaining({ Name: 'tempo', User: '10001',
      HealthCheck: expect.objectContaining({ Command: expect.arrayContaining(['http://127.0.0.1:3200/ready']) }) })],
  });
  expect(resources.TempoService.Properties).toMatchObject({
    ServiceName: 'aws-demo-tempo', DesiredCount: 1,
    DeploymentConfiguration: expect.objectContaining({ MaximumPercent: 100, MinimumHealthyPercent: 0 }),
    NetworkConfiguration: { AwsvpcConfiguration: expect.objectContaining({ AssignPublicIp: 'DISABLED' }) },
  });
  t.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', { Name: 'aws-demo.internal' });
  expect(t.toJSON().Outputs.TempoQueryUrl.Value).toBe('http://tempo.aws-demo.internal:3200');
  expect(t.toJSON().Outputs.GrafanaVpcSubnetIds.Value['Fn::Join'][1]).toHaveLength(2);
  for (const port of [3200, 4317]) {
    const rules = (Object.values(resources) as SynthesizedResource[])
      .filter(resource => resource.Type === 'AWS::EC2::SecurityGroupIngress' && resource.Properties.FromPort === port);
    expect(rules).toHaveLength(1);
    expect(rules[0].Properties.SourceSecurityGroupId).toBeDefined();
    expect(rules[0].Properties.CidrIp).toBeUndefined();
  }
});
test('AMG can reach existing AWS query APIs and only its own AssumeRole target', () => {
  const t = template(true);
  for (const suffix of ['monitoring', 'ec2', 'aps']) {
    t.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: `com.amazonaws.eu-central-1.${suffix}`, PrivateDnsEnabled: true,
    });
  }
  t.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    ServiceName: 'com.amazonaws.eu-central-1.sts',
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
      Action: 'sts:AssumeRole', Resource: { 'Fn::ImportValue': 'MoviePlatformAwsDemo:GrafanaDataAccessRoleArn' },
    })]), Version: '2012-10-17' },
  });
  const json = JSON.stringify(t.toJSON());
  for (const action of ['aps:QueryMetrics', 'xray:BatchGetTraces']) expect(json).toContain(action);
});
test('optional collector overlay keeps X-Ray and bounds failed Tempo export', () => {
  const t = template(true);
  t.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({
      Name: 'adot-collector',
      Command: ['--config=/etc/adot/adot-config.yaml', '--config=/etc/adot/tempo-overlay.yaml'],
      Environment: Match.arrayWith([{ Name: 'TEMPO_OTLP_ENDPOINT', Value: 'tempo.aws-demo.internal:4317' }]),
    })]),
  });
  const overlay = readFileSync('adot-collector/tempo-overlay.yaml', 'utf8');
  expect(overlay).toContain('queue_size: 128');
  expect(overlay).toContain('max_elapsed_time: 15s');
  expect(readFileSync('adot-collector/adot-config.yaml', 'utf8')).toContain('exporters: [awsxray]');
});
