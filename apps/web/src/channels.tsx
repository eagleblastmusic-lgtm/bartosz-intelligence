import { useEffect, useRef, useState } from 'react';
import type { SourceIdentity } from '../../../packages/contracts/src/discovery.js';
import type { JobRecord } from '../../../packages/contracts/src/jobs.js';
import { BackupDownload } from './backup.js';

import { api, errorMessage } from './app/api.js';
import { SourceProgress } from './components/source-progress.js';
import { AppLink } from './app/router.js';

type Source = {
  source_id: string;
  title: string;
  enabled: number;
  last_complete_window_end: string | null;
};
type Page<T, K extends string> = Record<K, T[]> & {
  next_cursor: string | null;
};
type Preview = {
  window: { window_start: string; window_end: string };
  coverage: string;
  enumerated_count: number;
  unknown_publication_count: number;
};
export function Channels() {
  const actionLock = useRef(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [locator, setLocator] = useState('');
  const [range, setRange] = useState('30'),
    [start, setStart] = useState(''),
    [end, setEnd] = useState(''),
    [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [preview, setPreview] = useState<
    | (Preview & {
        identity: SourceIdentity;
        locator: string;
        key: string;
        label: string;
      })
    | null
  >(null);
  const [sources, setSources] = useState<Page<Source, 'sources'>>({
    sources: [],
    next_cursor: null,
  });
  const [jobs, setJobs] = useState<Page<JobRecord, 'jobs'>>({
    jobs: [],
    next_cursor: null,
  });
  const [notice, setNotice] = useState('');
  async function refresh() {
    const [sourcePage, jobPage] = await Promise.all([
      api<Page<Source, 'sources'>>('/sources?limit=20'),
      api<Page<JobRecord, 'jobs'>>('/jobs?limit=20'),
    ]);
    setSources(sourcePage);
    setJobs(jobPage);
  }
  useEffect(() => {
    let active = true;
    void refresh().catch((error) => {
      if (active) setError(errorMessage(error));
    });
    return () => {
      active = false;
    };
  }, []);
  async function action(work: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="channel-workspace">
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <div className="toolbar">
        <button disabled={busy} onClick={() => void action(refresh)}>
          Odśwież stan
        </button>
      </div>
      <section aria-labelledby="add-source">
        <h2 id="add-source">Dodaj kanał YouTube</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              const identity = await api<SourceIdentity>('/sources/resolve', {
                locator,
              });
              const result = await api<Preview>('/sources/backfill-preview', {
                locator,
                range: ['only-new', 'custom'].includes(range)
                  ? range
                  : Number(range),
                ...(range === 'custom'
                  ? {
                      start: new Date(start + 'Z').toISOString(),
                      end: new Date(end + 'Z').toISOString(),
                    }
                  : {}),
              });
              setPreview({
                ...result,
                identity,
                locator,
                key: crypto.randomUUID(),
                label:
                  range === '30'
                    ? '30 dni'
                    : range === 'only-new'
                      ? 'od teraz'
                      : range === 'custom'
                        ? 'wybrany zakres'
                        : range + ' dni',
              });
              setNotice('');
            });
          }}
        >
          <label htmlFor="channel">Adres, @handle lub ID kanału</label>{' '}
          <input
            id="channel"
            required
            value={locator}
            onChange={(event) => {
              setLocator(event.target.value);
              setPreview(null);
            }}
            disabled={busy}
          />{' '}
          <label htmlFor="backfill-range">Zakres</label>
          <select
            id="backfill-range"
            value={range}
            disabled={busy}
            onChange={(event) => {
              setRange(event.target.value);
              setPreview(null);
            }}
          >
            <option value="30">Ostatnie 30 dni</option>
            <option value="7">Ostatnie 7 dni</option>
            <option value="90">Ostatnie 90 dni</option>
            <option value="only-new">Tylko nowe</option>
            <option value="custom">Własny zakres</option>
          </select>
          {range === 'custom' && (
            <>
              <label>
                Początek (UTC)
                <input
                  type="datetime-local"
                  required
                  value={start}
                  disabled={busy}
                  onChange={(event) => {
                    setStart(event.target.value);
                    setPreview(null);
                  }}
                />
              </label>
              <label>
                Koniec (UTC)
                <input
                  type="datetime-local"
                  required
                  value={end}
                  disabled={busy}
                  onChange={(event) => {
                    setEnd(event.target.value);
                    setPreview(null);
                  }}
                />
              </label>
            </>
          )}
          <p className="metadata">
            Profil: Economy · Gemini Free · usługi płatne wyłączone. Zakres nie
            jest obietnicą pełnej historii ani dostępnej pojemności Free Tier.
          </p>
          <button disabled={busy} type="submit">
            {range === '30'
              ? 'Sprawdź ostatnie 30 dni'
              : 'Sprawdź wybrany zakres'}
          </button>
        </form>
        {preview && (
          <div>
            <h3>{preview.identity.title}</h3>
            <p>
              Okno: {preview.window.window_start} — {preview.window.window_end}
            </p>
            <p>
              Znaleziono {preview.enumerated_count} filmów. Pokrycie:{' '}
              {preview.coverage === 'COMPLETE'
                ? 'pełne'
                : 'częściowe; discovery sprawdzi pozostałe strony'}
              . Daty nieznane: {preview.unknown_publication_count}.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const receipt = await api<{
                    source_id: string;
                    job_id: string;
                  }>(
                    '/sources',
                    {
                      locator: preview.locator,
                      window: preview.window,
                      confirmed_channel_id: preview.identity.external_id,
                    },
                    preview.key,
                  );
                  setNotice(
                    'Monitoring zapisany. Backfill jest w trwałej kolejce. ID kanału: ' +
                      receipt.source_id +
                      ' · ID zadania: ' +
                      receipt.job_id,
                  );
                  setSelectedSource(receipt.source_id);
                  setPreview(null);
                  await refresh();
                })
              }
            >
              Włącz monitoring i backfill {preview.label}
            </button>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
      </section>
      <section aria-labelledby="sources">
        <h2 id="sources">Monitorowane kanały</h2>
        {sources.sources.length === 0 && <p>Brak kanałów.</p>}
        <ul>
          {sources.sources.map((source) => (
            <li key={source.source_id}>
              <AppLink
                href={
                  '/system/profiles?source_id=' +
                  encodeURIComponent(source.source_id)
                }
              >
                Profil analizy: {source.title}
              </AppLink>{' '}
              {source.title} · {source.enabled ? 'aktywny' : 'wyłączony'} ·
              ostatnie pełne okno:{' '}
              {source.last_complete_window_end ?? 'jeszcze nieukończone'}
              <button
                aria-expanded={selectedSource === source.source_id}
                onClick={() =>
                  setSelectedSource(
                    selectedSource === source.source_id
                      ? null
                      : source.source_id,
                  )
                }
              >
                Postęp: {source.title}
              </button>
            </li>
          ))}
        </ul>
        {selectedSource && <SourceProgress sourceId={selectedSource} />}
        {sources.next_cursor && (
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const next = await api<Page<Source, 'sources'>>(
                  '/sources?limit=20&cursor=' +
                    encodeURIComponent(sources.next_cursor!),
                );
                setSources({
                  ...next,
                  sources: [...sources.sources, ...next.sources],
                });
              })
            }
          >
            Więcej kanałów
          </button>
        )}
      </section>
      <section aria-labelledby="jobs">
        <h2 id="jobs">Trwałe zadania</h2>
        <p>
          Zadania są zapisane trwale. Przetwarzanie transkryptów wznawia się po
          powrocie lokalnego executora.
        </p>
        <ul>
          {jobs.jobs.map((job) => (
            <li key={job.job_id}>
              {job.task_type} · {job.state}
              {job.reason_code ? ' · ' + job.reason_code : ''}
            </li>
          ))}
        </ul>
        {jobs.next_cursor && (
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const next = await api<Page<JobRecord, 'jobs'>>(
                  '/jobs?limit=20&cursor=' +
                    encodeURIComponent(jobs.next_cursor!),
                );
                setJobs({ ...next, jobs: [...jobs.jobs, ...next.jobs] });
              })
            }
          >
            Więcej zadań
          </button>
        )}
      </section>
      <BackupDownload request={api} />
    </div>
  );
}
