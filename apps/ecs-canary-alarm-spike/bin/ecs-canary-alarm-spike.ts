import { App } from 'aws-cdk-lib';
import { EcsCanarySpikeImageRepositoryStack } from '../lib/image-repository-stack';
import { EcsCanarySpikeServiceStack } from '../lib/service-stack';
import { parseEcsCanarySpikeConfig } from '../lib/spike-config';

const SPIKE_REGION = 'eu-central-1';

const app = new App();
const config = parseEcsCanarySpikeConfig((key) => app.node.tryGetContext(key));
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: SPIKE_REGION };

const repositoryStack = new EcsCanarySpikeImageRepositoryStack(
  app,
  'EcsCanarySpikeImageRepositoryStack',
  { env, description: 'Disposable fixture image repository for the ECS canary spike (infra#100)' },
);

new EcsCanarySpikeServiceStack(app, 'EcsCanarySpikeServiceStack', {
  env,
  description: 'Disposable ECS-native canary deployment-alarm spike (infra#100)',
  config,
  repository: repositoryStack.repository,
});
