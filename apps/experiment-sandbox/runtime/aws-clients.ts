/**
 * One client per service, created once per Lambda instance and reused across calls.
 * Region and credentials come from the Lambda runtime.
 */

import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ECSClient } from '@aws-sdk/client-ecs';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** DynamoDB with plain JavaScript values instead of attribute-value maps. */
export const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const ecs = new ECSClient({});

export const cloudFormation = new CloudFormationClient({});

export const s3 = new S3Client({});
