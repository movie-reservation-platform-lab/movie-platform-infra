import { runCli } from './cli';

void runCli(process.argv.slice(2)).then((status) => {
  process.exitCode = status;
});
