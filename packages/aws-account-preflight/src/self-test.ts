import { runAwsIdentitySelfTest } from './aws-cli';
import { fail } from './preflight-error';
import { parseAwsTargetJson } from './target-schema';

/**
 * Run dependency-free wiring checks used by the delivered CLI self-test.
 *
 * @internal
 */
export function runSelfTest(): void {
  const target = parseAwsTargetJson(
    JSON.stringify({
      profile: 'movie-platform-demo',
      region: 'eu-central-1',
      accountId: '111111111111',
      expectedRoleName: 'AWSReservedSSO_AdministratorAccess_0123456789abcdef',
    }),
  );

  if (target.accountId !== '111111111111') {
    fail('internal self-test failed');
  }

  runAwsIdentitySelfTest();
}
