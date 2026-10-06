import { useEffect, useState } from 'react';
import type { SourceProgress as Progress } from '../../../../packages/contracts/src/daily.js';
import { api, errorMessage } from '../app/api.js';
export function SourceProgress({ sourceId }: { sourceId: string }) {
  const [value, setValue] = useState<Progress | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    async function read() {
      if (busy) return;
      busy = true;
      try {
        const data = await api<Progress>(
          '/sources/' + encodeURIComponent(sourceId) + '/progress',
          undefined,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setValue(data);
          setError('');
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      } finally {
        busy = false;
      }
    }
    setValue(null);
    setError('');
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, 30000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [sourceId]);
  return (
    <section className="source-progress" aria-label="Postęp kanału">
      {error && <p role="alert">{error}</p>}
      {!value && !error && <p role="status">Pobieranie trwałego postępu…</p>}
      {value && (
        <>
          <p>
            <strong>{value.counts.items}</strong> zapisanych materiałów ·{' '}
            {value.counts.ready} gotowych · {value.counts.pending} oczekuje ·{' '}
            {value.counts.blocked} zablokowanych · {value.counts.failed} z
            błędem
          </p>
          {value.scan ? (
            <>
              <p>
                Discovery: {value.scan.state} · pokrycie {value.scan.coverage}.
                Wyliczono {value.scan.enumerated_count}, zaplanowano transkrypt
                dla {value.scheduled} materiałów z tego skanu.
              </p>
              <p>
                {value.total === null
                  ? 'Łączna liczba nieznana — skan nie jest ukończony.'
                  : `Skan ukończony: ${value.total} materiałów. Analiza jest osobnym krokiem.`}
              </p>
              {value.scan.reason_code && (
                <p>
                  Powód: {value.scan.reason_code} · następna próba:{' '}
                  {value.scan.due_at}
                </p>
              )}
              <p className="metadata">
                Okno: {value.scan.window_start} — {value.scan.window_end}
              </p>
            </>
          ) : (
            <p>
              Discovery oczekuje na rozpoczęcie. Łączna liczba materiałów
              nieznana.
            </p>
          )}
          <p className="metadata">
            Odczyt: {new Date(value.sampled_at).toLocaleString('pl-PL')}.
            Gotowość dotyczy przyjętych wyników; zakończenie discovery nie
            oznacza zakończenia analizy.
          </p>
        </>
      )}
    </section>
  );
}
