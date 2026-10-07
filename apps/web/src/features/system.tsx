import { useEffect, useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import type { SystemSummary as Summary } from '../../../../packages/contracts/src/system.js';
import { capacityMetricNames } from '../../../../packages/contracts/src/capacity.js';
import { statusLabel, reasonLabel } from '../app/status.js';
import { AppLink } from '../app/router.js';
const metricLabels = {
  arrival_rate: 'Nowe kwalifikowane materiały / dobę',
  service_rate: 'Trwała pojemność przetwarzania / dobę',
  capacity_headroom: 'Zapas pojemności',
  oldest_eligible_job_age: 'Wiek najstarszej niewykonanej analizy',
  p50_time_to_analysis: 'Mediana czasu do analizy',
  p95_time_to_analysis: '95. percentyl czasu do analizy',
  backlog_growth_rate: 'Wzrost zaległości / dobę',
  estimated_drain_time: 'Czas opróżnienia zaległości',
};
function time(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })
    : 'Nieodczytano';
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
        <div className="row-actions">
          <AppLink href="/system/connections">Połączenia</AppLink>
          <AppLink href="/system/profiles">Profile analizy</AppLink>
          <AppLink href="/system/prompts">Prompt Studio</AppLink>
          <button onClick={() => setRevision((v) => v + 1)}>
            Odśwież stan
          </button>
        </div>
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
                    {quota.freshness === 'FRESH'
                      ? (quota.remaining ?? 'nieodczytany')
                      : 'bieżąca wartość nieznana'}{' '}
                    · {quota.freshness === 'FRESH' ? 'aktualny' : 'nieaktualny'}
                    <p className="metadata">
                      Odczyt: {time(quota.sampled_at)} · reset:{' '}
                      {time(quota.reset_at)} · źródło:{' '}
                      {quota.source ?? 'nieodczytane'}
                    </p>
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
                    {statusLabel(job.state)} · {job.count}
                    {job.task_type ? ' · ' + job.task_type : ''}
                    {job.origin_kind ? ' · ' + job.origin_kind : ''}
                    {job.oldest_arrival_origin_at && (
                      <p className="metadata">
                        Najstarszy arrival origin:{' '}
                        {time(job.oldest_arrival_origin_at)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <h2>Pojemność i obserwacja</h2>
            <p>
              Gate C: {data.capacity_metrics?.gate_c_status ?? 'NOT_RUN'} ·
              kwalifikacja kohorty:{' '}
              {data.capacity_metrics?.eligibility_status ?? 'UNKNOWN'}
            </p>
            <p className="muted">
              Pusta kolejka nie dowodzi zapasu pojemności. Okno pomiaru:{' '}
              {data.capacity_metrics?.measurement_window
                ? time(data.capacity_metrics.measurement_window.start) +
                  ' — ' +
                  time(data.capacity_metrics.measurement_window.end)
                : 'nie rozpoczęto'}
              .
            </p>
            <dl className="system-definition">
              {capacityMetricNames.map((name) => (
                <div className="metric-pair" key={name}>
                  <dt>{metricLabels[name]}</dt>
                  <dd>
                    {data.capacity_metrics?.metrics[name].status ===
                    'NOT_DRAINING'
                      ? 'Zaległości nie maleją przy obecnej pojemności'
                      : (data.capacity_metrics?.metrics[name].value ??
                        'Nieznane')}{' '}
                    <small className="metadata">
                      {data.capacity_metrics?.metrics[name].status ===
                      'NOT_DRAINING'
                        ? 'μ ≤ λ; brak skończonego czasu opróżnienia'
                        : data.capacity_metrics?.metrics[name].value !== null &&
                            data.capacity_metrics?.metrics[name].value !==
                              undefined
                          ? data.capacity_metrics.metrics[name].unit
                          : name === 'service_rate' ||
                              name === 'capacity_headroom' ||
                              name === 'estimated_drain_time'
                            ? 'Wymagany pomiar przy nasyconej kolejce'
                            : 'Wymagane okno obserwacji'}{' '}
                      · n={data.capacity_metrics?.metrics[name].n ?? 0}
                    </small>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="metadata">
              Completed: {data.capacity_metrics?.completed ?? 'nieznane'} ·
              open: {data.capacity_metrics?.open ?? 'nieznane'} · ponad 24 h:{' '}
              {data.capacity_metrics?.over_24h ?? 'nieznane'}. Kwantyle samych
              ukończonych wyników nie są SLO całej kohorty.
            </p>
            {data.capacity && (
              <p>
                Liczniki zadań (wszystkie typy): {data.capacity.arrival_count}{' '}
                zapisanych · {data.capacity.open_count} niewykonanych, w tym
                FAILED. Najstarszy origin:{' '}
                {time(data.capacity.oldest_open_arrival_origin_at)}. Przyjęte
                runy analizy: {data.capacity.accepted_count}.
              </p>
            )}
          </section>
          <section className="panel">
            <h2>Powody oczekiwania</h2>
            {!data.job_reasons?.length ? (
              <p>Brak odczytanych powodów oczekiwania.</p>
            ) : (
              <ul>
                {data.job_reasons.map((row, index) => (
                  <li key={index}>
                    {statusLabel(row.state)} · {row.count} ·{' '}
                    {reasonLabel(row.reason_code) ?? 'Oczekuje na wykonanie.'}
                    <p className="metadata">
                      Najstarszy origin: {time(row.oldest_arrival_origin_at)} ·
                      due: {time(row.next_due_at)} · próby: {row.attempts}
                    </p>
                    <details>
                      <summary>Informacje techniczne</summary>
                      <p>
                        {row.task_type} · {row.origin_kind} ·{' '}
                        {row.reason_code ?? 'brak kodu'}
                      </p>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <h2>Zbieranie i transkrypty</h2>
            {data.source_coverage?.length ? (
              <ul>
                {data.source_coverage.map((source) => (
                  <li key={source.source_id}>
                    Kanał {source.source_id}
                    <p className="metadata">
                      Próba: {time(source.last_attempt_at)} · sukces:{' '}
                      {time(source.last_success_at)} · ostatnie pełne okno do:{' '}
                      {time(source.last_complete_window_end)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Brak odczytanych watermarków źródeł.</p>
            )}
            {data.recent_discovery_scans?.map((scan) => (
              <p key={scan.scan_id}>
                Discovery {scan.coverage}: {scan.enumerated_count} materiałów ·{' '}
                {time(scan.window_start)} — {time(scan.window_end)}.
              </p>
            ))}
            {data.transcript_coverage && (
              <p>
                Materiały dostępne z zadaniem transkryptu:{' '}
                {data.transcript_coverage.denominator} · z usable source:{' '}
                {data.transcript_coverage.usable_source}. Sukces dostawcy w
                kwalifikowanych próbach: nieznany — mianownik nie został
                zmierzony.
              </p>
            )}
            {data.provider_health?.map((health, index) => (
              <p key={index}>
                {health.provider} · {health.runtime} · {health.state} ·{' '}
                {health.freshness} · {time(health.sampled_at)}
              </p>
            ))}
          </section>
          <section className="panel">
            <h2>Ledger użycia i koszty</h2>
            <p>
              Usługi płatne wyłączone. Koszt zewnętrzny: niezmierzony; nieznane
              użycie nie oznacza zera.
            </p>
            {data.usage ? (
              <>
                <p>
                  Własne wywołania w Ledgerze: {data.usage.requests} · nieznane
                  użycie: {data.usage.unknown_usage_count}.
                </p>
                {data.usage.requests > 0 &&
                  data.usage.unknown_usage_count === 0 && (
                    <p>
                      Znane tokeny: {data.usage.known_total_tokens} (input{' '}
                      {data.usage.known_input_tokens}, output{' '}
                      {data.usage.known_output_tokens}).
                    </p>
                  )}
                <p className="metadata">
                  Ostatni wpis: {time(data.usage.latest_observed_at)}. Te
                  liczniki nie zastępują globalnej quota konta.
                </p>
              </>
            ) : (
              <p>Ledger nieodczytany.</p>
            )}
          </section>
          <section className="panel">
            <h2>Profil i wersje</h2>
            <label>
              Pipeline{' '}
              <select value="gemini_free" disabled>
                <option value="gemini_free">Gemini Free</option>
              </select>
            </label>
            <p className="metadata">
              Aktywny adapter: Gemini Free. Inne profile będą dostępne po
              dodaniu działającego adaptera.
            </p>
            {data.pipeline_profiles?.length ? (
              data.pipeline_profiles.map((profile) => (
                <p key={profile.profile_id}>
                  {profile.profile_id} · wersja {profile.revision} ·{' '}
                  {profile.model ?? 'model nieodczytany'} · integralność{' '}
                  {profile.integrity} · eligibility{' '}
                  {profile.freshness ?? 'UNKNOWN'} · ważne do{' '}
                  {time(profile.eligibility_expires_at)} · zatwierdzone scope
                  jakości: {profile.quality_approval_count ?? 'nieznane'}.
                </p>
              ))
            ) : (
              <p>Brak odczytanego snapshotu modelu.</p>
            )}
            <details>
              <summary>Registry i schema</summary>
              {data.registry_versions ? (
                <>
                  <p>
                    Wire {data.registry_versions.wire} · canonical{' '}
                    {data.registry_versions.canonical} · mapper{' '}
                    {data.registry_versions.enrichment}
                  </p>
                  {data.registry_versions.published_prompts.map((prompt) => (
                    <p key={prompt.prompt_id}>
                      {prompt.prompt_id} · v{prompt.version} · {prompt.status}
                    </p>
                  ))}
                </>
              ) : (
                <p>Wersje registry nieodczytane.</p>
              )}
            </details>
          </section>
          <section className="panel">
            <h2>Backup i dostarczanie zadań</h2>
            <p>
              Ostatni zweryfikowany backup:{' '}
              {time(data.backup?.last_verified_at)}.
            </p>
            <p>
              Outbox: {data.outbox?.pending ?? 'nieodczytany'} · najstarsze due:{' '}
              {time(data.outbox?.oldest_due_at)}.
            </p>
          </section>
          <section className="panel">
            <h2>Eksport Daily</h2>
            {data.daily_exports ? (
              <>
                <p>
                  Automatyczne aktualizacje Drive: niezakwalifikowane. Odczyt
                  obejmuje {data.daily_exports.days.length} ostatnich dni i
                  folderów
                  {data.daily_exports.truncated
                    ? '; lista jest niekompletna'
                    : ''}
                  .
                </p>
                <p>
                  Oczekujące zmiany w tym odczycie:{' '}
                  {
                    data.daily_exports.days.filter(
                      (day) =>
                        day.dirty_seq > day.exported_seq ||
                        day.desired_generation > day.exported_generation ||
                        day.remote_revision === 0,
                    ).length
                  }
                  . Konflikty:{' '}
                  {
                    data.daily_exports.days.filter(
                      (day) => day.retry_reason === 'EXPORT_CONFLICT',
                    ).length
                  }
                  .
                </p>
                <p>
                  Przygotowane pliki:{' '}
                  {
                    data.daily_exports.days.filter(
                      (day) => day.rendered_bytes !== null,
                    ).length
                  }
                  ; razem{' '}
                  {data.daily_exports.days.reduce(
                    (sum, day) => sum + (day.rendered_bytes ?? 0),
                    0,
                  )}{' '}
                  B. Bajty dotyczą lokalnych artefaktów, a nie potwierdzonego
                  przesłania do Drive.
                </p>
                <p>
                  Estymacja tokenów, compaction i OVERSIZE wymagają odczytu
                  metadanych konkretnych raportów; brak pomiaru nie oznacza
                  zera. Briefing Bridge: NOT_RUN; brak potwierdzonego pełnego
                  odczytu przez consumer.
                </p>
              </>
            ) : (
              <p>
                Stan eksportu nieodczytany; brak danych nie oznacza zakończenia
                kolejki.
              </p>
            )}
            <AppLink href="/system/connections">
              Statusy dni, tryb i połączenie Drive
            </AppLink>
          </section>
        </>
      )}
    </>
  );
}
