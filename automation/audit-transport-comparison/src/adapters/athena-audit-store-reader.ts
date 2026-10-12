import {
  type AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
} from '@aws-sdk/client-athena';

import { QueryDeadlineExceededError, type AuditStoreReader, type Clock, type LookupWindow } from '../core/ports';
import type { SendClient } from './sdk-client';

/** Builds the SQL for one lookup. Async so Security Lake can resolve its table lazily. */
export type LookupQueryBuilder = (ids: readonly string[], window: LookupWindow) => Promise<string>;

const QUERY_STATE_POLL_MS = 2_000;
const MAX_RESULT_PAGES = 50;

/** Runs one Athena query per poll and returns the event IDs it found. */
export class AthenaAuditStoreReader implements AuditStoreReader {
  public constructor(
    private readonly client: SendClient<AthenaClient>,
    private readonly workGroup: string,
    private readonly buildQuery: LookupQueryBuilder,
    private readonly clock: Clock,
  ) {}

  public async findEventIds(ids: readonly string[], window: LookupWindow, deadline: Date): Promise<ReadonlySet<string>> {
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
        // Don't leave an abandoned query scanning (and billing) after the run ends.
        await this.client.send(new StopQueryExecutionCommand({ QueryExecutionId: queryId })).catch(() => undefined);
        throw new QueryDeadlineExceededError();
      }
      await this.clock.sleep(QUERY_STATE_POLL_MS);
    }
  }

  /** Skips the header row that Athena returns as the first row of the first page. */
  private async readUids(queryId: string): Promise<ReadonlySet<string>> {
    const uids = new Set<string>();
    let nextToken: string | undefined;
    let isHeaderRow = true;
    for (let page = 0; page < MAX_RESULT_PAGES; page += 1) {
      const result = await this.client.send(new GetQueryResultsCommand({ QueryExecutionId: queryId, NextToken: nextToken }));
      for (const row of result.ResultSet?.Rows ?? []) {
        const uid = row.Data?.[0]?.VarCharValue;
        if (!isHeaderRow && uid !== undefined) {
          uids.add(uid);
        }
        isHeaderRow = false;
      }
      nextToken = result.NextToken;
      if (nextToken === undefined) {
        return uids;
      }
    }
    throw new Error('Athena results exceeded the page limit');
  }
}
