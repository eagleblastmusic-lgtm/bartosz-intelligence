import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { renderAnnotationSheet } from '../../tools/gates/ai-pilot-annotation.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
test('private annotation form freezes an exact source quote without executing source markup', async ({
  page,
}) => {
  const text = 'Literal </script><script>steal()</script> & 🚀';
  const normalized = await normalizeTranscript(
    await sha256(text),
    [
      {
        upstream_index: 0,
        text,
        start_ms: null,
        end_ms: null,
        speaker_label: null,
      },
    ],
    'NONE',
  );
  const sheet = await renderAnnotationSheet({
    video_id: 'fixture0001',
    source_text: text,
    manifest: normalized.manifest,
    manifest_hash: await sha256(JSON.stringify(normalized.manifest)),
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://127.0.0.1:8787/pilot-annotation-fixture', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: sheet }),
  );
  await page.goto('/pilot-annotation-fixture');
  await expect(page.getByRole('listitem').first()).toContainText(text);
  await expect(page.getByRole('listitem').first()).toContainText(
    'czas nieznany',
  );
  await page
    .getByLabel('Identyfikator osoby anotującej (pseudonim)')
    .fill('fixture-human');
  await page
    .getByRole('button', { name: 'Dodaj zakres do twierdzenia', exact: true })
    .click();
  await expect(page.locator('#ranges')).toHaveText('Dodanych zakresów: 1');
  await page
    .getByLabel('Twierdzenie zapisane własnymi słowami')
    .fill('Fixture annotation only, not real pilot evidence.');
  await page
    .getByRole('button', { name: 'Zapisz twierdzenie', exact: true })
    .click();
  const downloaded = page.waitForEvent('download');
  await page
    .getByRole('button', {
      name: 'Zamroź i pobierz anotacje JSON',
      exact: true,
    })
    .click();
  const file = await downloaded;
  const annotation = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(annotation.source_hash).toBe(await sha256(text));
  expect(annotation.important_claims[0].anchors[0]).toEqual({
    segment_ids: [normalized.manifest.anchors[0]!.segment_id],
    quote_hash: await sha256(text),
  });
  expect(annotation.annotator_id).toBe('fixture-human');
  expect(Number.isFinite(Date.parse(annotation.frozen_at))).toBe(true);
  await expect(
    page.getByRole('button', {
      name: 'Zamroź i pobierz anotacje JSON',
      exact: true,
    }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
