/**
 *
 * The CDK app's input file. The operator CLI renders it from the record plus a
 * small inputs file, and the CDK app parses it again before synth. Both sides
 * call the same schema, so each check stays independent but the rules cannot drift.
 *
 */
import { z } from 'zod';

import {
  awsAccountIdSchema,
  boundedTextSchema,
  digestImageReferenceSchema,
  experimentIdSchema,
  ipv4HostCidrSchema,
  isoTimestampSchema,
  textMatching,
} from './field-schemas';
import { HOUR_MS, SANDBOX_LIMITS } from './sandbox-limits';
import { parseWithSchema } from './schema-parse';

/** Fields the operator supplies in the render inputs file; everything else comes from the record. */
const operatorInputFields = {
  /** 1-4 operator IPv4 `/32` addresses allowed to reach the load balancer. */
  allowedIngressCidrs: z.array(ipv4HostCidrSchema).min(1).max(4).readonly(),
  /** Digest-pinned image that runs the gate, watch, and release steps. */
  toolsImage: digestImageReferenceSchema,
  /** Digest-pinned Harness delegate image. */
  delegateImage: digestImageReferenceSchema,
  /** Secrets Manager ARN of the delegate token, scoped to this experiment. */
  delegateTokenSecretArn: boundedTextSchema,
  /** Harness account identifier the delegate registers with. */
  harnessAccountId: textMatching(/^[A-Za-z0-9_-]{4,80}$/),
  /**
   * Harness manager URL the delegate connects to, such as `https://app.harness.io`. It
   * depends on which Harness cluster hosts the account; copy it from the account's
   * delegate install page. Only `https://` hosts under `harness.io` are accepted, so a
   * typo cannot point the delegate (and its token) somewhere else.
   */
  harnessManagerUrl: textMatching(/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.harness\.io$/),
};

/**
 * The operator's render inputs file: exactly the fields the record cannot supply.
 * Unknown keys are rejected, so the file cannot override the account, images or lease.
 */
export const sandboxRenderInputsSchema = z.strictObject(operatorInputFields).readonly();

/** Validated, operator-owned settings for one disposable experiment sandbox. */
export const sandboxConfigSchema = z
  .strictObject({
    /** Prefix for every resource name, for example `exp-canary-01`. */
    experimentId: experimentIdSchema,
    /** AWS account the sandbox stacks deploy into. */
    accountId: awsAccountIdSchema,
    /** Only `SANDBOX_LIMITS.region` is accepted. */
    region: z.literal(SANDBOX_LIMITS.region),
    /** After this time scheduled cleanup deletes the workload stack. */
    expiresAt: isoTimestampSchema,
    /**
     * After this time no new trial task may start. It must be exactly
     * `SANDBOX_LIMITS.cleanupWindowHours` before `expiresAt`, so the last trial can
     * finish before cleanup.
     */
    launchCutoffAt: isoTimestampSchema,
    /** Digest-pinned recommendation image for the healthy baseline. */
    goodImage: digestImageReferenceSchema,
    /** Digest-pinned recommendation image the canary must roll back. */
    badImage: digestImageReferenceSchema,
    ...operatorInputFields,
  })
  .superRefine((config, context) => {
    if (config.goodImage === config.badImage) {
      context.addIssue({
        code: 'custom',
        path: ['badImage'],
        message: 'must differ from goodImage',
      });
    }

    const cleanupWindowMs = Date.parse(config.expiresAt) - Date.parse(config.launchCutoffAt);

    if (cleanupWindowMs !== SANDBOX_LIMITS.cleanupWindowHours * HOUR_MS) {
      context.addIssue({
        code: 'custom',
        path: ['launchCutoffAt'],
        message: `must be exactly ${SANDBOX_LIMITS.cleanupWindowHours} hour(s) before expiresAt`,
      });
    }

    // The secret must live in this account and region, under this experiment's path.
    // The interpolated values already passed their own strict patterns above.
    const secretArn = new RegExp(
      `^arn:aws:secretsmanager:${config.region}:${config.accountId}:secret:experiment/${config.experimentId}/delegate-[A-Za-z0-9]{6}$`,
    );

    if (!secretArn.test(config.delegateTokenSecretArn)) {
      context.addIssue({
        code: 'custom',
        path: ['delegateTokenSecretArn'],
        message: 'must be a delegate secret of this experiment, account and region',
      });
    }
  })
  .readonly();

export type SandboxRenderInputs = z.infer<typeof sandboxRenderInputsSchema>;

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

/**
 * Validates the CDK app's input before CDK can turn it into resource names or permissions.
 *
 * @throws Error naming each invalid field; unknown keys are listed first
 */
export function parseSandboxConfig(value: unknown): SandboxConfig {
  return parseWithSchema(sandboxConfigSchema, value, 'sandboxConfig');
}

/**
 * Validates the operator's render inputs file.
 *
 * @throws Error naming each invalid field; unknown keys are listed first
 */
export function parseSandboxRenderInputs(value: unknown): SandboxRenderInputs {
  return parseWithSchema(sandboxRenderInputsSchema, value, 'inputs');
}
