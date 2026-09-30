import type { CfnDeliveryStream } from 'aws-cdk-lib/aws-kinesisfirehose';

/** Firehose properties that route valid and failed records into separate datasets. */
export interface FirehosePartitioning {
  readonly dynamicPartitioningConfiguration:
    CfnDeliveryStream.DynamicPartitioningConfigurationProperty;
  readonly errorOutputPrefix: string;
  readonly prefix: string;
  readonly processingConfiguration: CfnDeliveryStream.ProcessingConfigurationProperty;
}

/**
 * Build the Security Lake partition contract for one workload account.
 *
 * Extract the UTC event day from the OCSF epoch-millisecond `time` field with
 * Firehose inline parsing, then route successful records to the assigned
 * Region/account/day hierarchy. Keep conversion failures outside the valid
 * partition hierarchy.
 */
export function buildFirehosePartitioning(
  sourcePrefix: string,
  region: string,
  sourceAccountId: string,
): FirehosePartitioning {
  const dynamicPartitioningConfiguration: CfnDeliveryStream.DynamicPartitioningConfigurationProperty = {
    enabled: true,
  };
  const errorOutputPrefix =
    `${sourcePrefix.slice(0, -1)}-errors/` +
    '!{firehose:error-output-type}/' +
    '!{timestamp:yyyy/MM/dd/HH}/';
  const prefix =
    `${sourcePrefix}` +
    `region=${region}/` +
    `accountId=${sourceAccountId}/` +
    `eventDay=!{partitionKeyFromQuery:eventDay}/`;
  const processingConfiguration:
    CfnDeliveryStream.ProcessingConfigurationProperty = {
      enabled: true,
      processors: [
        {
          type: 'MetadataExtraction',
          parameters: [
            {
              parameterName: 'JsonParsingEngine',
              parameterValue: 'JQ-1.6',
            },
            {
              parameterName: 'MetadataExtractionQuery',
              parameterValue: '{eventDay: (.time / 1000 | strftime("%Y%m%d"))}',
            },
          ],
        },
      ],
    };

  return {
    dynamicPartitioningConfiguration,
    errorOutputPrefix,
    prefix,
    processingConfiguration,
  };
}
