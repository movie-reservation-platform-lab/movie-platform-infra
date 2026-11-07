/**
 * Schemas for the AWS CLI responses the operator reads. AWS CLI output is untrusted
 * input: each response is validated before the operator uses a field from it.
 *
 * Schemas list only the fields the operator reads, and ignore the rest, so an AWS CLI
 * upgrade that adds fields does not break the operator.
 */

import { z } from 'zod';

const requiredText = z.string().min(1);

/** A non-empty pagination token; empty strings count as "no more pages". */
const nextToken = z.string().optional();

/** One AWS Organizations account creation request. */
export const createAccountStatusSchema = z.object({
  Id: requiredText,
  AccountName: z.string(),
  State: z.enum(['IN_PROGRESS', 'SUCCEEDED', 'FAILED']),
  AccountId: z.string().optional(),
});

export const createAccountResponseSchema = z.object({
  CreateAccountStatus: createAccountStatusSchema,
});

/** One page of `list-create-account-status`; entries are validated once matched. */
export const createAccountStatusPageSchema = z.object({
  CreateAccountStatuses: z.array(z.object({ AccountName: z.string().optional() }).loose()),
  NextToken: nextToken,
});

export const describeAccountResponseSchema = z.object({
  Account: z.object({ Id: requiredText, State: z.string() }),
});

export const describeStacksResponseSchema = z.object({
  Stacks: z.array(
    z.object({
      /** Needed only to capture the control manifest; checked there. */
      StackId: z.string().optional(),
      StackStatus: requiredText,
      Outputs: z.array(z.object({ OutputKey: requiredText, OutputValue: requiredText })).optional(),
    }),
  ),
});

/** `get-template`: the body is a JSON string or, for some CLI versions, already an object. */
export const getTemplateResponseSchema = z.object({
  TemplateBody: z.union([z.string(), z.record(z.string(), z.unknown())]),
});

/** A CloudFormation template, reduced to what the control manifest reads. */
export const controlTemplateSchema = z.object({
  Resources: z.record(
    z.string(),
    z.object({
      Type: requiredText,
      DeletionPolicy: z.string().optional(),
      UpdateReplacePolicy: z.string().optional(),
    }),
  ),
});

export const stackResourcePageSchema = z.object({
  StackResourceSummaries: z.array(
    z.object({
      LogicalResourceId: requiredText,
      ResourceType: requiredText,
      PhysicalResourceId: z.string().optional(),
      ResourceStatus: z.string().optional(),
    }),
  ),
  NextToken: nextToken,
});

export const stackSummaryPageSchema = z.object({
  StackSummaries: z.array(
    z.object({
      StackId: z.string().optional(),
      StackName: z.string().optional(),
      StackStatus: z.string().optional(),
    }),
  ),
  NextToken: nextToken,
});

export const describeRuleResponseSchema = z.object({ State: z.string() });

export const listTargetsResponseSchema = z.object({
  Targets: z.array(z.object({ Arn: z.string(), Input: z.string().optional() })),
});

export const listSubscriptionsResponseSchema = z.object({
  Subscriptions: z.array(z.object({ SubscriptionArn: z.string() })),
});

/** `lambda invoke` metadata; the function's own response goes to a file. */
export const lambdaInvokeResponseSchema = z.object({ FunctionError: z.string().optional() });

export const describeTableResponseSchema = z.object({
  Table: z.object({ TableArn: requiredText }),
});

export const logGroupPageSchema = z.object({
  logGroups: z.array(z.object({ logGroupName: z.string() })),
  nextToken: nextToken,
});

const objectVersion = z.object({ Key: requiredText, VersionId: requiredText });

export const objectVersionPageSchema = z.object({
  Versions: z.array(objectVersion).optional(),
  DeleteMarkers: z.array(objectVersion).optional(),
  IsTruncated: z.boolean().optional(),
});

export const deleteObjectsResponseSchema = z.object({ Errors: z.array(z.unknown()).optional() });

export const multipartUploadPageSchema = z.object({
  Uploads: z.array(z.object({ Key: requiredText, UploadId: requiredText })).optional(),
  IsTruncated: z.boolean().optional(),
});

/**
 * Validates one untrusted AWS CLI response against the expected operation schema.
 *
 * @param schema - Zod schema describing the response fields the operation reads
 * @param value - untrusted JSON value returned by the AWS CLI
 * @param operation - call name used in validation errors, for example `describe-stacks`
 * @returns the validated response with the schema's inferred output type
 * @throws Error naming the operation, never the response values
 */
export function parseAwsResponse<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  operation: string,
): z.output<Schema> {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new Error(`Unexpected AWS response from ${operation}`);
  }

  return result.data;
}
