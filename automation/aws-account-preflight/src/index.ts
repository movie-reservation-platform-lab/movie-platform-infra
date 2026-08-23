/** Public programmatic seams for the account-preflight automation package. */

export { runCli } from './cli';
export {
  validateAwsCallerIdentity,
  type ValidatedAwsCallerIdentity,
} from './aws-cli';
export { PreflightFailure } from './preflight-error';
export {
  validateAwsAccess,
  type ValidatedAwsAccess,
  type ValidatedAwsConfigFiles,
} from './preflight';
export type { AwsTarget } from './target-schema';
