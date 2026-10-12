import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { CrawlerRunningException, GetCrawlerCommand, StartCrawlerCommand } from '@aws-sdk/client-glue';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

import { AthenaAuditStoreReader, AwsDeliveryHealthReader, GlueSecurityLakeCatalog } from '../src/aws-adapters';
import { FakeClock, ID_ACCEPTED, after } from './test-support';

const WINDOW = { days: [new Date('2026-10-12T00:00:00Z')], workloadAccountId: '333333333333', region: 'eu-central-1' };

/** Fake SDK client: answers each command class from a queue of responses. */
function fakeClient(responses: Map<unknown, unknown[]>) {
  const sent: unknown[] = [];
  return {
    sent,
    send: async (command: { constructor: unknown; input: unknown }) => {
      sent.push(command);
      const queue = responses.get(command.constructor);
      if (queue === undefined || queue.length === 0) {
        throw new Error(`unexpected ${String((command.constructor as { name: string }).name)}`);
      }
      const next = queue.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

describe('AthenaAuditStoreReader', () => {
  it('waits for the query, skips the header row, and returns the found IDs', async () => {
    const client = fakeClient(new Map<unknown, unknown[]>([
      [StartQueryExecutionCommand, [{ QueryExecutionId: 'q-1' }]],
      [GetQueryExecutionCommand, [
        { QueryExecution: { Status: { State: 'RUNNING' } } },
        { QueryExecution: { Status: { State: 'SUCCEEDED' } } },
      ]],
      [GetQueryResultsCommand, [{ ResultSet: { Rows: [{ Data: [{ VarCharValue: 'uid' }] }, { Data: [{ VarCharValue: ID_ACCEPTED }] }] } }]],
    ]));
    const clock = new FakeClock();
    const reader = new AthenaAuditStoreReader(client as never, 'wg', async () => 'SELECT 1', clock);

    await expect(reader.findEventIds([ID_ACCEPTED], WINDOW, after(600))).resolves.toEqual(new Set([ID_ACCEPTED]));
    expect((client.sent[0] as StartQueryExecutionCommand).input).toEqual({ QueryString: 'SELECT 1', WorkGroup: 'wg' });
    expect(clock.sleeps).toEqual([2000]);
  });

  it('surfaces failed queries with their reason and stops at the deadline', async () => {
    const failed = fakeClient(new Map<unknown, unknown[]>([
      [StartQueryExecutionCommand, [{ QueryExecutionId: 'q-1' }]],
      [GetQueryExecutionCommand, [{ QueryExecution: { Status: { State: 'FAILED', StateChangeReason: 'Insufficient Lake Formation permission(s)' } } }]],
    ]));
    const slow = fakeClient(new Map<unknown, unknown[]>([
      [StartQueryExecutionCommand, [{ QueryExecutionId: 'q-2' }]],
      [GetQueryExecutionCommand, [{ QueryExecution: { Status: { State: 'RUNNING' } } }]],
    ]));
    const clock = new FakeClock(after(600));

    await expect(new AthenaAuditStoreReader(failed as never, 'wg', async () => 'q', new FakeClock()).findEventIds([ID_ACCEPTED], WINDOW, after(600)))
      .rejects.toThrow('Athena query FAILED: Insufficient Lake Formation permission(s)');
    await expect(new AthenaAuditStoreReader(slow as never, 'wg', async () => 'q', clock).findEventIds([ID_ACCEPTED], WINDOW, after(600)))
      .rejects.toThrow('did not finish before the run deadline');
  });
});

describe('GlueSecurityLakeCatalog', () => {
  it('resolves the table from the crawler catalog target and tolerates a running crawl', async () => {
    const client = fakeClient(new Map<unknown, unknown[]>([
      [GetCrawlerCommand, [{ Crawler: { Targets: { CatalogTargets: [{ DatabaseName: 'sl_db', Tables: ['sl_table'] }] } } }]],
      [StartCrawlerCommand, [new CrawlerRunningException({ message: 'running', $metadata: {} })]],
    ]));
    const catalog = new GlueSecurityLakeCatalog(client as never, 'crawler');

    await expect(catalog.resolveTable()).resolves.toEqual({ database: 'sl_db', table: 'sl_table' });
    await expect(catalog.startCrawler()).resolves.toBeUndefined();
  });

  it('fails clearly when the crawler has no catalog target', async () => {
    const client = fakeClient(new Map<unknown, unknown[]>([[GetCrawlerCommand, [{ Crawler: { Targets: {} } }]]]));

    await expect(new GlueSecurityLakeCatalog(client as never, 'crawler').resolveTable())
      .rejects.toThrow('no catalog target table');
  });
});

describe('AwsDeliveryHealthReader', () => {
  it('sums visible and in-flight DLQ messages and lists delivery alarms in ALARM', async () => {
    const sqs = fakeClient(new Map<unknown, unknown[]>([[GetQueueAttributesCommand, [{
      Attributes: { ApproximateNumberOfMessages: '1', ApproximateNumberOfMessagesNotVisible: '2' },
    }]]]));
    const cloudWatch = fakeClient(new Map<unknown, unknown[]>([[DescribeAlarmsCommand, [{ MetricAlarms: [{ AlarmName: 'a' }] }]]]));
    const reader = new AwsDeliveryHealthReader(sqs as never, cloudWatch as never, 'https://sqs/q', 'prefix');

    await expect(reader.read()).resolves.toEqual({ deadLetterMessages: 3, alarmsInAlarm: ['a'] });
    expect((cloudWatch.sent[0] as DescribeAlarmsCommand).input).toEqual({ AlarmNamePrefix: 'prefix', StateValue: 'ALARM' });
  });
});
