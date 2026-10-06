import { useEffect, useState } from 'react';
import { api, errorMessage } from '../app/api.js';
interface Summary {
  sampled_at: string;
  paid_services_enabled: false;
  ai_profile: string;
  transcript_runtime: string;
  workers: { worker_id: string; availability: string; heartbeat_at: string }[];
  durable_jobs: { state: string; count: number }[];
  quota: {
    provider: string;
    bucket: string;
    remaining: number | null;
    freshness: string;
  }[];
}
export function System() {
  const [data, setData] = useState<Summary | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<Summary>('/system/summary', undefined, undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setData(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [revision]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>System</h1>
          <p className="muted">Co pracuje, co oczekuje i kiedy wróci.</p>
        </div>
        <button onClick={() => setRevision((v) => v + 1)}>Odśwież stan</button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">Pobieranie stanu…</p>}
      {data && (
        <>
          <p className="metadata">
            Odczyt:{' '}
            {new Date(data.sampled_at).toLocaleString('pl-PL', {
              timeZone: 'Europe/Warsaw',
            })}
          </p>
          <section className="panel">
            <h2>Przetwarzanie</h2>
            <dl className="system-definition">
              <dt>Transkrypty</dt>
              <dd>Lokalny executor</dd>
              <dt>Analiza AI</dt>
              <dd>Gemini Free</dd>
              <dt>Usługi płatne</dt>
              <dd>Wyłączone</dd>
            </dl>
          </section>
          <section className="panel">
            <h2>Lokalny executor</h2>
            {data.workers.length === 0 ? (
              <p>
                Brak zarejestrowanej obecności. Trwała kolejka zachowuje
                zadania.
              </p>
            ) : (
              <ul>
                {data.workers.map((worker) => (
                  <li key={worker.worker_id}>
                    {worker.availability === 'ONLINE' ? 'Online' : 'Offline'} ·
                    ostatni heartbeat{' '}
                    {new Date(worker.heartbeat_at).toLocaleString('pl-PL')}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <h2>Limity</h2>
            {data.quota.length === 0 ? (
              <p>
                Limit nieodczytany. Nieznane zużycie nie oznacza wolnych
                zasobów.
              </p>
            ) : (
              <ul>
                {data.quota.map((quota, index) => (
                  <li key={index}>
                    {quota.provider} · {quota.bucket}:{' '}
                    {quota.remaining ?? 'nieodczytany'} ·{' '}
                    {quota.freshness === 'FRESH' ? 'aktualny' : 'nieaktualny'}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <h2>Trwałe zadania</h2>
            {data.durable_jobs.length === 0 ? (
              <p>Brak zadań.</p>
            ) : (
              <ul>
                {data.durable_jobs.map((job, index) => (
                  <li key={index}>
                    {job.state} · {job.count}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
