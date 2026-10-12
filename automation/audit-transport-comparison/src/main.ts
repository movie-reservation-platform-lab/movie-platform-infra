import { runCli } from './index';

void runCli(process.argv.slice(2)).then((status) => {
  process.exitCode = status;
});
