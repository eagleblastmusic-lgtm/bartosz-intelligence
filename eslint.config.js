import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.wrangler/**',
      '.tools/**',
      '.local/**',
      'Plan/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['node:*', 'fs', 'path', 'child_process'] },
      ],
    },
  },
);
