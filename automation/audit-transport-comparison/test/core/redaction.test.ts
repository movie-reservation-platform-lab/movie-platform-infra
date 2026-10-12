import { describeError, redact } from '../../src/core/redaction';

describe('redaction', () => {
  it('masks ARNs, accounts, emails, URLs, and absolute paths', () => {
    const message = 'User: arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/jane.doe@example.com '
      + 'is not authorized; account 123456789012; https://sqs.eu-central-1.amazonaws.com/123456789012/q; '
      + "open '/home/jane/private/run.json'";

    expect(redact(message)).toBe(
      'User: <arn> is not authorized; account <account>; <url>; open \'<path>\'',
    );
  });

  it('keeps the error name and caps the length', () => {
    expect(describeError(Object.assign(new Error('nope'), { name: 'AccessDeniedException' }))).toBe('AccessDeniedException: nope');
    expect(describeError(new Error('x'.repeat(400)))).toHaveLength(303);
  });
});
