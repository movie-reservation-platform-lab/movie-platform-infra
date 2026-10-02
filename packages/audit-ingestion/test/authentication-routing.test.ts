import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { buildAuthenticationEventPattern } from '../src/authentication-routing';

const WORKLOAD_ACCOUNT_ID = '333333333333';

/** Synthesize a minimal rule so assertions inspect the emitted AWS contract. */
function createRoutingTemplate(): Template {
  const stack = new Stack(new App(), 'RoutingFixture', {
    env: { account: '222222222222', region: 'eu-central-1' },
  });
  const bus = new EventBus(stack, 'AuditBus');
  new Rule(stack, 'AuthenticationRule', {
    eventBus: bus,
    eventPattern: buildAuthenticationEventPattern(WORKLOAD_ACCOUNT_ID),
  });
  return Template.fromStack(stack);
}

describe('Authentication routing', () => {
  let routingTemplate: Template;

  beforeEach(() => {
    routingTemplate = createRoutingTemplate();
  });

  it('selects the configured workload account and supported Authentication contract', () => {
    routingTemplate.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        account: [WORKLOAD_ACCOUNT_ID],
        source: [
          'movie-platform.reservation-service.audit',
          'movie-platform.reservation-agent.audit',
          'movie-platform.recommendation-service.audit',
        ],
        'detail-type': ['ocsf.authentication.v1'],
        detail: {
          'envelope_version': ['1'],
        },
      },
    });
  });

  it('keeps both accepted and rejected authentication outcomes eligible', () => {
    const pattern = buildAuthenticationEventPattern(WORKLOAD_ACCOUNT_ID);

    expect(pattern.detail?.event?.status_id).toBeUndefined();
    expect(pattern.detail?.event?.status_detail).toBeUndefined();
  });
});
