/**
 * Parses the operator CLI's arguments: one command name, then options. Only the
 * options below exist, each at most once; anything else is an error, never ignored.
 */

/** The parsed command line. */
export interface CliArguments {
  readonly command: string;
  /** `--record`: the experiment record, an absolute private path. */
  readonly recordPath?: string;
  /** `--inputs`: the render inputs file (`render-config` only). */
  readonly inputsPath?: string;
  /** `--out`: where `render-config` writes the CDK config. */
  readonly outPath?: string;
  /** `--execute`: really call AWS; without it, AWS commands only preview. */
  readonly execute: boolean;
}

/** Options that take a path value, and the field each fills. */
const PATH_OPTIONS = {
  '--record': 'recordPath',
  '--inputs': 'inputsPath',
  '--out': 'outPath',
} as const;

type PathOption = keyof typeof PATH_OPTIONS;

/**
 * Parses `args` (without the program name).
 *
 * @throws Error for an unknown option, a repeated option, or a path option without a value
 */
export function parseCliArguments(args: readonly string[]): CliArguments {
  const [command, ...options] = args;
  const paths: Partial<Record<(typeof PATH_OPTIONS)[PathOption], string>> = {};
  let execute = false;

  for (let index = 0; index < options.length; index++) {
    const option = options[index];

    if (option === '--execute') {
      if (execute) {
        throw new Error('Duplicate --execute');
      }

      execute = true;
      continue;
    }

    if (!isPathOption(option)) {
      throw new Error('Unknown sandbox option');
    }

    const field = PATH_OPTIONS[option];
    const value = options[index + 1];

    if (paths[field] !== undefined || !value || value.startsWith('--')) {
      throw new Error(`One ${option} path required`);
    }

    paths[field] = value;
    index++;
  }

  return { command, execute, ...paths };
}

function isPathOption(option: string): option is PathOption {
  return Object.hasOwn(PATH_OPTIONS, option);
}
