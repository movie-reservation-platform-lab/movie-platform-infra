// Public surface of the experiment-sandbox contract. Each module has one job:
//   sandbox-limits.ts    fixed budget, lease and launch limits
//   field-schemas.ts     reusable field rules (bounded text, timestamps, IDs)
//   sandbox-record.ts    record schemas and the types inferred from them
//   parse-record.ts      parsing untrusted JSON, plus rules spanning sections
//   admission-policy.ts  when a sandbox may be created or used
//   identifiers.ts       task names shared by provisioning, launch and cleanup

export { admissionBlockers, allocationBlockers, assertAdmission } from './admission-policy';

export {
  parseRetiredControls,
  parseSandboxRecord,
  type ControlStackLocation,
} from './parse-record';

export { isUtcTimestamp } from './field-schemas';

export { HOUR_MS, MINUTE_MS, SANDBOX_LIMITS, type SandboxLimits } from './sandbox-limits';

export {
  isDigestImageReference,
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
  SANDBOX_CASE_IDS,
  SANDBOX_STEP_IDS,
  SANDBOX_PROBE_METRIC,
  sandboxTaskFamily,
  sandboxTaskDefinitionOutputKey,
  sandboxTaskFamilies,
  type SandboxCaseId,
  type SandboxStepId,
} from './identifiers';
