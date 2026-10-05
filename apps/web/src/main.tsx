import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SourceIdentity } from '../../../packages/contracts/src/discovery.js';
import type { JobRecord } from '../../../packages/contracts/src/jobs.js';
import { BackupDownload } from './backup.js';

async function api<T>(path: string, input?: unknown, key?: string): Promise<T> {
  const csrf = document.cookie
    .split('; ')
    .find((value) => value.startsWith('__Host-bi-csrf='))
    ?.slice('__Host-bi-csrf='.length);
  const response = await fetch('/api/v1' + path, {
    method: input === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers:
      input === undefined
        ? {}
        : {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf ?? '',
            ...(key ? { 'Idempotency-Key': key } : {}),
          },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.code === 'string' ? data.code : 'REQUEST_FAILED',
    );
  return data as T;
}
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
function App() {
  const [auth, setAuth] = useState<'checking' | 'owner' | 'login' | 'setup'>(
    'checking',
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [locator, setLocator] = useState('');
  const [preview, setPreview] = useState<
    | (Preview & { identity: SourceIdentity; locator: string; key: string })
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
    let cancelled = false;
    api<{ authenticated: boolean }>('/auth/session')
      .then(async () => {
        if (!cancelled) {
          setAuth('owner');
          await refresh().catch((error: Error) => setError(error.message));
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setAuth(
            error.message === 'AUTH_CONFIGURATION_REQUIRED' ? 'setup' : 'login',
          );
          if (
            ![
              'AUTH_CONFIGURATION_REQUIRED',
              'UNAUTHENTICATED',
              'FORBIDDEN',
            ].includes(error.message)
          )
            setError(error.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'REQUEST_FAILED');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <h1>Bartosz Intelligence</h1>
      <p>Control plane · usługi płatne wyłączone</p>
      {error && <p role="alert">Nie udało się wykonać operacji: {error}</p>}
      {auth === 'checking' && <p role="status">Sprawdzanie sesji…</p>}
      {auth === 'setup' && (
        <p>
          Wymagane ustanowienie właściciela przez prywatny launcher
          administratora.
        </p>
      )}
      {auth === 'login' && (
        <a href="/api/v1/auth/login">Zaloguj się przez Google</a>
      )}
      {auth === 'owner' && (
        <>
          <button disabled={busy} onClick={() => void action(refresh)}>
            Odśwież stan
          </button>{' '}
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api('/auth/logout', {});
                setSources({ sources: [], next_cursor: null });
                setJobs({ jobs: [], next_cursor: null });
                setPreview(null);
                setAuth('login');
              })
            }
          >
            Wyloguj
          </button>
          <section aria-labelledby="add-source">
            <h2 id="add-source">Dodaj kanał YouTube</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  const identity = await api<SourceIdentity>(
                    '/sources/resolve',
                    { locator },
                  );
                  const result = await api<Preview>(
                    '/sources/backfill-preview',
                    { locator, range: 30 },
                  );
                  setPreview({
                    ...result,
                    identity,
                    locator,
                    key: crypto.randomUUID(),
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
              <button disabled={busy} type="submit">
                Sprawdź ostatnie 30 dni
              </button>
            </form>
            {preview && (
              <div>
                <h3>{preview.identity.title}</h3>
                <p>
                  Okno: {preview.window.window_start} —{' '}
                  {preview.window.window_end}
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
                      await api(
                        '/sources',
                        {
                          locator: preview.locator,
                          window: preview.window,
                          confirmed_channel_id: preview.identity.external_id,
                        },
                        preview.key,
                      );
                      setNotice(
                        'Monitoring zapisany. Backfill jest w trwałej kolejce.',
                      );
                      setPreview(null);
                      await refresh();
                    })
                  }
                >
                  Włącz monitoring i backfill 30 dni
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
                  {source.title} · {source.enabled ? 'aktywny' : 'wyłączony'} ·
                  ostatnie pełne okno:{' '}
                  {source.last_complete_window_end ?? 'jeszcze nieukończone'}
                </li>
              ))}
            </ul>
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
              Transcript wymaga local executora. Analiza AI zostanie
              udostępniona po wdrożeniu pipeline.
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
        </>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
