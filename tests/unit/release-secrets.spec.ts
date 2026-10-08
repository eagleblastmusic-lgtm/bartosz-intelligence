import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scanPublicBuild } from '../../tools/release/secrets.js';
const canary = 'synthetic-secret-canary-42/a+b';
it.each(['plain', 'url', 'base64', 'clean'] as const)(
  'scans public assets without disclosing secrets (%s)',
  (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'bi-secret-scan-'));
    try {
      writeFileSync(
        join(root, 'index.html'),
        '<html>Public application</html>',
      );
      writeFileSync(
        join(root, 'app.js'),
        mode === 'plain'
          ? canary
          : mode === 'url'
            ? encodeURIComponent(canary)
            : mode === 'base64'
              ? Buffer.from(canary).toString('base64')
              : 'public-code',
      );
      const report = scanPublicBuild(root, {
        GEMINI_API_KEY: canary,
        APP_ORIGIN: 'https://example.test',
      });
      expect(report.status).toBe(mode === 'clean' ? 'PASS' : 'FAIL');
      expect(report.findings).toEqual(mode === 'clean' ? [] : ['app.js']);
      expect(JSON.stringify(report)).not.toContain(canary);
      expect(report.files_scanned).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it('does not qualify an empty input or missing public build', () => {
  const root = mkdtempSync(join(tmpdir(), 'bi-secret-scan-'));
  try {
    expect(() => scanPublicBuild(root, {})).toThrow(
      'SECRET_SCAN_INPUT_REQUIRED',
    );
    expect(() =>
      scanPublicBuild(root, { SESSION_SIGNING_SECRET: canary }),
    ).toThrow('PUBLIC_BUILD_REQUIRED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
