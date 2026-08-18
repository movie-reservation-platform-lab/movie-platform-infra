/** Executable entrypoint kept separate from the importable CLI test seam. */

import { runCli } from './index';

process.exitCode = runCli(process.argv.slice(2));
