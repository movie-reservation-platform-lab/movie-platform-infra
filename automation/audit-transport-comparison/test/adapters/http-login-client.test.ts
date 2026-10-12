import { HttpLoginClient } from '../../src/adapters/http-login-client';
import { ID_ACCEPTED } from '../support/fakes';

const REQUEST = { requestId: 'r-1', correlationId: 'c-1', username: 'demo-user', password: 'pw' };
const URL_ = new URL('http://demo.example.test/audit-demo/reservation/login');

function fakeFetch(status: number, body: string) {
  const calls: Array<RequestInit | undefined> = [];
  const implementation = (async (_url: unknown, init?: RequestInit) => {
    calls.push(init);
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, implementation };
}

describe('HttpLoginClient', () => {
  it('posts JSON credentials with correlation headers, without following redirects', async () => {
    const fetch = fakeFetch(401, JSON.stringify({ authenticated: false, audit_event_id: ID_ACCEPTED }));

    await expect(new HttpLoginClient(URL_, fetch.implementation).login(REQUEST)).resolves.toEqual({ httpStatus: 401, auditEventId: ID_ACCEPTED });
    expect(fetch.calls[0]).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: { 'X-Correlation-ID': 'c-1', 'X-Request-ID': 'r-1' },
      body: JSON.stringify({ username: 'demo-user', password: 'pw' }),
    });
  });

  it.each([
    ['no receipt', '{"authenticated":true}'],
    ['a non-JSON body', 'not json'],
    ['a non-UUID receipt', '{"audit_event_id":"x\' OR 1=1"}'],
    ['an oversized body', `{"audit_event_id":"${ID_ACCEPTED}","pad":"${'x'.repeat(70_000)}"}`],
  ])('treats %s as an absent receipt', async (_label, body) => {
    await expect(new HttpLoginClient(URL_, fakeFetch(200, body).implementation).login(REQUEST))
      .resolves.toEqual({ httpStatus: 200, auditEventId: null });
  });
});
