export class CleanupFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanupFailure';
  }
}

export function failCleanup(message: string): never {
  throw new CleanupFailure(message);
}
