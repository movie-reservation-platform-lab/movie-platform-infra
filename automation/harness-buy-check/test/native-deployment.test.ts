import { DeploymentHistory, nativeDeploymentState } from '../src/native-deployment';

test('native canary completion uses service deployment status, without legacy rolloutState', () => {
  expect(
    nativeDeploymentState(
      [{ status: 'IN_PROGRESS', createdAt: '2026-10-24T10:00:00Z' }],
      'new',
      'old',
    ),
  ).toBe('ACTIVE');

  expect(
    nativeDeploymentState(
      [{ status: 'SUCCESSFUL', createdAt: '2026-10-24T10:00:00Z' }],
      'new',
      'old',
    ),
  ).toBe('COMPLETED');
});

test('only native rollback-successful plus original task revision identifies revert', () => {
  expect(
    nativeDeploymentState(
      [{ status: 'ROLLBACK_SUCCESSFUL', createdAt: '2026-10-24T10:00:00Z' }],
      'old',
      'old',
    ),
  ).toBe('REVERTED');

  expect(
    nativeDeploymentState(
      [{ status: 'ROLLBACK_SUCCESSFUL', createdAt: '2026-10-24T10:00:00Z' }],
      'new',
      'old',
    ),
  ).toBe('PENDING');

  expect(
    nativeDeploymentState(
      [{ status: 'SUCCESSFUL', createdAt: '2026-10-24T10:00:00Z' }],
      'old',
      'old',
    ),
  ).toBe('PENDING');
});

test('empty/unknown native deployment state cannot become completion; every in-flight row blocks', () => {
  expect(() => nativeDeploymentState([], 'new')).toThrow();

  expect(() =>
    nativeDeploymentState([{ status: 'MISSING', createdAt: '2026-10-24T10:00:00Z' }], 'new'),
  ).toThrow();

  expect(
    nativeDeploymentState(
      [
        { status: 'SUCCESSFUL', createdAt: '2026-10-24T10:00:00Z' },
        { status: 'ROLLBACK_IN_PROGRESS', createdAt: '2026-10-24T09:00:00Z' },
      ],
      'new',
    ),
  ).toBe('ACTIVE');
});

test('Build 6 waits for its own deployment after an earlier rollback', () => {
  const previous = {
    serviceDeploymentArn: 'prior-rollback',
    status: 'ROLLBACK_SUCCESSFUL',
    createdAt: '2026-10-24T10:00:00Z',
  };

  const candidate = {
    serviceDeploymentArn: 'bad-candidate',
    status: 'IN_PROGRESS',
    createdAt: '2026-10-24T10:10:00Z',
  };

  const history = new DeploymentHistory();

  expect(history.observe([previous], 'original')).toBe('COMPLETED');
  expect(history.observe([previous], 'candidate', 'original')).toBe('PENDING');
  expect(history.observe([candidate, previous], 'candidate', 'original')).toBe('ACTIVE');
  candidate.status = 'ROLLBACK_SUCCESSFUL';
  expect(history.observe([candidate, previous], 'candidate', 'original')).toBe('PENDING');
  expect(history.observe([candidate, previous], 'original', 'original')).toBe('REVERTED');

  expect(() =>
    history.observe([{ ...candidate, serviceDeploymentArn: 'unexpected' }], 'original', 'original'),
  ).toThrow('ambiguous');
});
