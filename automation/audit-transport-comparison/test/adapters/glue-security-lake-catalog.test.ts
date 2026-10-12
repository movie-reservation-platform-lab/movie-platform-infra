import { CrawlerRunningException, GetCrawlerCommand, StartCrawlerCommand } from '@aws-sdk/client-glue';

import { GlueSecurityLakeCatalog } from '../../src/adapters/glue-security-lake-catalog';
import { fakeSdkClient } from '../support/fake-sdk-client';

describe('GlueSecurityLakeCatalog', () => {
  it('resolves the queryable table from the crawler catalog target', async () => {
    const client = fakeSdkClient([
      [GetCrawlerCommand, [{ Crawler: { Targets: { CatalogTargets: [{ DatabaseName: 'sl_db', Tables: ['sl_table'] }] } } }]],
    ]);

    await expect(new GlueSecurityLakeCatalog(client as never, 'crawler').resolveTable()).resolves.toEqual({ database: 'sl_db', table: 'sl_table' });
  });

  it('fails clearly when the crawler has no catalog target', async () => {
    const client = fakeSdkClient([[GetCrawlerCommand, [{ Crawler: { Targets: {} } }]]]);

    await expect(new GlueSecurityLakeCatalog(client as never, 'crawler').resolveTable()).rejects.toThrow('no catalog target table');
  });

  it('treats an already running crawl as started', async () => {
    const client = fakeSdkClient([[StartCrawlerCommand, [new CrawlerRunningException({ message: 'running', $metadata: {} })]]]);

    await expect(new GlueSecurityLakeCatalog(client as never, 'crawler').startCrawler()).resolves.toBeUndefined();
  });
});
