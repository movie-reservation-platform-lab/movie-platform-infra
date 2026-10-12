/** Programmatic entry points; the executable is `cli/main.ts`. */
export { EXIT_CODES, runCli, type CliDependencies, type CliStreams } from './cli/cli';
export { RUN_CONFIG_DEFAULTS, RUN_CONFIG_SCHEMA, parseRunConfig } from './cli/run-config';
export { RESULT_SCHEMA, type ComparisonResult } from './core/comparison-result';
export { runComparison, type ComparisonDependencies } from './core/run-comparison';
