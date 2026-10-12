import type { LoginOutcome } from './comparison-result';

/** How one comparison run behaves; parsed from the run file by `cli/run-config.ts`. */
export interface ComparisonSettings {
  readonly attempts: Readonly<Record<LoginOutcome, number>>;
  /** Hard deadline for the whole run, measured from its start. */
  readonly timeoutSeconds: number;
  readonly pollIntervalSeconds: number;
  /** Start the Security Lake crawler once so new `eventday` partitions become queryable. */
  readonly refreshCatalog: boolean;
  /** Wait after the last login before starting the crawler: one buffer interval plus margin. */
  readonly catalogRefreshDelaySeconds: number;
}

export interface DemoCredentials {
  readonly username: string;
  readonly password: string;
}

/** Facts established before the run: the preflighted workload account and the demo credentials. */
export interface ComparisonContext {
  readonly credentials: DemoCredentials;
  readonly workloadAccountId: string;
  readonly region: string;
}
