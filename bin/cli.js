#!/usr/bin/env node
import { dashboard } from '../src/dashboard.js';
import { init } from '../src/init.js';
import { runner } from '../src/run.js';
import { update } from '../src/update.js';
import { CliError, INSTALL_CMD, packageVersion } from '../src/util.js';

const HELP = `software-factory — a Claude Code software factory

Usage:
  ${INSTALL_CMD} init                 Install the factory into this repo
  ${INSTALL_CMD} update [--force]     Refresh the factory's files, keeping your settings and jobs
  ${INSTALL_CMD} dashboard [options]  Serve the live board in your browser
  ${INSTALL_CMD} run [options]        Run jobs headlessly, from the backlog or GitHub, until none are left
  ${INSTALL_CMD} approve <id>         Ship a job that needs a human
  ${INSTALL_CMD} rework <id> <note>   Send a job that needs a human back to the builder

Dashboard options:
  --port <number>   Port to serve on (default 4321, or the next free one)
  --no-open         Don't open a browser

Run options:
  --parallel <n>    Jobs to run at once (default config.runner.parallel, else 1)
  --job <id>        Run only this job

Then, in Claude Code:  /factory setup  ·  /factory <feature>  ·  /factory next`;

function parse(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '-v' || arg === '--version') opts.version = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--no-open') opts.open = false;
    else if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = arg === '--port' ? argv[++i] : arg.slice('--port='.length);
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError(`Invalid port: ${raw}`);
      opts.port = port;
    } else if (arg.startsWith('-')) throw new CliError(`Unknown option: ${arg}\n\n${HELP}`);
    else opts.positional.push(arg);
  }
  return opts;
}

const RUNNER_COMMANDS = new Set(['run', 'approve', 'rework']);

async function main() {
  const argv = process.argv.slice(2);
  // The runner commands are handled, options and all, by the runner installed in the repo.
  if (RUNNER_COMMANDS.has(argv[0])) {
    process.exitCode = await runner(process.cwd(), argv);
    return;
  }
  const opts = parse(argv);
  const [command] = opts.positional;
  if (opts.version) return console.log(packageVersion());
  if (opts.help || !command) return console.log(HELP);

  switch (command) {
    case 'init': return init(process.cwd());
    case 'update': return update(process.cwd(), { force: opts.force });
    case 'dashboard': return dashboard(process.cwd(), { port: opts.port, open: opts.open });
    default: throw new CliError(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch((err) => {
  console.error(err instanceof CliError ? err.message : err);
  process.exitCode = 1;
});
