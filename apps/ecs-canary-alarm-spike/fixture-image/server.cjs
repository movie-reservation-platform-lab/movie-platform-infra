'use strict';

const http = require('node:http');
const { VARIANTS, respond } = require('./responses.cjs');

const variant = process.env.SPIKE_VARIANT ?? '';
if (!VARIANTS.includes(variant)) {
  console.error(`SPIKE_VARIANT must be one of: ${VARIANTS.join(', ')}`);
  process.exit(2);
}
const port = Number(process.env.PORT ?? 8080);

const server = http.createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  const { status, body } = respond(variant, path);
  // The probe counts the traffic split from this header.
  response.writeHead(status, { 'content-type': 'text/plain', 'x-spike-variant': variant });
  response.end(body);
});

server.listen(port, () => {
  console.log(JSON.stringify({ msg: 'fixture listening', variant, port }));
});

if (variant === 'crash') {
  setTimeout(() => {
    console.error(JSON.stringify({ msg: 'crash variant exiting', variant }));
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => server.close(() => process.exit(0)));
