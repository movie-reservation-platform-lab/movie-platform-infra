import type { CfnDeliveryStream } from 'aws-cdk-lib/aws-kinesisfirehose';

/** Firehose properties that keep valid and failed records in separate datasets. */
export interface FirehosePartitioning {
  readonly dynamicPartitioningConfiguration:
    CfnDeliveryStream.DynamicPartitioningConfigurationProperty;
  readonly errorObjectPrefix: string;
  readonly errorOutputPrefix: string;
  readonly prefix: string;
  readonly processingConfiguration: CfnDeliveryStream.ProcessingConfigurationProperty;
}

/** Build the proven Region/account/UTC-day Security Lake partition contract. */
export function buildFirehosePartitioning(
  sourcePrefix: string,
  region: string,
  sourceAccountId: string,
): FirehosePartitioning {
  const errorObjectPrefix = `${sourcePrefix.slice(0, -1)}-errors/`;

  return {
    dynamicPartitioningConfiguration: { enabled: true },
    errorObjectPrefix,
    errorOutputPrefix:
      `${errorObjectPrefix}!{firehose:error-output-type}/` +
      '!{timestamp:yyyy/MM/dd/HH}/',
    prefix:
      `${sourcePrefix}region=${region}/` +
      `accountId=${sourceAccountId}/` +
      'eventDay=!{partitionKeyFromQuery:eventDay}/',
    processingConfiguration: {
      enabled: true,
      processors: [
        {
          type: 'MetadataExtraction',
          parameters: [
            { parameterName: 'JsonParsingEngine', parameterValue: 'JQ-1.6' },
            {
              parameterName: 'MetadataExtractionQuery',
              parameterValue: '{eventDay: (.time / 1000 | strftime("%Y%m%d"))}',
            },
          ],
        },
      ],
    },
  };
}
