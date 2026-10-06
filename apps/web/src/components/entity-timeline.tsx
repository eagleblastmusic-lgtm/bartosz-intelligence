import { useEffect, useRef, useState } from 'react';
import type { EntityTimeline as TimelineRepository } from '../../../../packages/core/src/knowledge/entity-timeline.js';
import { api, errorMessage } from '../app/api.js';
import { AppLink } from '../app/router.js';
type Snapshot = Awaited<ReturnType<TimelineRepository['page']>>;
const epistemic: Record<string, string> = {
  SOURCE_STATEMENT: 'Wypowiedź źródła',
  SOURCE_REPORT: 'Relacja o cudzej wypowiedzi',
  SOURCE_INFERENCE: 'Interpretacja analizy',
  UNRESOLVED: 'Autorstwo nieustalone',
};
export function EntityTimeline({ id }: { id: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const current = useRef(id);
  current.current = id;
  useEffect(() => {
    setSnapshot(null);
    setError('');
    setBusy(false);
  }, [id]);
  async function load() {
    if (busy) return;
    setBusy(true);
    setError('');
    const params = new URLSearchParams({ limit: '20' });
    if (snapshot?.next_cursor) params.set('cursor', snapshot.next_cursor);
    try {
      const result = await api<Snapshot>(
        '/entities/' + encodeURIComponent(id) + '/timeline?' + params,
      );
      if (current.current === id)
        setSnapshot({
          ...result,
          observations: [
            ...(snapshot?.observations ?? []),
            ...result.observations,
          ],
        });
    } catch (error) {
      if (current.current === id) setError(errorMessage(error));
    } finally {
      if (current.current === id) setBusy(false);
    }
  }
  return (
    <section aria-labelledby="entity-timeline-heading">
      <h2 id="entity-timeline-heading">Historia wypowiedzi o encji</h2>
      <p>
        Kolejność według publikacji źródła. Materiały bez daty są na końcu. Czas
        zapisania analizy nie wyznacza daty wypowiedzi. Historia obejmuje
        również wcześniejsze przyjęte analizy.
      </p>
      {error && <p role="alert">{error}</p>}
      {snapshot?.observations.map((row) => (
        <article className="daily-row" key={row.observation_id}>
          <h3>{String(row.observation.content_pl ?? row.kind)}</h3>
          <p>
            {row.title ?? 'Materiał źródłowy'} ·{' '}
            {row.published_at ?? 'Data publikacji nieustalona'}
          </p>
          <p>
            {row.kind} ·{' '}
            {epistemic[String(row.observation.epistemic_status)] ??
              'Autorstwo nieustalone'}
          </p>
          {typeof row.observation.temporal_text === 'string' && (
            <p>Czas wskazany w źródle: {row.observation.temporal_text}</p>
          )}
          <AppLink
            href={
              '/items/' +
              encodeURIComponent(row.item_id) +
              '?return=' +
              encodeURIComponent('/entities/' + id)
            }
          >
            Otwórz materiał i bieżącą analizę
          </AppLink>
          <p className="metadata">Zapis analizy: {row.recorded_at}</p>
        </article>
      ))}
      {snapshot && !snapshot.observations.length && (
        <p>Brak przyjętych wypowiedzi o tej encji.</p>
      )}
      {(!snapshot || snapshot.next_cursor) && (
        <button disabled={busy} onClick={() => void load()}>
          {busy
            ? 'Wczytywanie…'
            : snapshot
              ? 'Pokaż kolejne wypowiedzi'
              : 'Pokaż historię wypowiedzi'}
        </button>
      )}
    </section>
  );
}
