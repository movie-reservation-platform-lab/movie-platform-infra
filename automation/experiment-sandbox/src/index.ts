/** Public surface of the operator workspace, for scripts that drive it programmatically. */

export { runCli } from './cli';

export {
  admitLease,
  captureControlManifest,
  cleanupSandbox,
  createAccount,
  finalizeControlManifest,
  reconcileAccount,
  refreshAccountStatus,
  retireAccount,
  RequestNotSubmittedError,
} from './lifecycle';

export type { AccountResult, CleanupResult, RecordStore, SandboxCloud } from './lifecycle';
