import { parseSandboxConfig, parseSandboxRenderInputs } from '../src';

const IMAGE = 'public.ecr.aws/example/recommendation@sha256:';

/** A config that passes every rule. */
function validConfig(): Record<string, unknown> {
  return {
    experimentId: 'exp-synthetic',
    accountId: '111111111111',
    region: 'eu-central-1',
    expiresAt: '2030-01-01T04:00:00Z',
    launchCutoffAt: '2030-01-01T03:00:00Z',
    allowedIngressCidrs: ['192.0.2.1/32'],
    goodImage: `${IMAGE}${'a'.repeat(64)}`,
    badImage: `${IMAGE}${'b'.repeat(64)}`,
    toolsImage: `${IMAGE}${'c'.repeat(64)}`,
    delegateImage: `${IMAGE}${'d'.repeat(64)}`,
    delegateTokenSecretArn:
      'arn:aws:secretsmanager:eu-central-1:111111111111:secret:experiment/exp-synthetic/delegate-AbCd12',
    harnessAccountId: 'synthetic-account',
    harnessManagerUrl: 'https://app.harness.io',
  };
}

test('a valid config parses into a frozen copy', () => {
  const config = parseSandboxConfig(validConfig());

  expect(config.experimentId).toBe('exp-synthetic');
  expect(Object.isFrozen(config)).toBe(true);
});

test.each([
  [
    'the whole internet as ingress',
    { allowedIngressCidrs: ['0.0.0.0/0'] },
    /allowedIngressCidrs\.0/,
  ],
  ['an invalid IPv4 address', { allowedIngressCidrs: ['256.0.0.1/32'] }, /allowedIngressCidrs\.0/],
  [
    'more than four addresses',
    { allowedIngressCidrs: Array(5).fill('192.0.2.1/32') },
    /allowedIngressCidrs/,
  ],
  [
    'an image pinned by tag',
    { goodImage: 'example:latest' },
    /goodImage: must be an image pinned by sha256 digest/,
  ],
  [
    'identical good and bad images',
    { badImage: `${IMAGE}${'a'.repeat(64)}` },
    /badImage: must differ from goodImage/,
  ],
  [
    'a secret in another account',
    {
      delegateTokenSecretArn:
        'arn:aws:secretsmanager:eu-central-1:222222222222:secret:experiment/exp-synthetic/delegate-AbCd12',
    },
    /delegateTokenSecretArn/,
  ],
  [
    'a cutoff two hours before expiry',
    { launchCutoffAt: '2030-01-01T02:00:00Z' },
    /launchCutoffAt: must be exactly 1 hour/,
  ],
  [
    'a timestamp without a zone',
    { expiresAt: '2030-01-01T04:00:00' },
    /expiresAt: must be a UTC ISO 8601 timestamp/,
  ],
  ['another region', { region: 'us-east-1' }, /region/],
  [
    'a Harness URL outside harness.io',
    { harnessManagerUrl: 'https://app.harness.io.attacker.example' },
    /harnessManagerUrl/,
  ],
  ['a plain-http Harness URL', { harnessManagerUrl: 'http://app.harness.io' }, /harnessManagerUrl/],
  [
    'an extra override field',
    { desiredCount: 100 },
    /sandboxConfig contains unknown key desiredCount/,
  ],
])('rejects %s', (_rule, change, error) => {
  expect(() => parseSandboxConfig({ ...validConfig(), ...change })).toThrow(error);
});

test.each([
  'experimentId',
  'accountId',
  'region',
  'expiresAt',
  'launchCutoffAt',
  'delegateTokenSecretArn',
])('rejects a single-element array for %s instead of coercing it to a string', (field) => {
  const config = validConfig();

  expect(() => parseSandboxConfig({ ...config, [field]: [config[field]] })).toThrow(
    new RegExp(`^${field}:`),
  );
});

test('render inputs accept exactly the operator-supplied fields', () => {
  const config = validConfig();

  const inputs = {
    allowedIngressCidrs: config.allowedIngressCidrs,
    toolsImage: config.toolsImage,
    delegateImage: config.delegateImage,
    delegateTokenSecretArn: config.delegateTokenSecretArn,
    harnessAccountId: config.harnessAccountId,
    harnessManagerUrl: config.harnessManagerUrl,
  };

  expect(parseSandboxRenderInputs(inputs)).toEqual(inputs);

  expect(() => parseSandboxRenderInputs({ ...inputs, accountId: '999999999999' })).toThrow(
    /inputs contains unknown key accountId/,
  );
});
