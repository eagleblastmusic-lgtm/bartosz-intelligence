import { useEffect, useState } from 'react';
import type { DailySnapshot } from '../../../../packages/contracts/src/daily.js';
import { api, errorMessage } from '../app/api.js';
import { AppLink } from '../app/router.js';
const statusLabels = {
  READY: 'Gotowe',
  PARTIAL: 'Częściowe',
  PENDING: 'Oczekuje',
  BLOCKED: 'Zablokowane',
  FAILED: 'Błąd',
  REVIEW_REQUIRED: 'Wymaga przeglądu',
};
export function Daily({ route }: { route: string }) {
  const url = new URL(route, location.origin),
    date = url.pathname.slice('/daily/'.length),
    [result, setResult] = useState<DailySnapshot | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setResult(null);
    const query = new URLSearchParams({
      date,
      timezone: 'Europe/Warsaw',
      limit: '20',
    });
    const sources = new URL(route, location.origin).searchParams.get(
      'source_ids',
    );
    if (sources) query.set('source_ids', sources);
    api<DailySnapshot>(
      '/daily?' + query,
      undefined,
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setResult(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [route, date, revision]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Dziennik</p>
          <h1>Publikacje z {date}</h1>
          <p className="muted">Według daty publikacji · Europe/Warsaw</p>
        </div>
        <button disabled={loading} onClick={() => setRevision((v) => v + 1)}>
          Odśwież
        </button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <div role="status" aria-label="Pobieranie publikacji">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}
      {result && (
        <>
          <div className="count-line">
            <span>
              <strong>{result.counts.items}</strong> materiałów
            </span>
            <span>
              <strong>{result.counts.ready}</strong> gotowych
            </span>
            <span>
              <strong>{result.counts.pending}</strong> oczekuje
            </span>
          </div>
          {!result.discovery_complete && (
            <p className="notice">
              Sprawdzenie dnia nieukończone. Kolejne publikacje mogą pojawić się
              po discovery.
            </p>
          )}
          {result.items.length === 0 ? (
            <section className="empty-state">
              <h2>
                {result.discovery_complete
                  ? 'Tego dnia nie znaleziono publikacji'
                  : 'Jeszcze nie ma publikacji'}
              </h2>
              <p className="muted">
                {result.source_coverage.length === 0
                  ? 'Dodaj pierwszy kanał. Materiały pojawią się tutaj po sprawdzeniu źródła.'
                  : 'Materiały przypisujemy do dnia publikacji, również gdy analiza zakończy się później.'}
              </p>
              <AppLink href="/channels" className="primary-link">
                Przejdź do kanałów
              </AppLink>
            </section>
          ) : (
            <ul className="daily-rows">
              {result.items.map((item) => (
                <li className="daily-row" key={item.item_id}>
                  <div>
                    <h2>
                      <a
                        href={item.canonical_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {item.title}
                      </a>
                    </h2>
                    <p className="metadata">
                      {item.creator} ·{' '}
                      {item.published_at
                        ? new Intl.DateTimeFormat('pl-PL', {
                            timeZone: 'Europe/Warsaw',
                            hour: '2-digit',
                            minute: '2-digit',
                          }).format(new Date(item.published_at))
                        : 'Data nieustalona'}
                    </p>
                    {item.view?.summary_pl.map((note, index) => (
                      <p key={index}>{note.text_pl}</p>
                    ))}
                    {!item.view && (
                      <p className="metadata">
                        Analiza oczekuje na przetworzenie. Stan:{' '}
                        {item.processing_state ?? 'oczekuje'}.
                      </p>
                    )}
                  </div>
                  <span
                    className="status-badge"
                    data-state={item.analysis_status}
                  >
                    <span aria-hidden="true">
                      {item.analysis_status === 'READY' ? '✓' : '◷'}
                    </span>
                    {statusLabels[item.analysis_status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
