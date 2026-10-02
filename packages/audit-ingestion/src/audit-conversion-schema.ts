import type { CfnTable } from 'aws-cdk-lib/aws-glue';


/**
 * Firehose conversion columns for platform-audit/1 OCSF Authentication events.
 *
 * TODO: this is currently a fragile process. Once we have a separate schema
 *  artifact published, the conversion schema can be governed by it.
 *
 */
export const AUDIT_CONVERSION_COLUMNS: readonly CfnTable.ColumnProperty[] = [
  ...['activity_id', 'category_uid', 'class_uid', 'type_uid', 'severity_id', 'status_id']
    .map((name) => ({ name, type: 'int' })),
  { name: 'activity_name', type: 'string' },
  { name: 'status_detail', type: 'string' },
  { name: 'time', type: 'bigint' },
  {
    name: 'metadata',
    type: 'struct<version:string,uid:string,correlation_uid:string,product:struct<name:string,vendor_name:string,version:string>>',
  },
  { name: 'service', type: 'struct<name:string,version:string>' },
  { name: 'user', type: 'struct<name:string,type_id:int>' },
  {
    name: 'unmapped',
    type: 'struct<platform:struct<schema_version:string,environment:string,request_id:string,trace_id:string,span_id:string,aws_alb_trace_id:string,aws_cloudfront_request_id:string,route:string,auth_boundary:string>>',
  },
];
