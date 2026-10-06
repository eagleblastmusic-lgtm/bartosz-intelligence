import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { KnowledgeSearch } from '../../../../packages/core/src/knowledge/search.js';
import { api, errorMessage } from '../app/api.js';
import { AppLink, navigate } from '../app/router.js';
type Snapshot = Awaited<ReturnType<KnowledgeSearch['page']>>;
const labels: Record<string, string> = {
  ITEM: 'Tytuł',
  OBSERVATION: 'Obserwacja',
  INSIGHT: 'Notatka właściciela',
  ENTITY: 'Encja',
  ALIAS: 'Alias',
  SUMMARY_PREVIEW: 'Skrót analizy',
};
export function Search({ route }: { route: string }) {
  const params = new URL(route, location.origin).searchParams;
  const key = params.toString(),
    query = params.get('q') ?? '';
  const current = useRef(key);
  current.current = key;
  const [draft, setDraft] = useState(query),
    [kind, setKind] = useState(params.get('kind') ?? ''),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    setDraft(query);
    setKind(params.get('kind') ?? '');
    setSnapshot(null);
    setError('');
    if (!query) {
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    const next = new URLSearchParams(key);
    next.set('limit', '20');
    void api<Snapshot>(
      '/search?' + next,
      undefined,
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setSnapshot(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [key, revision]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams(key);
    next.delete('cursor');
    next.delete('limit');
    next.set('q', draft.trim());
    if (kind) next.set('kind', kind);
    else next.delete('kind');
    navigate('/search?' + next);
  }
  async function more() {
    if (!snapshot?.next_cursor || busy) return;
    setBusy(true);
    setError('');
    const next = new URLSearchParams(key);
    next.set('limit', '20');
    next.set('cursor', snapshot.next_cursor);
    try {
      const result = await api<Snapshot>('/search?' + next);
      if (current.current === key)
        setSnapshot({
          ...result,
          documents: [...snapshot.documents, ...result.documents],
        });
    } catch (error) {
      if (current.current === key) setError(errorMessage(error));
    } finally {
      if (current.current === key) setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Wyszukiwanie w Wiedzy</h1>
          <AppLink href="/ledger">Obserwacje</AppLink>
        </div>
        <button
          type="button"
          disabled={busy || !query}
          onClick={() => setRevision((value) => value + 1)}
        >
          Odśwież
        </button>
      </div>
      <form className="filter-bar" onSubmit={submit}>
        <label>
          Szukane słowa
          <input
            type="search"
            value={draft}
            maxLength={256}
            onChange={(event) => setDraft(event.target.value)}
            required
          />
        </label>
        <label>
          Rodzaj
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="">Wszystkie rodzaje</option>
            {Object.entries(labels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy}>Szukaj</button>
      </form>
      <p>
        Wyszukiwanie dosłowne. Użyj cudzysłowu dla całej frazy. Zakres: tytuły,
        obserwacje, własne notatki, encje, aliasy i skróty analiz.
      </p>
      {error && <p role="alert">{error}</p>}
      <div aria-live="polite">
        {busy && <p>Wyszukiwanie…</p>}
        {snapshot && snapshot.freshness !== 'FRESH' && (
          <p>
            {snapshot.freshness === 'UNKNOWN'
              ? 'Indeks nie został jeszcze utworzony. Wyniki nie potwierdzają braku danych.'
              : snapshot.freshness === 'BUILDING'
                ? 'Indeks jest przebudowywany. Wyniki mogą być niepełne.'
                : 'Indeks wymaga aktualizacji. Wyniki mogą nie zawierać ostatnich zmian.'}
          </p>
        )}
        {snapshot?.freshness === 'FRESH' && !snapshot.documents.length && (
          <p>Brak dopasowań w indeksowanym zakresie.</p>
        )}
      </div>
      {snapshot?.documents.map((document) => (
        <article className="daily-row" data-search-result key={document.doc_id}>
          <div>
            <p className="metadata">{labels[document.kind] ?? document.kind}</p>
            {document.item_id ? (
              <AppLink
                href={
                  '/items/' +
                  encodeURIComponent(document.item_id) +
                  '?return=' +
                  encodeURIComponent(route)
                }
              >
                {document.title ?? 'Materiał źródłowy'}
              </AppLink>
            ) : document.entity_id ? (
              <AppLink
                href={'/entities/' + encodeURIComponent(document.entity_id)}
              >
                Otwórz encję
              </AppLink>
            ) : null}
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {document.text}
            </p>
            {document.published_at && (
              <p>Publikacja źródła: {document.published_at}</p>
            )}
          </div>
        </article>
      ))}
      {snapshot?.next_cursor && (
        <button disabled={busy} onClick={() => void more()}>
          Pokaż kolejne wyniki
        </button>
      )}
    </>
  );
}
