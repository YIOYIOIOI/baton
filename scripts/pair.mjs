import { runPairCommand } from '../src/pair-client.js';

const exitCode = await runPairCommand(process.argv.slice(2));
if (exitCode !== 0) process.exit(exitCode);
