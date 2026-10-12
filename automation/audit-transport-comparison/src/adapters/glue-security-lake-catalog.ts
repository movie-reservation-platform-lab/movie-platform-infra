import { CrawlerRunningException, type GlueClient, GetCrawlerCommand, StartCrawlerCommand } from '@aws-sdk/client-glue';

import type { CatalogRefresher } from '../core/ports';
import type { SendClient } from './sdk-client';

/**
 * The crawler that `CreateCustomLogSource` created for the Security Lake
 * custom source. It is the source of truth for the queryable table: its catalog
 * target differs from the `tableArn` in the custom-source response.
 */
export class GlueSecurityLakeCatalog implements CatalogRefresher {
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

  /** The runner's only AWS mutation. A crawl that is already running is fine. */
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
