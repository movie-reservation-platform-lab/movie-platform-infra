import { PreflightFailure, type ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';

import { EXIT_CODES, runCli, type CliDependencies } from '../../src/cli/cli';
import { parseRunConfig, type RunConfig } from '../../src/cli/run-config';
import type { ComparisonDependencies } from '../../src/core/run-comparison';
import { FakeClock, availableAfter, fakeComparisonDependencies, ID_ACCEPTED } from '../support/fakes';

const WORKLOAD = '333333333333';
const AUDIT = '222222222222';

const RUN_CONFIG: RunConfig = parseRunConfig(JSON.stringify({
  schema: 'audit-transport-comparison-run/v1',
  endpoint: 'https://demo.example.test',
  credentialsFile: '/private/auth.json',
  workloadTargetFile: '/private/workload-target.json',
  auditTargetFile: '/private/audit-target.json',
  attempts: { accepted: 1, rejected: 1 },
  legacyStore: { workGroup: 'movie-platform-audit', database: 'movie_platform_audit', table: 'authentication' },
  securityLakeStore: { workGroup: 'movie-platform-audit-investigation', crawlerName: 'sl-crawler', refreshCatalog: true },
  deliveryHealth: {
    deadLetterQueueUrl: `https://sqs.eu-central-1.amazonaws.com/${AUDIT}/dlq`,
    alarmNamePrefix: 'AuditAccountIngestionStack-AuditDeliveryAlarms',
  },
  timeoutSeconds: 600,
  output: '/private/evidence/result.json',
}));

function access(accountId: string): ValidatedAwsAccess {
  return {
    target: { profile: 'p', region: 'eu-central-1', accountId, expectedRoleName: 'r' },
    permissionSet: 'AdministratorAccess',
    configFiles: { configFilepath: '/h/.aws/config', credentialsFilepath: '/h/.aws/credentials' },
  };
}

interface HarnessOptions {
  readonly config?: RunConfig;
  readonly auditAccountId?: string;
  readonly comparison?: (clock: FakeClock) => ComparisonDependencies;
  readonly overrides?: Partial<CliDependencies>;
}

function harness(options: HarnessOptions = {}) {
  const output = { stdout: '', stderr: '' };
  const evidence: string[] = [];
  const dependencies: CliDependencies = {
    loadRunConfig: () => options.config ?? RUN_CONFIG,
    loadCredentials: () => ({ username: 'demo-user', password: 'demo-password' }),
    validateAccess: (targetFile) => access(targetFile.includes('workload') ? WORKLOAD : options.auditAccountId ?? AUDIT),
    verifySdkIdentity: async () => undefined,
    createComparisonDependencies: () => (options.comparison ?? fakeComparisonDependencies)(new FakeClock()),
    writeEvidence: (_path, contents) => { evidence.push(contents); },
    repositoryRoot: '/repo/movie-platform-infra',
    ...options.overrides,
  };
  const streams = {
    stdout: (text: string) => { output.stdout += text; },
    stderr: (text: string) => { output.stderr += text; },
  };
  return {
    output,
    evidence,
    run: (args: string[] = ['--run-file', '/private/run.json'], environment: NodeJS.ProcessEnv = {}) =>
      runCli(args, environment, streams, dependencies),
  };
}

describe('runCli', () => {
  it('prints usage for --help without touching AWS', async () => {
    const { output, run } = harness();

    await expect(run(['--help'])).resolves.toBe(EXIT_CODES.passed);
    expect(output.stdout).toContain('Usage: npm run compare:audit-transports');
  });

  it('writes the evidence and prints a summary without the password', async () => {
    const { output, evidence, run } = harness();

    await expect(run()).resolves.toBe(EXIT_CODES.passed);
    expect(JSON.parse(evidence[0] ?? '{}').status).toBe('passed');
    expect(output.stdout).toContain('PASSED');
    expect(output.stdout + evidence.join('')).not.toContain('demo-password');
  });

  it('exits 1 when the comparison fails', async () => {
    const { run } = harness({
      comparison: (clock) => fakeComparisonDependencies(clock, {
        stores: { securityLake: availableAfter(clock, {}), legacy: availableAfter(clock, { [ID_ACCEPTED]: 0 }) },
      }),
    });

    await expect(run()).resolves.toBe(EXIT_CODES.comparisonFailed);
  });

  describe('exits 2 before any login when the input is unusable', () => {
    it.each([
      ['no run file', harness, ['--unknown'], {}, 'unsupported arguments'],
      ['a missing --run-file', harness, [], {}, '--run-file is required'],
      ['identical accounts', () => harness({ auditAccountId: WORKLOAD }), undefined, {}, 'must be different accounts'],
      ['a DLQ in another account', () => harness({ auditAccountId: '444444444444' }), undefined, {}, 'must belong to the audit target account'],
      ['an endpoint override', harness, undefined, { AWS_ENDPOINT_URL_ATHENA: 'http://x' }, 'AWS_ENDPOINT_URL* overrides are not allowed'],
      ['output inside the repository', () => harness({ config: { ...RUN_CONFIG, output: '/repo/movie-platform-infra/.local/r.json' } }), undefined, {}, 'outside this public repository'],
      ['a failed preflight', () => harness({ overrides: { validateAccess: () => { throw new PreflightFailure('SSO session expired'); } } }), undefined, {}, 'SSO session expired'],
    ] as const)('%s', async (_label, makeHarness, args, environment, message) => {
      const { output, evidence, run } = makeHarness();

      await expect(run(args === undefined ? undefined : [...args], environment)).resolves.toBe(EXIT_CODES.invalidInput);
      expect(output.stderr).toContain(message);
      expect(evidence).toEqual([]);
    });
  });

  it('exits 3 and keeps the summary when the evidence cannot be written', async () => {
    const { output, run } = harness({ overrides: { writeEvidence: () => { throw new Error("EEXIST: open '/home/jane/evidence.json'"); } } });

    await expect(run()).resolves.toBe(EXIT_CODES.unexpectedError);
    expect(output.stdout).toContain('PASSED');
    expect(output.stderr).toContain("evidence not written: EEXIST: open '<path>'");
  });

  it('never prints AWS identity details from store errors', async () => {
    const denied = Object.assign(
      new Error(`User: arn:aws:sts::${AUDIT}:assumed-role/AWSReservedSSO_Admin_x/jane@example.com is not authorized`),
      { name: 'AccessDeniedException' },
    );
    const { output, evidence, run } = harness({
      comparison: (clock) => {
        const securityLake = availableAfter(clock, {});
        securityLake.failure = denied;
        return fakeComparisonDependencies(clock, { stores: { securityLake, legacy: availableAfter(clock, {}) } });
      },
    });

    await run();
    expect(output.stdout).toContain('AccessDeniedException: User: <arn> is not authorized');
    expect(output.stdout + evidence.join('')).not.toMatch(/jane@example\.com|arn:aws|AWSReservedSSO/);
  });
});
