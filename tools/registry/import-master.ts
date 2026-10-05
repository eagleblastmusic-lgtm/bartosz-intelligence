import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const path = 'Plan/BARTOSZ_INTELLIGENCE_MASTER_ARCHITECTURE_2026_v1.1.1.md';
const bytes = readFileSync(path),
  masterHash = createHash('sha256').update(bytes).digest('hex');
if (
  masterHash !==
  '587d082647ffdc4ba9fd9d23f4163f428746d2bf7b4bc9544e7916f6d38823ed'
)
  throw new Error('MASTER_REVISION_CHANGED');
const full = bytes.toString('utf8').replaceAll('\r\n', '\n');
const section = full.slice(
  full.indexOf('## 24. Prompt Pack'),
  full.indexOf('## 25. UX/UI'),
);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const schemas = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
  (match) => {
    const schema = JSON.parse(match[1]!);
    if (typeof schema.$id !== 'string') throw new Error('MISSING_SCHEMA_ID');
    const text = JSON.stringify(schema);
    return {
      id: schema.$id as string,
      version: schema.$id.split(':').at(-1) as string,
      hash: hash(text),
      schema,
    };
  },
);
const prompts = [
  ...section.matchAll(
    /### 24\.\d+ ([A-Z_0-9]+) — prompt_version 2[\s\S]*?```text\n([\s\S]*?)\n```/g,
  ),
].map((match) => ({
  id: match[1]!,
  version: 2,
  hash: hash(match[2]!),
  text: match[2]!,
}));
if (schemas.length !== 9 || prompts.length !== 6)
  throw new Error('INCOMPLETE_MASTER_BUNDLE');
const bundle = {
  format_version: 1,
  master_sha256: masterHash,
  enrichment_version: '1.0',
  schemas,
  prompts,
};
mkdirSync('config/registry', { recursive: true });
writeFileSync(
  'config/registry/master-bundle.json',
  JSON.stringify(bundle, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    schemas: schemas.length,
    prompts: prompts.length,
    master_sha256: masterHash,
  }),
);
