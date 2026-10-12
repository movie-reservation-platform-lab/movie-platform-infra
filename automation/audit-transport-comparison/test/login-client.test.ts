import { HttpLoginClient } from '../src/login-client';
import { ID_ACCEPTED } from './test-support';

const REQUEST = { requestId: 'r-1', correlationId: 'c-1', username: 'demo-user', password: 'pw' };

function fakeFetch(status: number, body: string) {
  const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
  const implementation = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, implementation };
}

describe('HttpLoginClient', () => {
  it('posts JSON credentials with correlation headers and returns the receipt', async () => {
    const fetch = fakeFetch(401, JSON.stringify({ authenticated: false, audit_event_id: ID_ACCEPTED }));
    const url = new URL('http://demo.example.test/audit-demo/reservation/login');

    await expect(new HttpLoginClient(url, fetch.implementation).login(REQUEST))
      .resolves.toEqual({ httpStatus: 401, auditEventId: ID_ACCEPTED });
    expect(fetch.calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { 'X-Correlation-ID': 'c-1', 'X-Request-ID': 'r-1' },
      body: JSON.stringify({ username: 'demo-user', password: 'pw' }),
    });
  });

  it('treats a missing, malformed, or non-UUID receipt as absent', async () => {
    const url = new URL('http://demo.example.test/login');
    for (const body of ['{"authenticated":true}', 'not json', '{"audit_event_id":"x\' OR 1=1"}']) {
      await expect(new HttpLoginClient(url, fakeFetch(200, body).implementation).login(REQUEST))
        .resolves.toEqual({ httpStatus: 200, auditEventId: null });
    }
  });
});
