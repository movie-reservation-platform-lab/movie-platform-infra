#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MovieReservationWorkloadStack } from '../lib/infra-stack';
import { resolvePlatformConfig } from '../lib/config/platform-config';

const app = new cdk.App();

const deploymentTarget = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const platformConfig = resolvePlatformConfig(
  {
    allowedIngressPrefixListId: app.node.tryGetContext('allowedIngressPrefixListId'),
    applicationImageReference: app.node.tryGetContext('applicationImageReference'),
    applicationServiceVersion: app.node.tryGetContext('applicationServiceVersion'),
    reservationWebImageReference: app.node.tryGetContext('reservationWebImageReference'),
    reservationWebServiceVersion: app.node.tryGetContext('reservationWebServiceVersion'),
    reservationAgentImageReference: app.node.tryGetContext('reservationAgentImageReference'),
    reservationAgentServiceVersion: app.node.tryGetContext('reservationAgentServiceVersion'),
    reservationMcpImageReference: app.node.tryGetContext('reservationMcpImageReference'),
    reservationMcpServiceVersion: app.node.tryGetContext('reservationMcpServiceVersion'),
    recommendationMcpImageReference: app.node.tryGetContext('recommendationMcpImageReference'),
    recommendationMcpServiceVersion: app.node.tryGetContext('recommendationMcpServiceVersion'),
    recommendationServiceImageReference: app.node.tryGetContext('recommendationServiceImageReference'),
    recommendationServiceVersion: app.node.tryGetContext('recommendationServiceVersion'),
    enableEcsExec: app.node.tryGetContext('enableEcsExec'),
    metricsExportIntervalSeconds: app.node.tryGetContext('metricsExportIntervalSeconds'),
    demoAuthEnabled: app.node.tryGetContext('demoAuthEnabled'),
    demoAuthSecretArn: app.node.tryGetContext('demoAuthSecretArn'),
  },
  deploymentTarget,
);

new MovieReservationWorkloadStack(app, 'MovieReservationWorkloadStack', {
  env: deploymentTarget,
  platformConfig,
});
