#!/usr/bin/env node
import { dashboard } from '../src/dashboard.js';
import { init } from '../src/init.js';
import { update } from '../src/update.js';
import { CliError, INSTALL_CMD, packageVersion } from '../src/util.js';

const HELP = `software-factory — a Claude Code software factory

Usage:
  ${INSTALL_CMD} init                 Install the factory into this repo
  ${INSTALL_CMD} update [--force]     Refresh the factory's files, keeping your settings and jobs
  ${INSTALL_CMD} dashboard [options]  Serve the live board in your browser

Dashboard options:
  --port <number>   Port to serve on (default 4321, or the next free one)
  --no-open         Don't open a browser

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

async function main() {
  const opts = parse(process.argv.slice(2));
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
