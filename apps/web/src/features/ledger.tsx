import { useEffect, useRef, useState } from 'react';
import type { ObservationLedger } from '../../../../packages/core/src/knowledge/ledger.js';
import { api, errorMessage } from '../app/api.js';
import { AppLink, navigate } from '../app/router.js';
type Snapshot = Awaited<ReturnType<ObservationLedger['page']>>;
const labels: Record<string, string> = {
  CLAIM: 'Twierdzenie',
  STANCE: 'Stanowisko',
  USAGE: 'Użycie',
  RECOMMENDATION: 'Rekomendacja',
  PREDICTION: 'Przewidywanie',
  UNCERTAINTY: 'Niepewność',
  CONTRADICTION: 'Możliwa sprzeczność',
};
const epistemic: Record<string, string> = {
  SOURCE_STATEMENT: 'Wypowiedź źródła',
  SOURCE_REPORT: 'Relacja o cudzej wypowiedzi',
  SOURCE_INFERENCE: 'Interpretacja analizy',
  UNRESOLVED: 'Autorstwo nieustalone',
};
export function Ledger({ route }: { route: string }) {
  const query = new URL(route, location.origin).searchParams;
  const key = query.toString();
  const currentKey = useRef(key);
  currentKey.current = key;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [sources, setSources] = useState<{ source_id: string; title: string }[]>(
      [],
    ),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function loadSources() {
      const catalog: { source_id: string; title: string }[] = [];
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({ limit: '50' });
        if (cursor) params.set('cursor', cursor);
        const page = await api<{
          sources: typeof catalog;
          next_cursor: string | null;
        }>('/sources?' + params, undefined, undefined, controller.signal);
        catalog.push(...page.sources);
        cursor = page.next_cursor;
      } while (cursor && !controller.signal.aborted);
      if (!controller.signal.aborted) setSources(catalog);
    }
    void loadSources().catch((error) => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    });
    return () => controller.abort();
  }, []);
  function endpoint(cursor?: string) {
    const params = new URLSearchParams(key);
    params.set('limit', '20');
    if (cursor) params.set('cursor', cursor);
    return '/ledger?' + params;
  }
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setError('');
    setBusy(true);
    api<Snapshot>(endpoint(), undefined, undefined, controller.signal)
      .then(setSnapshot)
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [key, revision]);
  async function more() {
    if (!snapshot?.next_cursor || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<Snapshot>(endpoint(snapshot.next_cursor));
      if (currentKey.current !== key) return;
      setSnapshot({
        ...next,
        observations: [...snapshot.observations, ...next.observations],
      });
    } catch (error) {
      if (currentKey.current === key) setError(errorMessage(error));
    } finally {
      if (currentKey.current === key) setBusy(false);
    }
  }
  function filter(name: string, value: string) {
    const next = new URLSearchParams(key);
    if (value) next.set(name, value);
    else next.delete(name);
    navigate('/ledger' + (next.size ? '?' + next : ''));
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Wiedza</h1>
          <AppLink href="/entities">Encje i aliasy</AppLink>
          <p className="muted">
            Wypowiedzi i interpretacje z wybranych, przyjętych analiz. Zachowują
            identyfikatory i dowody źródłowe.
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          Odśwież wiedzę
        </button>
      </div>
      <form className="filter-bar" onSubmit={(event) => event.preventDefault()}>
        <label>
          Źródło
          <select
            value={query.get('source_id') ?? ''}
            onChange={(event) => filter('source_id', event.target.value)}
          >
            <option value="">Wszystkie źródła</option>
            {sources.map((source) => (
              <option key={source.source_id} value={source.source_id}>
                {source.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Rodzaj
          <select
            value={query.get('kind') ?? ''}
            onChange={(event) => filter('kind', event.target.value)}
          >
            <option value="">Wszystkie rodzaje</option>
            {Object.entries(labels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Data publikacji
          <input
            type="date"
            value={query.get('date') ?? ''}
            onChange={(event) => filter('date', event.target.value)}
          />
        </label>
        {query.size > 0 && <AppLink href="/ledger">Wyczyść filtry</AppLink>}
      </form>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {busy && !snapshot && <p role="status">Wczytywanie wiedzy…</p>}
      {snapshot && !snapshot.observations.length && (
        <p className="notice">
          Brak wypowiedzi w wybranym zakresie. Pojawią się po przyjęciu analizy.
        </p>
      )}
      <div className="daily-list">
        {snapshot?.observations.map((row) => (
          <article className="daily-row" key={row.observation_id}>
            <p className="metadata">
              {labels[row.kind]} ·{' '}
              {epistemic[String(row.observation.epistemic_status)] ??
                'Status nieustalony'}
            </p>
            <h2>{String(row.observation.content_pl ?? '')}</h2>
            <p className="muted">
              {row.creator} ·{' '}
              {row.published_at
                ? new Intl.DateTimeFormat('pl-PL', {
                    timeZone: 'Europe/Warsaw',
                    dateStyle: 'medium',
                  }).format(new Date(row.published_at))
                : 'Data publikacji nieustalona'}
            </p>
            {Array.isArray(row.observation.qualifiers) &&
              row.observation.qualifiers.length > 0 && (
                <p>{row.observation.qualifiers.map(String).join(' · ')}</p>
              )}
            {typeof row.observation.temporal_text === 'string' && (
              <p>Czas wskazany w źródle: {row.observation.temporal_text}</p>
            )}
            <AppLink
              href={
                '/items/' +
                encodeURIComponent(row.item_id) +
                '?return=' +
                encodeURIComponent(route)
              }
            >
              Otwórz analizę i dowody: {row.title}
            </AppLink>
          </article>
        ))}
      </div>
      {snapshot?.next_cursor && (
        <button disabled={busy} onClick={() => void more()}>
          {busy ? 'Wczytywanie…' : 'Pokaż więcej wypowiedzi'}
        </button>
      )}
    </>
  );
}
