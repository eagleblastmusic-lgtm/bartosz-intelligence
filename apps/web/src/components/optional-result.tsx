import { useEffect, useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import { readPinnedJSON } from '../app/artifacts.js';
import { EvidenceChips } from './evidence-drawer.js';
import { AppLink } from '../app/router.js';
import type { OptionalResultProjection } from '../../../../packages/core/src/projections/optional.js';
import type { mapTranslation } from '../../../../packages/core/src/ai/tasks/translation.js';
import type { mapHistory } from '../../../../packages/core/src/ai/tasks/history.js';
type Page = Awaited<ReturnType<OptionalResultProjection['page']>>;
type Translation = Awaited<ReturnType<typeof mapTranslation>>['canonical'];
type History = Awaited<ReturnType<typeof mapHistory>>['canonical'];
export function OptionalResult({
  runId,
  itemId,
}: {
  runId: string;
  itemId: string;
}) {
  const [value, setValue] = useState<{
      page: Page;
      canonical: Translation | History;
    } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setValue(null);
    setError('');
    const path = '/optional/result/' + encodeURIComponent(runId);
    (async () => {
      const first = await api<Page>(
        path + '?start=0',
        undefined,
        undefined,
        controller.signal,
      );
      if (first.run_id !== runId || first.item_id !== itemId)
        throw new Error('OPTIONAL_RESULT_IDENTITY');
      const canonical = (await readPinnedJSON(
        first.descriptor,
        async (index, signal) => {
          const page =
            index === 0
              ? first
              : await api<Page>(
                  path + '?start=' + index,
                  undefined,
                  undefined,
                  signal,
                );
          if (
            page.run_id !== runId ||
            page.item_id !== itemId ||
            JSON.stringify(page.context) !== JSON.stringify(first.context)
          )
            throw new Error('OPTIONAL_RESULT_IDENTITY');
          return page;
        },
        controller.signal,
      )) as Translation | History;
      if (
        canonical.schema_version !== '1.0' ||
        (first.context.task === 'TRANSLATE'
          ? !('translated_segments' in canonical) ||
            canonical.source_artifact_id !== first.context.source_artifact_id
          : !('relations' in canonical) || canonical.current_item_id !== itemId)
      )
        throw new Error('OPTIONAL_RESULT_IDENTITY');
      if (!controller.signal.aborted) setValue({ page: first, canonical });
    })().catch((error) => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    });
    return () => controller.abort();
  }, [runId, itemId]);
  if (error)
    return (
      <p role="alert" className="notice error">
        {error}
      </p>
    );
  if (!value) return <p role="status">Weryfikowanie wyniku…</p>;
  const { canonical, page } = value;
  return (
    <article className="reading-pane" aria-label="Wynik zadania opcjonalnego">
      {'translated_segments' in canonical ? (
        <>
          <h3>Polski helper źródła</h3>
          <p>
            Zakres:{' '}
            {canonical.scope === 'FULL'
              ? 'całe źródło'
              : canonical.scope === 'CHUNK'
                ? 'fragment źródła'
                : 'wybrane segmenty dowodów'}
            . Oryginał pozostaje podstawą Evidence.
          </p>
          {canonical.translated_segments.map((s) => {
            const time =
              page.context.task === 'TRANSLATE'
                ? page.context.segments.find(
                    (t) => t.source_segment_id === s.source_segment_id,
                  )
                : null;
            return (
              <div key={s.source_segment_id}>
                <p className="metadata">
                  {time?.start_ms === null || !time
                    ? 'Czas nieznany'
                    : 'Czas źródła: ' +
                      (time.start_ms / 1000).toFixed(1) +
                      ' s'}
                </p>
                <p>{s.text_pl}</p>
                {s.issues.length > 0 && (
                  <p className="notice">{s.issues.join(' · ')}</p>
                )}
              </div>
            );
          })}
        </>
      ) : (
        <>
          <h3>Porównanie ograniczonej historii</h3>
          <p>{canonical.scope_note_pl}</p>
          <p>Status: {canonical.status}</p>
          {canonical.relations.map((relation) => (
            <section key={relation.local_id} aria-label="Relacja w historii">
              <p className="metadata">
                Możliwa relacja — interpretacja analizy:{' '}
                {
                  {
                    CONSISTENT: 'zgodny zakres',
                    POSSIBLE_CHANGE: 'możliwa zmiana',
                    POSSIBLE_CONTRADICTION: 'możliwa sprzeczność',
                    DIFFERENT_CONTEXT: 'różny kontekst',
                    NOT_COMPARABLE: 'nieporównywalne',
                  }[relation.relation_type]
                }
              </p>
              <p>{relation.explanation_pl}</p>
              {relation.qualifiers.length > 0 && (
                <p>{relation.qualifiers.join(' · ')}</p>
              )}
              {[
                ...relation.current_observation_refs,
                ...relation.prior_observation_refs,
              ].map((id) => {
                const row =
                  page.context.task === 'HISTORICAL_COMPARE'
                    ? page.context.observations.find(
                        (o) => o.observation_id === id,
                      )
                    : null;
                return row ? (
                  <div key={id}>
                    <AppLink href={'/items/' + encodeURIComponent(row.item_id)}>
                      Otwórz wypowiedź w materiale
                    </AppLink>
                    <p>{row.content_pl}</p>
                    <EvidenceChips
                      ids={(relation.current_observation_refs.includes(id)
                        ? relation.current_evidence_refs
                        : relation.prior_evidence_refs
                      ).filter((ref) =>
                        row.evidence.some((e) => e.evidence_id === ref),
                      )}
                      evidence={row.evidence}
                      runId={row.run_id}
                    />
                  </div>
                ) : (
                  <p key={id}>Wypowiedź niedostępna w zakresie.</p>
                );
              })}
            </section>
          ))}
        </>
      )}
      {canonical.limitations_pl.length > 0 && (
        <p className="notice">
          Ograniczenia: {canonical.limitations_pl.join(' · ')}
        </p>
      )}
    </article>
  );
}
