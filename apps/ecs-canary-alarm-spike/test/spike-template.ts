import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EcsCanarySpikeImageRepositoryStack } from '../lib/image-repository-stack';
import { EcsCanarySpikeServiceStack } from '../lib/service-stack';
import { BOOTSTRAP_RECIPE, type EcsCanarySpikeConfig } from '../lib/spike-config';

export const ENV = { account: '111111111111', region: 'eu-central-1' } as const;

export const DEFAULT_CONFIG: EcsCanarySpikeConfig = {
  allowedIngressPrefixListId: 'pl-0123456789abcdef0',
  profile: 'halt',
  bridgeMissingData: 'notBreaching',
  deploymentAlarmSet: 'all',
  expiresOn: '2026-12-31',
  infraRevision: '1',
  recipeRevision: '1',
  activeTaskDefinitionArn: BOOTSTRAP_RECIPE,
  failInfraDeploy: false,
};

/** Synthesize both spike stacks and return the service stack. */
export function synthServiceStack(overrides: Partial<EcsCanarySpikeConfig> = {}): EcsCanarySpikeServiceStack {
  const app = new App();
  const repositoryStack = new EcsCanarySpikeImageRepositoryStack(app, 'TestRepositoryStack', { env: ENV });
  return new EcsCanarySpikeServiceStack(app, 'TestServiceStack', {
    env: ENV,
    config: { ...DEFAULT_CONFIG, ...overrides },
    repository: repositoryStack.repository,
  });
}

/** Synthesize both spike stacks and return the service stack template. */
export function synthServiceTemplate(overrides: Partial<EcsCanarySpikeConfig> = {}): Template {
  return Template.fromStack(synthServiceStack(overrides));
}

/** Synthesize the repository stack on its own. */
export function synthRepositoryTemplate(): Template {
  const app = new App();
  return Template.fromStack(new EcsCanarySpikeImageRepositoryStack(app, 'TestRepositoryStack', { env: ENV }));
}
