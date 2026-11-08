/** Validates time- and size-bounded HTTP probes against the recommendation-service contract. */

/** Application endpoints the trial is allowed to probe on each candidate task. */
export type ProbePath = '/ready' | '/recommendations';

/** HTTP transport; tests inject responses without contacting a running task. */
export type ProbeFetch = (url: string, options: RequestInit) => Promise<Response>;

/** Maximum accepted response body size in bytes. */
export const PROBE_MAX_BYTES = 64 * 1024;

/** Deadline in milliseconds covering the request and response-body read. */
const probeTimeoutMilliseconds = 2000;

/** Narrows a parsed JSON value to a non-null, non-array object. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a value is text containing at least one non-whitespace character. */
function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Checks required recommendation text fields and a finite confidence between zero and one. */
function validRecommendation(value: unknown): boolean {
  if (!record(value)) {
    return false;
  }

  const fields = ['id', 'title', 'reason', 'movie_reservation_movie_id'];

  return (
    fields.every((field) => nonemptyString(value[field])) &&
    typeof value.confidence === 'number' &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
}

/** Checks the exact top-level response fields and endpoint-specific content. */
function validProbeBody(path: ProbePath, body: unknown): boolean {
  if (!record(body)) {
    return false;
  }

  if (path === '/ready') {
    return (
      Object.keys(body).length === 2 &&
      body.status === 'ready' &&
      body.service_name === 'movie-recommendation-service'
    );
  }

  return (
    Object.keys(body).length === 1 &&
    Array.isArray(body.recommendations) &&
    body.recommendations.length > 0 &&
    body.recommendations.length <= 20 &&
    body.recommendations.every(validRecommendation)
  );
}

/** Whether the target is an IPv4 address in one of the supported private address ranges. */
function privateTaskAddress(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part));

  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address) || octets.some((octet) => octet > 255)) {
    return false;
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

/**
 * Reads and parses JSON while enforcing the byte limit and the caller's abort signal.
 * Releases the reader and attempts cancellation on both success and failure.
 *
 * @param response - HTTP response whose body is consumed
 * @param signal - shared deadline signal for the request and body read
 * @throws Error when the body is missing, oversized, aborted, unreadable or invalid JSON
 */
async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) {
    throw new Error('missing probe body');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let rejectOnAbort: (() => void) | undefined;

  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(new Error('probe body timed out'));
    signal.addEventListener('abort', rejectOnAbort, { once: true });

    if (signal.aborted) {
      rejectOnAbort();
    }
  });

  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);

      if (chunk.done) {
        break;
      }

      bytesRead += chunk.value.byteLength;

      if (bytesRead > PROBE_MAX_BYTES) {
        throw new Error('probe body exceeds byte limit');
      }

      chunks.push(chunk.value);
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    if (rejectOnAbort) {
      signal.removeEventListener('abort', rejectOnAbort);
    }

    // Do not await cancellation: a stalled peer must not extend the deadline.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Probes one task endpoint on port 8082, rejecting redirects and enforcing a two-second
 * deadline and 64 KiB body limit. Requires HTTP 200, JSON content type and a valid body.
 *
 * @param ip - task IPv4 address in a supported private address range
 * @param path - application endpoint whose response contract is checked
 * @param fetchResponse - HTTP transport; defaults to the built-in fetch
 * @returns true when the response passes every check; false on request or response failure
 * @throws Error when the supplied task address is invalid
 */
export async function probeEndpoint(
  ip: string,
  path: ProbePath,
  fetchResponse: ProbeFetch = fetch,
): Promise<boolean> {
  if (!privateTaskAddress(ip)) {
    throw new Error('invalid task private address');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), probeTimeoutMilliseconds);

  try {
    const response = await fetchResponse(`http://${ip}:8082${path}`, {
      signal: controller.signal,
      redirect: 'error',
    });

    if (
      response.status !== 200 ||
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
        'application/json'
    ) {
      void response.body?.cancel().catch(() => undefined);

      return false;
    }

    return validProbeBody(path, await readBoundedJson(response, controller.signal));
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
