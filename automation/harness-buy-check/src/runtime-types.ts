/** Shared task execution contracts; no AWS calls or workflow decisions live here. */
import type { AwsCall } from './aws-cli';
import type { ProbePath } from './probe';

/** External capabilities injected into a trial task; tests supply fake implementations. */
export interface RuntimePorts {
  /** Executes one AWS operation with an argument array. */
  call: AwsCall;
  /** Current time in milliseconds on the same clock used by watcher heartbeats. */
  now(): number;
  /** Waits the requested number of milliseconds. */
  sleep(ms: number): Promise<void>;
  /** Whether the selected task endpoint passes the HTTP response contract. */
  probe(ip: string, path: ProbePath): Promise<boolean>;
}

/** Trial task outcome printed by the CLI; rollback evidence is present only when verified. */
export interface TaskResult {
  /** Zero for success; nonzero failures remain visible to the pipeline engine. */
  exitCode: number;
  reason: string;
  reverted?: boolean;
  /** Registered candidate task-definition ARN, when a release was attempted. */
  revision?: string;
  originalTaskDefinitionArn?: string;
  observedOriginalDigest?: string;
}
