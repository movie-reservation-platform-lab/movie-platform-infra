import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const contractRoot = join(__dirname, '..', 'contract');
const expectedHashes: Readonly<Record<string, string>> = {
  'examples/authentication-accepted-v1.json':
    '05143118b47f34871693e7b893a309d7e234dbe2ef4048391522f722497e61f8',
  'examples/authentication-rejected-v1.json':
    'b19ece8e83a944f6f816d073d5599a8442a53ee1c60985ce04bb6391382743de',
  'manifest.json':
    '2193addb99ceed680fa698d14727f01ffe28dd1bd71af1553883f46e08a3c514',
  'platform-audit-event-v1.schema.json':
    '0b6161fa7ccd94e77c7ca2081e0ba60a5a5aa7815abf1969073432f6cc557376',
};

test('pins the platform-audit/1 bundle copied from service revision 6a1fdd3', () => {
  for (const [relativePath, expectedHash] of Object.entries(expectedHashes)) {
    const contents = readFileSync(join(contractRoot, relativePath));
    expect(createHash('sha256').update(contents).digest('hex')).toBe(expectedHash);
  }
});
