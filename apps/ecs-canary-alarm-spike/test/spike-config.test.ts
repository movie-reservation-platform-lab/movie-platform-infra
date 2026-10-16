import { EcsCanarySpikeConfigError, parseEcsCanarySpikeConfig } from '../lib/spike-config';

function contextOf(values: Record<string, unknown>): (key: string) => unknown {
  return (key) => values[key];
}

const REQUIRED = {
  allowedIngressPrefixListId: 'pl-0123456789abcdef0',
  expiresOn: '2026-12-31',
};

test('applies defaults for the optional run toggles', () => {
  expect(parseEcsCanarySpikeConfig(contextOf(REQUIRED))).toEqual({
    allowedIngressPrefixListId: 'pl-0123456789abcdef0',
    profile: 'halt',
    bridgeMissingData: 'notBreaching',
    deploymentAlarmSet: 'all',
    expiresOn: '2026-12-31',
  });
});

test('accepts every documented run toggle', () => {
  expect(parseEcsCanarySpikeConfig(contextOf({
    ...REQUIRED,
    spikeProfile: 'breaker',
    bridgeMissingData: 'missing',
    deploymentAlarmSet: 'members',
  }))).toMatchObject({
    profile: 'breaker',
    bridgeMissingData: 'missing',
    deploymentAlarmSet: 'members',
  });
});

test.each([
  ['a missing prefix list', { expiresOn: '2026-12-31' }],
  ['a malformed prefix list', { ...REQUIRED, allowedIngressPrefixListId: 'pl-XYZ' }],
  ['an unknown profile', { ...REQUIRED, spikeProfile: 'rollback' }],
  ['a non-string profile', { ...REQUIRED, spikeProfile: true }],
  ['an unknown missing-data treatment', { ...REQUIRED, bridgeMissingData: 'ignore' }],
  ['an unknown alarm set', { ...REQUIRED, deploymentAlarmSet: 'composite' }],
  ['a missing expiry date', { allowedIngressPrefixListId: 'pl-0123456789abcdef0' }],
  ['an invalid expiry date', { ...REQUIRED, expiresOn: '2026-13-45' }],
])('rejects %s', (_description, values) => {
  expect(() => parseEcsCanarySpikeConfig(contextOf(values))).toThrow(EcsCanarySpikeConfigError);
});
