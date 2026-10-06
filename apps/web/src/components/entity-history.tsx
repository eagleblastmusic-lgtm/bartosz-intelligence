import { useEffect, useRef, useState } from 'react';
import type { EntityTimeline } from '../../../../packages/core/src/knowledge/entity-timeline.js';
import { api, errorMessage } from '../app/api.js';
type Snapshot = Awaited<ReturnType<EntityTimeline['events']>>;
const labels: Record<string, string> = {
  ALIAS_APPROVE: 'Zatwierdzenie aliasu',
  ALIAS_REVOKE: 'Wycofanie aliasu',
  MERGE: 'Scalenie',
  SPLIT: 'Wydzielenie',
  UNDO: 'Cofnięcie tożsamości',
  LABEL_APPLY: 'Korekta nazwy',
  LABEL_REVERT: 'Cofnięcie korekty nazwy',
};
export function EntityHistory({ id }: { id: string }) {
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
        '/entities/' + encodeURIComponent(id) + '/history?' + params,
      );
      if (current.current === id)
        setSnapshot({
          ...result,
          events: [...(snapshot?.events ?? []), ...result.events],
        });
    } catch (error) {
      if (current.current === id) setError(errorMessage(error));
    } finally {
      if (current.current === id) setBusy(false);
    }
  }
  return (
    <section aria-labelledby="entity-events-heading">
      <h2 id="entity-events-heading">Pełna historia decyzji właściciela</h2>
      <p>
        Decyzje są uporządkowane według czasu ich zapisania. Ten czas nie
        określa daty wypowiedzi źródłowej.
      </p>
      {error && <p role="alert">{error}</p>}
      {snapshot?.events.map((event) => (
        <article className="daily-row" key={event.event_id}>
          <h3>{labels[event.action] ?? event.action}</h3>
          {event.text && (
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {event.text}
            </p>
          )}
          <p>{event.reason}</p>
          <p className="metadata">{event.recorded_at} · autor: właściciel</p>
        </article>
      ))}
      {snapshot && !snapshot.events.length && (
        <p>Brak zapisanych decyzji właściciela.</p>
      )}
      {(!snapshot || snapshot.next_cursor) && (
        <button disabled={busy} onClick={() => void load()}>
          {busy
            ? 'Wczytywanie…'
            : snapshot
              ? 'Pokaż kolejne decyzje'
              : 'Pokaż pełną historię decyzji'}
        </button>
      )}
    </section>
  );
}
