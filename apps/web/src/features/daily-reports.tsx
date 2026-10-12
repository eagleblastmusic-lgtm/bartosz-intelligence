import { useEffect, useState } from 'react';
import {
  dailyCategories,
  type DailyCategory,
  type DailyReportSnapshot,
} from '../../../../packages/contracts/src/daily-report.js';
import { api, errorMessage } from '../app/api.js';
import { AppLink } from '../app/router.js';
import { DayNavigator } from '../components/day-navigator.js';
const stateLabels: Record<DailyReportSnapshot['state'], string> = {
  DISABLED: 'Workflow oczekuje na konfigurację',
  OPEN: 'Zbiór dnia jest otwarty',
  WAITING_FILES: 'Transkrypcje czekają na zapis w Drive',
  MISSING: 'Brak raportu z ChatGPT',
  PARTIAL: 'Raport częściowy',
  COMPLETE: 'Raport kompletny',
  INTEGRITY_HOLD: 'Raport wymaga ponownej weryfikacji w Drive',
};
export function DailyReports({ route }: { route: string }) {
  const date = new URL(route, location.origin).pathname.slice('/daily/'.length);
  const [stored, setStored] = useState<{
      date: string;
      data: DailyReportSnapshot;
    } | null>(null),
    [error, setError] = useState(''),
    [category, setCategory] = useState<DailyCategory | null>(null),
    [revision, setRevision] = useState(0);
  const data = stored?.date === date ? stored.data : null;
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await api<DailyReportSnapshot>(
          '/daily/reports/' + date,
          undefined,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setStored({ date, data: value });
          setError('');
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [date, revision]);
  const categories = dailyCategories.filter((c) =>
    data?.videos.some((v) => v.category === c),
  );
  const active = category && categories.includes(category) ? category : null;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Dziennik · Radio</p>
          <h1>Raport dzienny — {date}</h1>
          <p className="muted">
            Według daty pozyskania transkrypcji · Europe/Warsaw
          </p>
        </div>
        <button onClick={() => setRevision((v) => v + 1)}>Odśwież</button>
      </div>
      <DayNavigator
        date={date}
        sources=""
        calendarEndpoint="/daily/reports/calendar"
        calendarLabel="Kalendarz raportów"
      />
      <p>
        <AppLink href={'/daily/' + date + '?view=publications'}>
          Publikacje i dotychczasowe analizy
        </AppLink>
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Wczytywanie raportu…</p>}
      {data && (
        <>
          <section className="panel" aria-label="Kompletność raportu">
            <h2>{stateLabels[data.state]}</h2>
            <p>
              Oczekiwane: {data.expected_count} · Gotowe transkrypcje:{' '}
              {data.ready_count} · Przetworzone: {data.processed_count} ·
              Pominięte: {data.skipped_count}
            </p>
            {data.report_file_id && (
              <p>
                <a
                  href={
                    'https://drive.google.com/file/d/' +
                    data.report_file_id +
                    '/view'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Otwórz raport w Google Drive
                </a>
              </p>
            )}
            {data.manifest_file_id && (
              <p>
                <a
                  href={
                    'https://drive.google.com/file/d/' +
                    data.manifest_file_id +
                    '/view'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Manifest materiałów
                </a>
              </p>
            )}
            {data.verified_at && (
              <p className="muted">
                Weryfikacja Drive:{' '}
                {new Intl.DateTimeFormat('pl-PL', {
                  timeZone: 'Europe/Warsaw',
                  dateStyle: 'short',
                  timeStyle: 'short',
                }).format(new Date(data.verified_at))}
              </p>
            )}
            {!!data.pending_video_ids.length && (
              <p>
                Nieopublikowane transkrypcje:{' '}
                {data.pending_video_ids.join(', ')}
              </p>
            )}
            {!!data.missing_video_ids.length && (
              <p>Brak streszczeń: {data.missing_video_ids.join(', ')}</p>
            )}
          </section>
          {!!categories.length && (
            <div
              className="source-filters"
              role="group"
              aria-label="Kategorie raportu"
            >
              <button aria-pressed={!active} onClick={() => setCategory(null)}>
                Wszystkie
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  aria-pressed={active === c}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          {categories
            .filter((c) => !active || active === c)
            .map((c) => (
              <section key={c} aria-label={c}>
                <h2>{c}</h2>
                {data.videos
                  .filter((v) => v.category === c)
                  .map((video) => (
                    <details className="panel" key={video.video_id}>
                      <summary>{video.title}</summary>
                      <p>
                        <a
                          href={video.youtube_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Oryginalny film YouTube
                        </a>
                        {video.transcript_file_id && (
                          <>
                            {' '}
                            ·{' '}
                            <a
                              href={
                                'https://drive.google.com/file/d/' +
                                video.transcript_file_id +
                                '/view'
                              }
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Pełna transkrypcja
                            </a>
                          </>
                        )}
                      </p>
                      {video.status === 'PROCESSED' ? (
                        <p style={{ whiteSpace: 'pre-wrap' }}>
                          {video.summary}
                        </p>
                      ) : (
                        <p role="status">Nieprzetworzono: {video.reason}</p>
                      )}
                    </details>
                  ))}
              </section>
            ))}
        </>
      )}
    </>
  );
}
