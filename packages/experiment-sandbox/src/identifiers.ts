// Names shared by the CDK app (which creates task definitions), the launcher
// (which starts them) and cleanup (which removes them). Building every name
// from these functions keeps the three sides from drifting apart.

/**
 * The trial cases the launcher accepts.
 *
 * `good` must release, `blocked` must stop at the gate, and `bad` must deploy and then be
 * reverted by ECS.
 */
export const SANDBOX_CASE_IDS = Object.freeze(['good', 'blocked', 'bad'] as const);

/** The steps of one trial case, in the order they run. */
export const SANDBOX_STEP_IDS = Object.freeze(['gate', 'watch', 'release'] as const);

/**
 * Probe-health metric.
 *
 * The watch task publishes it and the ECS deployment alarm reads it, so both sides must
 * use exactly these names.
 */
export const SANDBOX_PROBE_METRIC = Object.freeze({
  namespace: 'MoviePlatform/ExperimentSandbox',
  metricName: 'ProbeFailure',
} as const);

export type SandboxCaseId = (typeof SANDBOX_CASE_IDS)[number];

export type SandboxStepId = (typeof SANDBOX_STEP_IDS)[number];

/**
 * ECS task definition family for one trial step, such as `exp-demo-good-gate`.
 *
 * @param experimentId - the record's `id`, which prefixes every resource name
 */
export function sandboxTaskFamily(
  experimentId: string,
  caseId: SandboxCaseId,
  stepId: SandboxStepId,
): string {
  return `${experimentId}-${caseId}-${stepId}`;
}

/**
 * CloudFormation output key that carries one step's task definition ARN, such as
 * `GoodGateTaskDefinitionArn`.
 *
 * The workload stack writes these outputs and the launcher reads them.
 */
export function sandboxTaskDefinitionOutputKey(
  caseId: SandboxCaseId,
  stepId: SandboxStepId,
): string {
  return `${capitalize(caseId)}${capitalize(stepId)}TaskDefinitionArn`;
}

/** The nine trial step task definition families: one per case and step. */
export function sandboxTrialTaskFamilies(experimentId: string): readonly string[] {
  return SANDBOX_CASE_IDS.flatMap((caseId) =>
    SANDBOX_STEP_IDS.map((stepId) => sandboxTaskFamily(experimentId, caseId, stepId)),
  );
}

/** Task definition family of the recommendation service, such as `exp-demo-recommendation`. */
export function sandboxRecommendationTaskFamily(experimentId: string): string {
  return `${experimentId}-recommendation`;
}

/** Task definition family of the Harness delegate, such as `exp-demo-delegate`. */
export function sandboxDelegateTaskFamily(experimentId: string): string {
  return `${experimentId}-delegate`;
}

/**
 * Every task definition family the sandbox creates: the recommendation service, the
 * Harness delegate, and one family per case and step.
 *
 * Cleanup only touches task definitions whose family is in this list.
 */
export function sandboxTaskFamilies(experimentId: string): readonly string[] {
  return [
    sandboxRecommendationTaskFamily(experimentId),
    sandboxDelegateTaskFamily(experimentId),
    ...sandboxTrialTaskFamilies(experimentId),
  ];
}

/** Upper-cases the first letter: `gate` becomes `Gate`. */
function capitalize(word: string): string {
  return word[0].toUpperCase() + word.slice(1);
}
