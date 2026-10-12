import type { LoginClient, LoginRequest, LoginResponse } from './model';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_TIMEOUT_MS = 10_000;

/** Posts one credential check to the demo login route; never retries. */
export class HttpLoginClient implements LoginClient {
  public constructor(
    private readonly url: URL,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public async login(request: LoginRequest): Promise<LoginResponse> {
    const response = await this.fetchImplementation(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': request.correlationId,
        'X-Request-ID': request.requestId,
      },
      body: JSON.stringify({ username: request.username, password: request.password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { httpStatus: response.status, auditEventId: await readAuditEventId(response) };
  }
}

/** The receipt is optional: authentication fails open without it. */
async function readAuditEventId(response: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object') {
    return null;
  }
  const id = (body as Record<string, unknown>).audit_event_id;
  // Validated here because it is later interpolated into Athena SQL.
  return typeof id === 'string' && UUID.test(id) ? id : null;
}
