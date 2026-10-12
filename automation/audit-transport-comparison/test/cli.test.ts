import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';

import { runCli, type CliDependencies } from '../src/cli';
import type { ComparisonResult } from '../src/model';
import { FakeClock, TEST_CONFIG, dependencies } from './test-support';

function access(accountId: string): ValidatedAwsAccess {
  return {
    target: { profile: 'p', region: 'eu-central-1', accountId, expectedRoleName: 'r' },
    permissionSet: 'AdministratorAccess',
    configFiles: { configFilepath: '/h/.aws/config', credentialsFilepath: '/h/.aws/credentials' },
  };
}

function harness(auditAccountId = '222222222222') {
  const output = { stdout: '', stderr: '' };
  const written: ComparisonResult[] = [];
  const cliDependencies: CliDependencies = {
    loadRunConfig: () => TEST_CONFIG,
    loadCredentials: () => ({ username: 'demo-user', password: 'demo-password' }),
    validateAccess: (targetFile) => access(targetFile === TEST_CONFIG.workloadTargetFile ? '333333333333' : auditAccountId),
    createComparisonDependencies: () => dependencies(new FakeClock()),
    writeResult: (_path, result) => written.push(result),
  };
  const streams = {
    stdout: (text: string) => { output.stdout += text; },
    stderr: (text: string) => { output.stderr += text; },
  };
  return { output, written, run: (args: string[]) => runCli(args, {}, streams, cliDependencies) };
}

describe('runCli', () => {
  it('prints usage for --help without touching AWS', async () => {
    const { output, run } = harness();

    await expect(run(['--help'])).resolves.toBe(0);
    expect(output.stdout).toContain('Usage: npm run compare:audit-transports');
  });

  it('rejects a missing run file and identical workload/audit accounts with exit code 2', async () => {
    await expect(harness().run([])).resolves.toBe(2);
    const sameAccount = harness('333333333333');
    await expect(sameAccount.run(['--run-file', '/private/run.json'])).resolves.toBe(2);
    expect(sameAccount.output.stderr).toContain('must be different accounts');
  });

  it('writes the evidence and prints a summary without credentials', async () => {
    const { output, written, run } = harness();

    await expect(run(['--run-file', '/private/run.json'])).resolves.toBe(0);
    expect(written[0]?.status).toBe('passed');
    expect(output.stdout).toContain('PASSED');
    expect(output.stdout + JSON.stringify(written)).not.toContain('demo-password');
  });
});
