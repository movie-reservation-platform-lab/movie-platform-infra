'use strict';

/**
 * Response contract of the spike fixture image, one behaviour per variant.
 *
 * - good-1, good-2: healthy revisions with distinct digests (control runs).
 * - bad-5xx: passes the ALB health check but fails every other request, so
 *   only a deployment alarm can stop it.
 * - crash: the server exits shortly after start (see server.cjs), which
 *   exercises the deployment circuit breaker.
 */
const VARIANTS = ['good-1', 'good-2', 'bad-5xx', 'crash'];

/**
 * @param {string} variant
 * @param {string} path request path without the query string
 * @returns {{ status: number, body: string }}
 */
function respond(variant, path) {
  if (path === '/healthz') {
    return { status: 200, body: 'ok\n' };
  }
  if (variant === 'bad-5xx') {
    return { status: 500, body: `injected failure from ${variant}\n` };
  }
  return { status: 200, body: `hello from ${variant}\n` };
}

module.exports = { VARIANTS, respond };
