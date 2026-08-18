import { runPreflightProcess } from './test-support';

test('runs its pure helper self-test without a target file or AWS credentials', () => {
  const result = runPreflightProcess(['--self-test'], {});

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('AWS account preflight self-test passed\n');
});

test.each([['--help'], ['-h']])('prints standard help for %s without loading a target', (argument) => {
  const result = runPreflightProcess([argument], {});

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('Usage: aws-account-preflight [--self-test]');
  expect(result.stdout).toContain('aws-target.json');
});

test('rejects unknown options through the standard Node argument parser', () => {
  const result = runPreflightProcess(['--unknown'], {});

  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(
    'AWS account preflight failed: invalid arguments; run with --help for usage\n',
  );
});

test('rejects mutually exclusive help and self-test options', () => {
  const result = runPreflightProcess(['--help', '--self-test'], {});

  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('--help and --self-test cannot be combined');
});
