import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
} from '@aws-sdk/client-athena';

import { AthenaAuditStoreReader } from '../../src/adapters/athena-audit-store-reader';
import { QueryDeadlineExceededError } from '../../src/core/ports';
import { FakeClock, ID_ACCEPTED, after } from '../support/fakes';
import { fakeSdkClient } from '../support/fake-sdk-client';

const WINDOW = { days: [new Date('2026-10-12T00:00:00Z')], workloadAccountId: '333333333333', region: 'eu-central-1' };
const row = (value: string) => ({ Data: [{ VarCharValue: value }] });

function reader(client: ReturnType<typeof fakeSdkClient>, clock = new FakeClock()) {
  return new AthenaAuditStoreReader(client as never, 'wg', async () => 'SELECT 1', clock);
}

describe('AthenaAuditStoreReader', () => {
  it('waits for the query, skips the header row, and de-duplicates IDs', async () => {
    const clock = new FakeClock();
    const client = fakeSdkClient([
      [StartQueryExecutionCommand, [{ QueryExecutionId: 'q-1' }]],
      [GetQueryExecutionCommand, [{ QueryExecution: { Status: { State: 'RUNNING' } } }, { QueryExecution: { Status: { State: 'SUCCEEDED' } } }]],
      [GetQueryResultsCommand, [{ ResultSet: { Rows: [row('uid'), row(ID_ACCEPTED), row(ID_ACCEPTED)] } }]],
    ]);

    await expect(reader(client, clock).findEventIds([ID_ACCEPTED], WINDOW, after(600))).resolves.toEqual(new Set([ID_ACCEPTED]));
    expect(client.sent[0]?.input).toEqual({ QueryString: 'SELECT 1', WorkGroup: 'wg' });
    expect(clock.sleeps).toEqual([2000]);
  });

  it('surfaces a failed query with its reason', async () => {
    const client = fakeSdkClient([
      [StartQueryExecutionCommand, [{ QueryExecutionId: 'q-1' }]],
      [GetQueryExecutionCommand, [{ QueryExecution: { Status: { State: 'FAILED', StateChangeReason: 'Insufficient Lake Formation permission(s)' } } }]],
    ]);

    await expect(reader(client).findEventIds([ID_ACCEPTED], WINDOW, after(600)))
      .rejects.toThrow('Athena query FAILED: Insufficient Lake Formation permission(s)');
  });

  it('stops a query still running at the deadline and signals the deadline, not a failure', async () => {
    const client = fakeSdkClient([
      [StartQueryExecutionCommand, [{ QueryExecutionId: 'q-2' }]],
      [GetQueryExecutionCommand, [{ QueryExecution: { Status: { State: 'RUNNING' } } }]],
      [StopQueryExecutionCommand, [{}]],
    ]);

    await expect(reader(client, new FakeClock(after(600))).findEventIds([ID_ACCEPTED], WINDOW, after(600)))
      .rejects.toBeInstanceOf(QueryDeadlineExceededError);
    expect(client.sent.at(-1)?.input).toEqual({ QueryExecutionId: 'q-2' });
  });
});
