import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { CloudWatchClient, DescribeAlarmsCommand, StateValue } from '@aws-sdk/client-cloudwatch';
import { CrawlerRunningException, GetCrawlerCommand, GlueClient, StartCrawlerCommand } from '@aws-sdk/client-glue';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

import type {
  AuditStoreReader,
  Clock,
  DeliveryHealth,
  DeliveryHealthReader,
  LookupWindow,
  SecurityLakeCatalog,
} from './model';

type SendClient<T extends { send: unknown }> = Pick<T, 'send'>;

/** Builds the SQL for one bounded lookup; resolved lazily for Security Lake. */
export type LookupQueryBuilder = (ids: readonly string[], window: LookupWindow) => Promise<string>;

const QUERY_STATE_POLL_MS = 2_000;
const MAX_RESULT_PAGES = 50;

/** Runs one Athena lookup per poll and returns the event IDs it found. */
export class AthenaAuditStoreReader implements AuditStoreReader {
  public constructor(
    private readonly client: SendClient<AthenaClient>,
    private readonly workGroup: string,
    private readonly buildQuery: LookupQueryBuilder,
    private readonly clock: Clock,
  ) {}

  public async findEventIds(
    ids: readonly string[],
    window: LookupWindow,
    deadline: Date,
  ): Promise<ReadonlySet<string>> {
    const started = await this.client.send(new StartQueryExecutionCommand({
      QueryString: await this.buildQuery(ids, window),
      WorkGroup: this.workGroup,
    }));
    const queryId = started.QueryExecutionId;
    if (queryId === undefined) {
      throw new Error('Athena returned no query execution ID');
    }
    await this.waitForSuccess(queryId, deadline);
    return this.readUids(queryId);
  }

  private async waitForSuccess(queryId: string, deadline: Date): Promise<void> {
    for (;;) {
      const { QueryExecution } = await this.client.send(new GetQueryExecutionCommand({ QueryExecutionId: queryId }));
      const state = QueryExecution?.Status?.State;
      if (state === QueryExecutionState.SUCCEEDED) {
        return;
      }
      if (state === QueryExecutionState.FAILED || state === QueryExecutionState.CANCELLED) {
        throw new Error(`Athena query ${state}: ${QueryExecution?.Status?.StateChangeReason ?? 'no reason given'}`);
      }
      if (this.clock.now() >= deadline) {
        throw new Error('Athena query did not finish before the run deadline');
      }
      await this.clock.sleep(QUERY_STATE_POLL_MS);
    }
  }

  private async readUids(queryId: string): Promise<ReadonlySet<string>> {
    const uids = new Set<string>();
    let nextToken: string | undefined;
    let header = true;
    for (let page = 0; page < MAX_RESULT_PAGES; page += 1) {
      const result = await this.client.send(new GetQueryResultsCommand({ QueryExecutionId: queryId, NextToken: nextToken }));
      for (const row of result.ResultSet?.Rows ?? []) {
        if (header) {
          header = false;
          continue;
        }
        const uid = row.Data?.[0]?.VarCharValue;
        if (uid !== undefined) {
          uids.add(uid);
        }
      }
      nextToken = result.NextToken;
      if (nextToken === undefined) {
        return uids;
      }
    }
    throw new Error('Athena results exceeded the page limit');
  }
}

/**
 * The Security Lake-created crawler is the source of truth for the queryable
 * table: its catalog target differs from the custom-source response's tableArn.
 */
export class GlueSecurityLakeCatalog implements SecurityLakeCatalog {
  public constructor(
    private readonly client: SendClient<GlueClient>,
    private readonly crawlerName: string,
  ) {}

  public async resolveTable(): Promise<{ database: string; table: string }> {
    const { Crawler } = await this.client.send(new GetCrawlerCommand({ Name: this.crawlerName }));
    const target = Crawler?.Targets?.CatalogTargets?.[0];
    const table = target?.Tables?.[0];
    if (target?.DatabaseName === undefined || table === undefined) {
      throw new Error('the Security Lake crawler has no catalog target table');
    }
    return { database: target.DatabaseName, table };
  }

  /** The runner's only mutation; an already running crawl is fine. */
  public async startCrawler(): Promise<void> {
    try {
      await this.client.send(new StartCrawlerCommand({ Name: this.crawlerName }));
    } catch (error) {
      if (!(error instanceof CrawlerRunningException)) {
        throw error;
      }
    }
  }
}

/** Reads the audit-account target DLQ depth and delivery alarms in ALARM. */
export class AwsDeliveryHealthReader implements DeliveryHealthReader {
  public constructor(
    private readonly sqs: SendClient<SQSClient>,
    private readonly cloudWatch: SendClient<CloudWatchClient>,
    private readonly queueUrl: string,
    private readonly alarmNamePrefix: string,
  ) {}

  public async read(): Promise<DeliveryHealth> {
    const { Attributes } = await this.sqs.send(new GetQueueAttributesCommand({
      QueueUrl: this.queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    const deadLetterMessages = Number(Attributes?.ApproximateNumberOfMessages ?? 'NaN')
      + Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 'NaN');
    if (!Number.isFinite(deadLetterMessages)) {
      throw new Error('SQS returned no message counts for the target DLQ');
    }
    const { MetricAlarms } = await this.cloudWatch.send(new DescribeAlarmsCommand({
      AlarmNamePrefix: this.alarmNamePrefix,
      StateValue: StateValue.ALARM,
    }));
    return {
      deadLetterMessages,
      alarmsInAlarm: (MetricAlarms ?? []).flatMap(({ AlarmName }) => (AlarmName === undefined ? [] : [AlarmName])),
    };
  }
}
