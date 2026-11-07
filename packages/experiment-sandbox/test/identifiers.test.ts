import {
  SANDBOX_CASE_IDS,
  SANDBOX_STEP_IDS,
  sandboxTaskFamily,
  sandboxTaskDefinitionOutputKey,
  sandboxTaskFamilies,
} from '../src';

test('registered cases and steps match the protected launcher contract', () => {
  expect(SANDBOX_CASE_IDS).toEqual(['good', 'blocked', 'bad']);
  expect(SANDBOX_STEP_IDS).toEqual(['gate', 'watch', 'release']);
});

test.each([
  ['good', 'gate', 'GoodGateTaskDefinitionArn'],
  ['blocked', 'release', 'BlockedReleaseTaskDefinitionArn'],
  ['bad', 'watch', 'BadWatchTaskDefinitionArn'],
] as const)('task family and output name are stable for %s/%s', (caseId, stepId, output) => {
  expect(sandboxTaskFamily('exp-example', caseId, stepId)).toBe(`exp-example-${caseId}-${stepId}`);
  expect(sandboxTaskDefinitionOutputKey(caseId, stepId)).toBe(output);
});

test('cleanup family allowlist includes all nine recipes plus recommendation and delegate exactly once', () => {
  expect(sandboxTaskFamilies('exp-example')).toEqual([
    'exp-example-recommendation',
    'exp-example-delegate',
    'exp-example-good-gate',
    'exp-example-good-watch',
    'exp-example-good-release',
    'exp-example-blocked-gate',
    'exp-example-blocked-watch',
    'exp-example-blocked-release',
    'exp-example-bad-gate',
    'exp-example-bad-watch',
    'exp-example-bad-release',
  ]);
});
