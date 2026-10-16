// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VARIANTS, respond } = require('../fixture-image/responses.cjs') as {
  VARIANTS: string[];
  respond: (variant: string, path: string) => { status: number; body: string };
};

test('defines exactly the four variants the runbook pushes', () => {
  expect(VARIANTS).toEqual(['good-1', 'good-2', 'bad-5xx', 'crash']);
});

test.each(VARIANTS)('keeps /healthz healthy for %s so only alarms can stop bad revisions', (variant) => {
  expect(respond(variant, '/healthz').status).toBe(200);
});

test.each(['good-1', 'good-2', 'crash'])('serves 200 on application paths for %s', (variant) => {
  expect(respond(variant, '/')).toEqual({ status: 200, body: `hello from ${variant}\n` });
});

test('fails application paths for bad-5xx', () => {
  expect(respond('bad-5xx', '/').status).toBe(500);
  expect(respond('bad-5xx', '/anything').status).toBe(500);
});
