// Public surface of the experiment-sandbox contract. Each module has one job:
//   sandbox-limits.ts    fixed budget, lease and launch limits
//   field-schemas.ts     reusable field rules (bounded text, timestamps, IDs, images)
//   sandbox-record.ts    record schemas and the types inferred from them
//   parse-record.ts      parsing untrusted JSON, plus rules spanning sections
//   sandbox-config.ts    the CDK app's input file and the operator's render inputs
//   control-state.ts     launch requests, lease and watch rows, cleanup requests
//   schema-parse.ts      turning zod errors into field-named messages
//   admission-policy.ts  when a sandbox may be created or used
//   identifiers.ts       task names shared by provisioning, launch and cleanup

export { admissionBlockers, allocationBlockers, assertAdmission } from './admission-policy';

export {
  parseRetiredControls,
  parseSandboxRecord,
  type ControlStackLocation,
} from './parse-record';

export { isDigestImageReference } from './field-schemas';

export { HOUR_MS, MINUTE_MS, SANDBOX_LIMITS, type SandboxLimits } from './sandbox-limits';

export {
  parseSandboxConfig,
  parseSandboxRenderInputs,
  type SandboxConfig,
  type SandboxRenderInputs,
} from './sandbox-config';

export {
  SANDBOX_ACCOUNT_STATES,
  type CleanupStatus,
  type CostForecast,
  type HarnessEntitlement,
  type RetiredControlResource,
  type RetiredControls,
  type SandboxAccount,
  type SandboxAccountState,
  type SandboxInventory,
  type SandboxLease,
  type SandboxRecord,
  type TrialImages,
} from './sandbox-record';

export {
  CLEANUP_BLOCKERS,
  newLeaseRow,
  parseCleanupRequest,
  parseCleanupResult,
  scheduledCleanupRequest,
  parseLaunchRequest,
  parseLeaseRow,
  parseWatchRow,
  TASK_STATUSES,
  type CleanupRequest,
  type CleanupResult,
  type FixedTaskRequest,
  type LaunchRequest,
  type LeaseRow,
  type Reservation,
  type TaskStatus,
  type WatchRow,
} from './control-state';

export {
  SANDBOX_CASE_IDS,
  SANDBOX_STEP_IDS,
  SANDBOX_PROBE_METRIC,
  sandboxDelegateTaskFamily,
  sandboxRecommendationTaskFamily,
  sandboxTaskFamily,
  sandboxTaskDefinitionOutputKey,
  sandboxTrialTaskFamilies,
  sandboxTaskFamilies,
  type SandboxCaseId,
  type SandboxStepId,
} from './identifiers';
