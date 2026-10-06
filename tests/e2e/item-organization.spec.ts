import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
test('owner organizes one item into Spaces, preserves reading state after new analysis and authors inert notes', async ({
  page,
}) => {
  const origin = 'https://organization.fixture.invalid';
  const canonical = Buffer.from(
    JSON.stringify({
      schema_version: '1.2',
      item_id: 'item-a',
      source_artifact_id: 'source',
      status: 'OK',
      source_issues: [],
      enabled_modules: ['claims'],
      profile_id: 'economy',
      profile_revision: 1,
      summary_pl: [],
      key_points: [],
      entities: [],
      tools: [],
      evidence: [],
      stance: [],
      predictions: [],
      claims: [
        {
          observation_id: 'obs-a',
          content_pl: 'Synthetic source statement',
          attribution: 'SOURCE_SPEAKER',
          qualifiers: [],
          evidence_ids: [],
          entity_refs: [],
        },
      ],
    }),
  );
  const digest = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('hex');
  let noteMutation: string | null = null;
  const descriptor = {
    artifact_id: 'canonical',
    content_hash: digest(canonical),
    byte_size: canonical.length,
    chunk_count: 1,
    schema_version: 'intelligence-canonical:1.2',
  };
  let selected = 'run-old',
    revision = 0,
    saved = 0,
    read_at: string | null = null,
    reviewed_run_id: string | null = null,
    rejectSave = true,
    posts = 0;
  const spaces: {
      space_id: string;
      name: string;
      active: number;
      revision: number;
    }[] = [],
    memberships: {
      space_id: string;
      name: string;
      active: number;
      revision: number;
      space_active: number;
    }[] = [],
    notes: {
      insight_id: string;
      text: string;
      authored_by: string;
      active: number;
      revision: number;
      created_at: string;
      updated_at: string;
    }[] = [],
    refs: { insight_id: string; observation_id: string }[] = [];
  await page.context().addCookies([
    {
      name: '__Host-bi-csrf',
      value: 'fixture-csrf',
      url: origin + '/',
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.endsWith('/auth/session'))
        return route.fulfill({ json: { authenticated: true } });
      if (url.pathname.endsWith('/detail'))
        return route.fulfill({
          json: {
            item_id: 'item-a',
            title: 'Organization fixture',
            creator: 'Synthetic author',
            published_at: null,
            analysis_status: 'READY',
            processing_state: 'SUCCEEDED',
            selected_run_id: selected,
            canonical: descriptor,
          },
        });
      if (url.pathname.endsWith('/canonical'))
        return route.fulfill({
          json: {
            descriptor,
            chunks: [
              {
                chunk_index: 0,
                byte_start: 0,
                byte_size: canonical.length,
                byte_hash: digest(canonical),
                body_base64: canonical.toString('base64url'),
              },
            ],
            next_index: null,
          },
        });
      if (route.request().method() === 'POST') {
        expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
        posts++;
        const input = route.request().postDataJSON();
        if (url.pathname.endsWith('/review')) {
          expect(input.expected_revision).toBe(revision);
          if (input.action === 'SAVE' && rejectSave) {
            rejectSave = false;
            return route.fulfill({
              status: 409,
              json: { code: 'REVISION_CONFLICT' },
            });
          }
          if (input.action === 'SAVE') saved = 1;
          if (input.action === 'READ') read_at = '2026-10-06T18:00:00Z';
          if (input.action === 'REVIEW')
            reviewed_run_id = input.reviewed_run_id;
          revision++;
        } else if (url.pathname.endsWith('/spaces'))
          spaces.push({
            space_id: input.space_id,
            name: input.name,
            active: 1,
            revision: 1,
          });
        else if (url.pathname.endsWith('/membership'))
          memberships.push({
            ...spaces.find((space) => space.space_id === input.space_id)!,
            active: Number(input.active),
            space_active: 1,
          });
        else if (url.pathname.endsWith('/insights')) {
          if (input.expected_revision > 0) {
            expect(input.expected_revision).toBe(notes[0]!.revision);
            notes[0] = {
              ...notes[0]!,
              text: input.text,
              active: Number(input.active),
              revision: input.expected_revision + 1,
            };
            return route.fulfill({ json: { duplicate: false } });
          }
          if (noteMutation) {
            expect(input.mutation_id).toBe(noteMutation);
            expect(input.insight_id).toBe(notes[0]!.insight_id);
            return route.fulfill({ json: { duplicate: true } });
          }
          noteMutation = input.mutation_id;
          notes.push({
            insight_id: input.insight_id,
            text: input.text,
            authored_by: 'owner',
            active: 1,
            revision: 1,
            created_at: '2026-10-06T18:00:00Z',
            updated_at: '2026-10-06T18:00:00Z',
          });
          refs.push(
            ...input.observation_ids.map((id: string) => ({
              insight_id: input.insight_id,
              observation_id: id,
            })),
          );
          return route.fulfill({
            status: 500,
            json: { code: 'INTERNAL_ERROR' },
          });
        } else throw new Error('UNEXPECTED_ORGANIZATION_MUTATION');
        return route.fulfill({ json: { duplicate: false } });
      }
      if (url.pathname.endsWith('/spaces'))
        return route.fulfill({ json: { spaces, has_more: false } });
      expect(url.pathname).toBe('/api/v1/organization/items/item-a');
      return route.fulfill({
        json: {
          review: {
            revision,
            saved,
            read_at,
            last_opened: null,
            reviewed_run_id,
            accepted_run_id: selected,
            updated: !!reviewed_run_id && reviewed_run_id !== selected,
          },
          memberships,
          insights: notes,
          insights_has_more: false,
          observation_refs: refs,
          observation_refs_has_more: false,
        },
      });
    }
    const response = await fetch('http://127.0.0.1:8787' + url.pathname);
    return route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.goto(origin + '/items/item-a');
  await page
    .getByRole('button', { name: 'Organizacja i notatki', exact: true })
    .click();
  await expect(page.getByText('Niezapisany.', { exact: true })).toBeVisible();
  expect(posts).toBe(0);
  await page.getByRole('button', { name: 'Zapisz na później' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Niezapisany.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Zapisz na później' }).click();
  await expect(
    page.getByRole('button', { name: 'Usuń z zapisanych' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Oznacz jako przeczytany' }).click();
  await page
    .getByRole('button', { name: 'Oznacz ten wynik jako przejrzany' })
    .click();
  for (const name of ['Research', 'Tools']) {
    await page.getByLabel('Nazwa nowego Space').fill(name);
    await page.getByRole('button', { name: 'Utwórz Space' }).click();
    await page.getByRole('button', { name: 'Dodaj do Space: ' + name }).click();
    await expect(
      page.getByRole('button', { name: 'Usuń ze Space: ' + name }),
    ).toBeVisible();
  }
  await page
    .getByLabel('Treść własnej notatki')
    .fill('<img src=x onerror=alert(1)> **Owner note**');
  await page.getByLabel('Powiązane wypowiedzi (do 20)').selectOption('obs-a');
  await page.getByRole('button', { name: 'Zapisz własną notatkę' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Treść własnej notatki')).toHaveValue(
    '<img src=x onerror=alert(1)> **Owner note**',
  );
  await page.getByRole('button', { name: 'Zapisz własną notatkę' }).click();
  await expect(
    page.getByText('<img src=x onerror=alert(1)> **Owner note**', {
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);
  expect(notes).toHaveLength(1);
  await page.getByRole('button', { name: 'Edytuj notatkę' }).click();
  await page
    .getByLabel('Treść własnej notatki')
    .fill('Unsaved draft should not replace archived note');
  await page.getByRole('button', { name: 'Archiwizuj notatkę' }).click();
  await expect(
    page.getByRole('button', { name: 'Przywróć notatkę' }),
  ).toBeVisible();
  expect(notes[0]!.text).toBe('<img src=x onerror=alert(1)> **Owner note**');
  await page.getByRole('button', { name: 'Przywróć notatkę' }).click();
  await expect(
    page.getByRole('button', { name: 'Archiwizuj notatkę' }),
  ).toBeVisible();
  selected = 'run-new';
  await page.getByRole('button', { name: 'Odśwież wynik' }).click();
  await expect(page.getByRole('status')).toContainText('Wynik zaktualizowany');
  await expect(
    page.getByRole('button', { name: 'Usuń z zapisanych' }),
  ).toBeVisible();
  expect(read_at).toBeTruthy();
  expect(reviewed_run_id).toBe('run-old');
  expect(refs).toHaveLength(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
