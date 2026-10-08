import { useEffect, useState } from 'react';
import type { DailyExportStatus } from '../../../../packages/contracts/src/drive.js';
import { api, errorMessage } from '../app/api.js';

export function DailyExports() {
  const [data, setData] = useState<DailyExportStatus | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<DailyExportStatus>(
      '/connections/drive/exports/status',
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setError('');
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [version]);
  async function change(day: DailyExportStatus['days'][number], mode: string) {
    setBusy(true);
    setError('');
    try {
      await api('/connections/drive/exports/mode', {
        root_id: day.root_id,
        date: day.date,
        mode,
        expected_revision: day.settings_revision,
      });
      setVersion((value) => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const states = {
    AUTH_REQUIRED: 'Wymaga połączenia konta',
    ROOT_REQUIRED: 'Wymaga weryfikacji folderu',
    LEASED: 'Próba w toku',
    WAITING: 'Oczekuje na debounce',
    DUE: 'Gotowy w kolejce',
    CURRENT: 'Przetworzono bieżące zmiany',
    PAUSED: 'Wstrzymano — wymaga sprawdzenia przyczyny',
    RETRY_WAIT: 'Oczekuje na termin ponowienia',
  };
  return (
    <section className="panel" aria-labelledby="daily-exports-title">
      <h2 id="daily-exports-title">Eksporty Daily</h2>
      <button disabled={busy} onClick={() => setVersion((value) => value + 1)}>
        Odśwież eksporty
      </button>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">Pobieranie eksportów…</p>}
      {data && (
        <>
          <p className="notice">
            Automatyczny eksporter oczekuje na pełną weryfikację operacyjną.
            Stan kolejki nie potwierdza wykonania eksportu.
          </p>
          {!data.days.length && (
            <p>
              Brak przygotowanych dni eksportu. Najpierw połącz konto i
              zweryfikuj folder.
            </p>
          )}
          {data.days.map((day) => (
            <article className="panel" key={day.root_id + ':' + day.date}>
              <h3>{day.date}</h3>
              <p>{states[day.queue_state]}</p>
              {(day.retry_count ?? 0) > 0 &&
                ![
                  'EXPORT_CONFLICT',
                  'DRIVE_CONFLICT',
                  'DRIVE_UNQUALIFIED_UPDATE',
                ].includes(day.paused_reason ?? '') && (
                  <button
                    disabled={
                      busy ||
                      day.auth_state !== 'CONNECTED' ||
                      day.root_state !== 'VERIFIED'
                    }
                    onClick={() => {
                      setBusy(true);
                      setError('');
                      void api('/connections/drive/exports/retry', {
                        root_id: day.root_id,
                        date: day.date,
                        expected_revision: day.settings_revision,
                      })
                        .then(() => setVersion((value) => value + 1))
                        .catch((error) => setError(errorMessage(error)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Ponów eksport {day.date}
                  </button>
                )}
              <dl>
                <dt>Folder</dt>
                <dd>{day.root_id}</dd>
                <dt>Plik Drive</dt>
                <dd>{day.file_id ?? 'Nie zapisano'}</dd>
                <dt>Rewizja w Drive</dt>
                <dd>{day.remote_revision || 'Nie zapisano'}</dd>
                <dt>Przygotowana rewizja</dt>
                <dd>{day.rendered_revision ?? 'Nie przygotowano'}</dd>
                <dt>Rozmiar przygotowanego pliku</dt>
                <dd>
                  {day.rendered_bytes === null
                    ? 'Nie przygotowano'
                    : day.rendered_bytes + ' B'}
                </dd>
                <dt>Zmiany przetworzone / oczekujące</dt>
                <dd>
                  {day.exported_seq} / {day.dirty_seq}
                </dd>
                <dt>Powód ostatniej próby</dt>
                <dd>{day.retry_reason ?? 'Brak'}</dd>
                <dt>Powód wstrzymania</dt>
                <dd>{day.paused_reason ?? 'Brak'}</dd>
                <dt>Liczba nieudanych prób</dt>
                <dd>{day.retry_count ?? 0}</dd>
                <dt>Następne ponowienie</dt>
                <dd>{day.next_retry_at ?? 'Brak'}</dd>
                <dt>Termin kolejki</dt>
                <dd>{day.due_at ?? 'Brak'}</dd>
                <dt>Ostatni zweryfikowany zapis lub odczyt</dt>
                <dd>{day.last_verified_at ?? 'Nie wykonano'}</dd>
              </dl>
              <label htmlFor={'export-mode-' + day.root_id + '-' + day.date}>
                Docelowy tryb dla {day.date}
              </label>
              <select
                id={'export-mode-' + day.root_id + '-' + day.date}
                disabled={busy}
                value={day.desired_mode}
                onChange={(event) => void change(day, event.target.value)}
              >
                <option value="COMPACT">COMPACT</option>
                <option value="FULL">FULL</option>
              </select>
              <p>
                Tryb zapisany w Drive:{' '}
                {day.remote_revision ? day.remote_mode : 'Nie zapisano'}. Wybór
                trybu zachowuje identyfikator pliku i zleca nową rewizję.
              </p>
            </article>
          ))}
          {data.truncated && (
            <p className="notice">
              Pokazano ostatnich 50 dni; lista nie jest kompletna.
            </p>
          )}
        </>
      )}
    </section>
  );
}
