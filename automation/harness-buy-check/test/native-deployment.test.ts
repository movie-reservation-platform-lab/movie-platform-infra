import { nativeDeploymentState } from '../src/native-deployment';

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
  ).toBe('FAILED');

  expect(
    nativeDeploymentState(
      [{ status: 'SUCCESSFUL', createdAt: '2026-10-24T10:00:00Z' }],
      'old',
      'old',
    ),
  ).toBe('ACTIVE');
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
