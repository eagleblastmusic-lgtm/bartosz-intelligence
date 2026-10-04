import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

function rejectFixture(
  path: string,
  content: string,
  binary: string,
  args: string[],
) {
  writeFileSync(path, content);
  try {
    const result = spawnSync(process.execPath, [binary, ...args], {
      encoding: 'utf8',
    });
    if (result.status === null || result.status === 0)
      throw new Error(`Negative control failed: ${path}`);
    console.log(`PASS rejected ${path}`);
  } finally {
    unlinkSync(path);
  }
}
rejectFixture(
  'apps/api/src/node-negative.ts',
  "import { readFileSync } from 'node:fs';\nexport const invalid = readFileSync('x');\n",
  'node_modules/typescript/bin/tsc',
  ['-p', 'apps/api/tsconfig.json'],
);
rejectFixture(
  'apps/api/src/lint-negative.ts',
  'const unused = 1;\n',
  'node_modules/eslint/bin/eslint.js',
  ['apps/api/src/lint-negative.ts'],
);
rejectFixture(
  'apps/web/src/format-negative.ts',
  'export const   fixture={a:1}\n',
  'node_modules/prettier/bin/prettier.cjs',
  ['--check', 'apps/web/src/format-negative.ts'],
);
