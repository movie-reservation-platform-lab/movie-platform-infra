const MAX_ERROR_LENGTH = 300;

/**
 * Turn any error into a short message that is safe to print and to keep in
 * evidence. AWS errors often name the caller's role ARN, account, or session
 * email, and Node errors name private file paths and hosts; operators paste
 * terminal output into public issues, so those are masked.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return redact(String(error));
  }
  return redact(error.name === 'Error' ? error.message : `${error.name}: ${error.message}`);
}

export function redact(text: string): string {
  const masked = text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>;,]+/gi, '<url>')
    .replace(/arn:aws[\w-]*:[^\s"',)]+/g, '<arn>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/\b\d{12}\b/g, '<account>')
    .replace(/(?<![\w<])\/(?:[\w.-]+\/)*[\w.-]+/g, '<path>');
  return masked.length > MAX_ERROR_LENGTH ? `${masked.slice(0, MAX_ERROR_LENGTH)}...` : masked;
}
