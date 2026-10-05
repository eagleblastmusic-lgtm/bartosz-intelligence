import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('hands off actual gates, migrations, restrictions and preserved history', () => {
  const handoff = readFileSync('docs/handoffs/STAGE_01_COMPLETION.md', 'utf8');
  for (const section of [
    'Implemented',
    'Files/modules created',
    'Database migrations',
    'API/contracts introduced',
    'Tests',
    'Runtime verification',
    'Architecture deviations',
    'Known issues',
    'Deferred items',
    'Measurements',
    'Decisions made during implementation',
    'Guarantees for next stage',
    'Context next stage MUST load',
    'Context next stage DOES NOT need',
  ])
    expect(handoff).toContain(`## ${section}`);
  expect(handoff).toMatch(/Status: (READY_FOR_VERIFICATION|DONE)/);
  expect(handoff).toMatch(/NONE production/);
  expect(handoff).toContain('GateC NOT_RUN');
  const old = JSON.parse(
    readFileSync('docs/verification/gate-0/FINAL_EVALUATION.json', 'utf8'),
  );
  const current = JSON.parse(
    readFileSync('docs/verification/gate-0/FINAL_EVALUATION_V2.json', 'utf8'),
  );
  expect(old.status).toBe('FAIL');
  expect(current.status).toBe('PASS');
  expect(current.original_inputs_unchanged).toBe(true);
  expect(current.metadata_inconsistencies).toHaveLength(7);
  expect(handoff).not.toMatch(/AIza[\w-]{25,}|Bearer\s+[A-Za-z0-9._-]{20,}/);
});
