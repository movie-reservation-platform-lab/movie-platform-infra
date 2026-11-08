// Invalid HTTP bodies must never count toward candidate coverage.
import { probeEndpoint, ProbeFetch, PROBE_MAX_BYTES } from '../src/probe';

const readiness = { status: 'ready', service_name: 'movie-recommendation-service' };

const recommendation = {
  id: 'recommendation-matrix',
  title: 'The Matrix',
  reason: 'Matches demo preferences',
  confidence: 0.99,
  movie_reservation_movie_id: 'movie-matrix',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('accepts actual readiness and nonempty recommendation JSON contracts', async () => {
  expect(await probeEndpoint('10.0.0.1', '/ready', async () => jsonResponse(readiness))).toBe(true);

  expect(
    await probeEndpoint('10.0.0.1', '/recommendations', async () =>
      jsonResponse({ recommendations: [recommendation] }),
    ),
  ).toBe(true);
});

test('rejects success status with HTML, empty or malformed bodies and wrong service identity', async () => {
  const invalid = [
    new Response('<html>healthy</html>', { headers: { 'content-type': 'text/html' } }),
    new Response(null, { status: 204 }),
    new Response('{', { headers: { 'content-type': 'application/json' } }),
    jsonResponse({ status: 'ready', service_name: 'another-service' }),
    jsonResponse({ status: 'ok', service_name: 'movie-recommendation-service' }),
    jsonResponse({}),
  ];

  for (const response of invalid) {
    expect(await probeEndpoint('10.0.0.1', '/ready', async () => response)).toBe(false);
  }
});

test('rejects malformed recommendation envelopes and invalid items', async () => {
  const invalid = [
    {},
    { recommendations: [] },
    { recommendations: [recommendation], error: 'wrong service' },
    { recommendations: [{ ...recommendation, title: '' }] },
    { recommendations: [{ ...recommendation, confidence: 2 }] },
    { recommendations: [{ ...recommendation, movie_reservation_movie_id: null }] },
    { recommendations: Array.from({ length: 21 }, () => recommendation) },
  ];

  for (const body of invalid) {
    expect(
      await probeEndpoint('10.0.0.1', '/recommendations', async () => jsonResponse(body)),
    ).toBe(false);
  }
});

test('caps body bytes and cancels the stream after crossing the limit', async () => {
  let cancelled = false;

  const oversizedBody = JSON.stringify({
    recommendations: [{ ...recommendation, title: 'x'.repeat(PROBE_MAX_BYTES) }],
  });

  const encoder = new TextEncoder();

  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(oversizedBody));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

  expect(await probeEndpoint('10.0.0.1', '/recommendations', async () => response)).toBe(false);
  expect(cancelled).toBe(true);
});

test('a stalled response body times out and its reader is cancelled', async () => {
  jest.useFakeTimers();
  let cancelled = false;

  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
    {
      headers: { 'content-type': 'application/json' },
    },
  );

  try {
    const result = probeEndpoint('10.0.0.1', '/ready', async () => response);

    await jest.advanceTimersByTimeAsync(2000);

    expect(await result).toBe(false);
    expect(cancelled).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test('probe transport remains bounded and does not follow redirects', async () => {
  const fetchResponse: ProbeFetch = async (url, options) => {
    expect(url).toBe('http://10.0.0.1:8082/ready');
    expect(options.redirect).toBe('error');
    expect(options.signal).toBeInstanceOf(AbortSignal);

    return jsonResponse(readiness);
  };

  expect(await probeEndpoint('10.0.0.1', '/ready', fetchResponse)).toBe(true);
});
