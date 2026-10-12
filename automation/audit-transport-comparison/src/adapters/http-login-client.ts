import { AUDIT_EVENT_ID } from '../core/identifiers';
import type { LoginClient, LoginRequest, LoginResponse } from '../core/ports';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

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
      // A redirect would resend the credentials to wherever it points; report it instead.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { httpStatus: response.status, auditEventId: await readAuditEventId(response) };
  }
}

/** The receipt is optional: authentication fails open without it. */
async function readAuditEventId(response: Response): Promise<string | null> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object') {
    return null;
  }
  const id = (body as Record<string, unknown>).audit_event_id;
  // Validated here because the ID is later interpolated into Athena SQL.
  return typeof id === 'string' && AUDIT_EVENT_ID.test(id) ? id : null;
}
