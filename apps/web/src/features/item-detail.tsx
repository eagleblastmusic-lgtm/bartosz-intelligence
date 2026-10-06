import { useEffect, useState } from 'react';
import type {
  ItemDetail as Detail,
  CanonicalPage,
} from '../../../../packages/contracts/src/item-detail.js';
import type { enrichEconomy } from '../../../../packages/core/src/ai/enrichment/canonical.js';
import { api, errorMessage } from '../app/api.js';
import { AppLink, today } from '../app/router.js';
import { EvidenceChips } from '../components/evidence-drawer.js';
import { ItemOrganization } from '../components/item-organization.js';
type Canonical = Awaited<ReturnType<typeof enrichEconomy>>['canonical'];
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
async function hash(bytes: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
export async function readCanonical(
  detail: Detail,
  signal: AbortSignal,
): Promise<Canonical | null> {
  if (!detail.canonical || !detail.selected_run_id) return null;
  const descriptor = detail.canonical;
  if (
    !Number.isSafeInteger(descriptor.byte_size) ||
    descriptor.byte_size < 1 ||
    descriptor.byte_size > 8 * 1024 * 1024 ||
    descriptor.chunk_count < 1 ||
    descriptor.chunk_count > 1024
  )
    throw new Error('CANONICAL_DESCRIPTOR_INVALID');
  const bytes = new Uint8Array(descriptor.byte_size);
  let index = 0,
    offset = 0;
  do {
    const page = await api<CanonicalPage>(
      '/items/' +
        encodeURIComponent(detail.item_id) +
        '/canonical?' +
        new URLSearchParams({
          run_id: detail.selected_run_id,
          start: String(index),
        }),
      undefined,
      undefined,
      signal,
    );
    if (
      page.descriptor.artifact_id !== descriptor.artifact_id ||
      page.descriptor.content_hash !== descriptor.content_hash ||
      page.descriptor.byte_size !== descriptor.byte_size ||
      page.descriptor.chunk_count !== descriptor.chunk_count ||
      !page.chunks.length ||
      page.chunks.length > 4
    )
      throw new Error('CANONICAL_DESCRIPTOR_CHANGED');
    for (const chunk of page.chunks) {
      const part = decode(chunk.body_base64);
      if (
        chunk.chunk_index !== index ||
        chunk.byte_start !== offset ||
        chunk.byte_size !== part.length ||
        part.length > 32768 ||
        offset + part.length > bytes.length ||
        (await hash(part)) !== chunk.byte_hash
      )
        throw new Error('CANONICAL_CONTENT_INVALID');
      bytes.set(part, offset);
      offset += part.length;
      index++;
    }
    if (page.next_index !== (index < descriptor.chunk_count ? index : null))
      throw new Error('CANONICAL_PAGE_INVALID');
  } while (index < descriptor.chunk_count);
  if (
    offset !== bytes.length ||
    (await hash(bytes)) !== descriptor.content_hash
  )
    throw new Error('CANONICAL_CONTENT_INVALID');
  const result = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
  ) as Canonical;
  if (
    result.schema_version !== '1.2' ||
    result.item_id !== detail.item_id ||
    !Array.isArray(result.enabled_modules)
  )
    throw new Error('CANONICAL_IDENTITY_INVALID');
  return result;
}
export function ItemDetail({ route }: { route: string }) {
  const url = new URL(route, location.origin),
    itemId = url.pathname.slice('/items/'.length),
    returnTo = url.searchParams.get('return'),
    back =
      returnTo &&
      (returnTo.startsWith('/daily/') ||
        /^\/(?:ledger|search)(?:\?|$)/.test(returnTo) ||
        /^\/entities\/[A-Za-z0-9_-]+$/.test(returnTo))
        ? returnTo
        : '/daily/' + today(),
    [stored, setStored] = useState<{
      id: string;
      detail: Detail;
      canonical: Canonical | null;
    } | null>(null),
    current = stored?.id === itemId ? stored : null,
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    void (async () => {
      const detail = await api<Detail>(
        '/items/' + encodeURIComponent(itemId) + '/detail',
        undefined,
        undefined,
        controller.signal,
      );
      const canonical = await readCanonical(detail, controller.signal);
      if (!controller.signal.aborted)
        setStored({ id: itemId, detail, canonical });
    })()
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [itemId, revision]);
  const canonical = current?.canonical,
    modules = [
      ['claims', 'Twierdzenia'],
      ['stance', 'Stanowiska'],
      ['predictions', 'Przewidywania'],
      ['usage', 'Użycie'],
      ['recommendations', 'Rekomendacje'],
      ['uncertainties', 'Niepewności'],
      ['contradictions', 'Możliwe sprzeczności'],
    ] as const;
  return (
    <>
      <AppLink href={back}>
        {back.startsWith('/ledger') ? '← Powrót do wiedzy' : '← Powrót do dnia'}
      </AppLink>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Materiał źródłowy</p>
          <h1>{current?.detail.title ?? 'Odczyt materiału'}</h1>
          {current && (
            <p className="muted">
              {current.detail.creator} ·{' '}
              {current.detail.published_at
                ? new Date(current.detail.published_at).toLocaleString(
                    'pl-PL',
                    { timeZone: 'Europe/Warsaw' },
                  )
                : 'Data publikacji nieustalona'}
            </p>
          )}
        </div>
        <button
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          Odśwież wynik
        </button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {current && (
        <ItemOrganization
          key={itemId}
          itemId={itemId}
          runId={current.detail.selected_run_id}
          observations={
            canonical
              ? [
                  ...canonical.claims,
                  ...canonical.stance,
                  ...canonical.predictions,
                ]
              : []
          }
        />
      )}
      {busy && (
        <p role="status">
          {current
            ? 'Odświeżanie; widoczny jest poprzedni przyjęty wynik.'
            : 'Pobieranie przyjętego wyniku…'}
        </p>
      )}
      {current && (
        <>
          <a
            href={current.detail.canonical_url}
            target="_blank"
            rel="noreferrer"
          >
            Otwórz materiał źródłowy
          </a>
          {current.detail.analysis_status !== 'READY' && (
            <p className="notice">
              Stan analizy: {current.detail.analysis_status}
              {current.detail.reason ? ' · ' + current.detail.reason : ''}.{' '}
              {current.detail.processing_state
                ? 'Przetwarzanie: ' + current.detail.processing_state
                : ''}
            </p>
          )}
          {!canonical ? (
            <p>
              Przyjęty wynik nie jest jeszcze dostępny. Materiał pozostaje w
              trwałym procesie.
            </p>
          ) : (
            <article className="reading-pane">
              {current.detail.view?.relational_coverage ===
                'WITHIN_CHUNKS_ONLY' && (
                <p className="notice">
                  Zakres relacji jest częściowy: sprzeczności oceniono tylko
                  wewnątrz poszczególnych fragmentów. Relacje między fragmentami
                  nie zostały ocenione.
                </p>
              )}
              {canonical.source_issues.length > 0 && (
                <p className="notice">
                  Ograniczenia źródła: {canonical.source_issues.join(' · ')}
                </p>
              )}
              <section>
                <h2>Notatki</h2>
                {canonical.enabled_modules.includes('summary') ? (
                  canonical.summary_pl.map((note, index) => (
                    <div key={index}>
                      <p>{note.text_pl}</p>
                      <EvidenceChips
                        ids={note.evidence_ids}
                        evidence={canonical.evidence}
                        runId={current.detail.selected_run_id!}
                      />
                    </div>
                  ))
                ) : (
                  <p className="muted">Podsumowanie wyłączono w profilu.</p>
                )}
              </section>
              <section>
                <h2>Kluczowe punkty</h2>
                {canonical.enabled_modules.includes('key_points') ? (
                  <ul>
                    {canonical.key_points.map((note, index) => (
                      <li key={index}>
                        {note.text_pl}
                        <EvidenceChips
                          ids={note.evidence_ids}
                          evidence={canonical.evidence}
                          runId={current.detail.selected_run_id!}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Kluczowe punkty wyłączono w profilu.</p>
                )}
              </section>
              <section>
                <h2>
                  {canonical.enabled_modules.includes('entities')
                    ? 'Encje'
                    : 'Encje referencyjne'}
                </h2>
                {!canonical.enabled_modules.includes('entities') &&
                  canonical.entities.length > 0 && (
                    <p className="metadata">
                      Wzmianki potrzebne do odwołań wybranych rekordów. Moduł
                      encji jest wyłączony.
                    </p>
                  )}
                <ul className="entity-list">
                  {canonical.entities.map((entity) => (
                    <li key={entity.entity_id}>
                      {entity.label}{' '}
                      <span className="metadata">{entity.entity_type}</span>
                      <EvidenceChips
                        ids={entity.evidence_ids}
                        evidence={canonical.evidence}
                        runId={current.detail.selected_run_id!}
                      />
                    </li>
                  ))}
                </ul>
                {!canonical.entities.length && (
                  <p className="muted">
                    {canonical.enabled_modules.includes('entities')
                      ? 'Brak encji w wyniku.'
                      : 'Encje wyłączono w profilu.'}
                  </p>
                )}
              </section>
              <section>
                <h2>Narzędzia</h2>
                {canonical.tools.map((tool, index) => (
                  <div key={index}>
                    <p>
                      <strong>
                        {canonical.entities.find(
                          (entity) => entity.entity_id === tool.entity_ref,
                        )?.label ?? 'Narzędzie'}
                      </strong>{' '}
                      — {tool.context_pl}
                    </p>
                    <EvidenceChips
                      ids={tool.evidence_ids}
                      evidence={canonical.evidence}
                      runId={current.detail.selected_run_id!}
                    />
                  </div>
                ))}
                {!canonical.tools.length && (
                  <p className="muted">
                    {canonical.enabled_modules.includes('tools')
                      ? 'Brak narzędzi w wyniku.'
                      : 'Narzędzia wyłączono w profilu.'}
                  </p>
                )}
              </section>
              {modules.map(([kind, label]) => (
                <section key={kind}>
                  <h2>{label}</h2>
                  {!canonical.enabled_modules.includes(kind) ? (
                    <p className="muted">Moduł wyłączono w profilu.</p>
                  ) : canonical[kind].length === 0 ? (
                    <p className="muted">Brak pozycji w wyniku.</p>
                  ) : (
                    canonical[kind].map((row) => (
                      <div
                        className="observation"
                        id={'observation-' + row.observation_id}
                        key={row.observation_id}
                      >
                        <p className="metadata">
                          {row.kind === 'CONTRADICTION'
                            ? 'Możliwa sprzeczność — interpretacja analizy'
                            : row.attribution === 'SOURCE_SPEAKER'
                              ? 'Wypowiedź źródła'
                              : row.attribution === 'REPORTED_OTHER'
                                ? 'Źródło relacjonuje cudzą wypowiedź'
                                : 'Autorstwo wypowiedzi nieustalone'}
                        </p>
                        <p>{row.content_pl}</p>
                        {row.qualifiers.length > 0 && (
                          <p>
                            Warunki i zastrzeżenia: {row.qualifiers.join(' · ')}
                          </p>
                        )}
                        {row.prediction_horizon && (
                          <p>Horyzont: {row.prediction_horizon}</p>
                        )}
                        {row.stance_polarity && (
                          <p>Stanowisko: {row.stance_polarity}</p>
                        )}
                        {row.usage_stage && (
                          <p>
                            Etap użycia:{' '}
                            {(
                              {
                                TRIED: 'wypróbowano',
                                USES: 'używa',
                                ADOPTED: 'wdrożono',
                                STOPPED: 'zaprzestano użycia',
                                REJECTED: 'odrzucono',
                                UNCLEAR: 'nieustalony',
                              } as Record<string, string>
                            )[row.usage_stage] ?? row.usage_stage}
                          </p>
                        )}
                        {row.kind === 'CONTRADICTION' && (
                          <div
                            role="group"
                            aria-label="Wypowiedzi porównywane w relacji"
                          >
                            {row.relation_refs.map((id, index) => {
                              const side = modules
                                .flatMap(([kind]) => canonical[kind])
                                .find(
                                  (candidate) =>
                                    candidate.observation_id === id,
                                );
                              return side ? (
                                <div key={id}>
                                  <a href={'#observation-' + id}>
                                    {index === 0
                                      ? 'Pierwsza wypowiedź'
                                      : 'Druga wypowiedź'}
                                  </a>
                                  <p>{side.content_pl}</p>
                                  <EvidenceChips
                                    ids={side.evidence_ids}
                                    evidence={canonical.evidence}
                                    runId={current.detail.selected_run_id!}
                                  />
                                </div>
                              ) : (
                                <p key={id} className="notice">
                                  Wypowiedź niedostępna w tym wyniku.
                                </p>
                              );
                            })}
                          </div>
                        )}
                        <EvidenceChips
                          ids={row.evidence_ids}
                          evidence={canonical.evidence}
                          runId={current.detail.selected_run_id!}
                        />
                      </div>
                    ))
                  )}
                </section>
              ))}
              <details>
                <summary>Informacje o wyniku</summary>
                <p>
                  Profil: {canonical.profile_id} · wersja{' '}
                  {canonical.profile_revision} · schema{' '}
                  {canonical.schema_version}
                </p>
                <p>
                  Semantyczna prawdziwość wypowiedzi nie została potwierdzona.
                  Treść opisuje to, co mówi źródło.
                </p>
                <p>Run: {current.detail.selected_run_id}</p>
              </details>
            </article>
          )}
        </>
      )}
    </>
  );
}
