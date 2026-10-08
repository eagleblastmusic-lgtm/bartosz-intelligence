import { resolve } from 'node:path';
import { scanPublicBuild } from './secrets.js';
if (process.argv.length !== 2)
  throw new Error('UNSUPPORTED_SECRET_SCAN_ARGUMENT');
try {
  const report = scanPublicBuild(resolve('apps/web/dist'), process.env);
  console.log(JSON.stringify(report));
  if (report.status !== 'PASS') process.exitCode = 2;
} catch (error) {
  console.log(
    JSON.stringify({
      status: 'FAIL',
      reason:
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'SECRET_SCAN_FAILED',
      secret_values_recorded: false,
    }),
  );
  process.exitCode = 2;
}
