// The config schema and parser live in the shared contract package, so the
// operator CLI (which renders this file) and this app (which reads it) apply the
// same rules. This module adds the app-only part: physical resource names.
import type { SandboxConfig } from '@movie-platform/experiment-sandbox';

export { parseSandboxConfig, type SandboxConfig } from '@movie-platform/experiment-sandbox';

/**
 * Physical names shared by the control stack, the workload stack, and the CDK app.
 *
 * The control stack writes IAM policies against names the workload stack creates
 * (for example `iam:PassRole` on the trial roles). Building both sides from this
 * one function keeps them from drifting apart.
 */
export function sandboxResourceNames(config: SandboxConfig) {
  const prefix = config.experimentId;

  return {
    controlStack: `${prefix}-control`,
    workloadStack: `${prefix}-workload`,
    cluster: `${prefix}-cluster`,
    recommendationService: `${prefix}-recommendation`,
    recommendationTaskFamily: `${prefix}-recommendation`,
    delegateService: `${prefix}-delegate`,
    delegateTaskFamily: `${prefix}-delegate`,
    roles: {
      execution: `${prefix}-execution`,
      workload: `${prefix}-workload`,
      gate: `${prefix}-gate`,
      watch: `${prefix}-watch`,
      release: `${prefix}-release`,
      delegate: `${prefix}-delegate`,
      delegateExecution: `${prefix}-delegate-execution`,
    },
  } as const;
}

export type SandboxResourceNames = ReturnType<typeof sandboxResourceNames>;
