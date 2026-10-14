import { main } from './source-probe.js';
main().catch(() => {
  process.stderr.write('SOURCE_PROBE_FAILED\n');
  process.exitCode = 2;
});
