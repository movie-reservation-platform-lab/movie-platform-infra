/** Runtime JSON boundaries remain unknown until these checks succeed. */
export function object(value: unknown, label = 'object'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }

  return value as Record<string, unknown>;
}

export function array(value: unknown, label = 'array'): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }

  return value;
}

export function string(value: unknown, label = 'string'): string {
  if (typeof value !== 'string' || !value.length) {
    throw new Error(`invalid ${label}`);
  }

  return value;
}

export function number(value: unknown, label = 'number'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid ${label}`);
  }

  return value;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('unsupported input field');
  }
}
