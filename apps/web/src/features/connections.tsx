import { useEffect, useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import { AppLink } from '../app/router.js';
import type { DriveStatus } from '../../../../packages/contracts/src/drive.js';
import { DriveRootPreview } from './drive-root-preview.js';
export function Connections() {
  const [data, setData] = useState<DriveStatus | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<DriveStatus>(
      '/connections/drive/status',
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
  }, [revision]);
  async function connect(connectionId?: string) {
    setBusy(true);
    setError('');
    try {
      const response = await api<{ authorization_url: string }>(
        '/connections/drive/' + (connectionId ? 'reconnect' : 'start'),
        connectionId ? { connection_id: connectionId } : {},
      );
      const target = new URL(response.authorization_url);
      if (
        target.origin !== 'https://accounts.google.com' ||
        target.pathname !== '/o/oauth2/v2/auth'
      )
        throw new Error('INVALID_AUTHORIZATION_DESTINATION');
      location.assign(target.href);
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Połączenia</h1>
          <p className="muted">
            Prywatny dostęp do usług używanych przez aplikację.
          </p>
        </div>
        <div className="row-actions">
          <AppLink href="/system">System</AppLink>
          <button
            disabled={busy}
            onClick={() => setRevision((value) => value + 1)}
          >
            Odśwież stan
          </button>
        </div>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">Pobieranie połączeń…</p>}
      {data && (
        <section className="panel" aria-labelledby="drive-title">
          <h2 id="drive-title">Google Drive</h2>
          <p>
            Daily będzie zapisywany prywatnie w folderze wskazanym przez Ciebie.
            Samo połączenie konta nie uruchamia eksportu.
          </p>
          {!data.configured && (
            <p id="drive-setup" className="notice">
              Konfiguracja połączenia wymaga dokończenia w środowisku serwera i
              przygotowania prywatnego odzyskiwania dostępu.
            </p>
          )}
          {data.connections.length === 0 && (
            <p>Brak połączonego konta Drive.</p>
          )}
          <button
            disabled={busy || !data.configured}
            aria-describedby={!data.configured ? 'drive-setup' : undefined}
            onClick={() => void connect()}
          >
            Połącz konto Google Drive
          </button>
          {data.connections.map((connection) => (
            <article className="panel" key={connection.connection_id}>
              <h3>Połączenie Drive</h3>
              <dl>
                <dt>Dostęp</dt>
                <dd>
                  {connection.auth_state === 'CONNECTED' &&
                  connection.offline_credential_present
                    ? 'Połączono — dostęp offline'
                    : connection.auth_state === 'REVOKED'
                      ? 'Odłączono'
                      : 'Wymaga ponownego połączenia'}
                </dd>
                <dt>Folder Daily</dt>
                <dd>{connection.root_id ?? 'Nie wybrano'}</dd>
                <dt>Weryfikacja folderu</dt>
                <dd>
                  {connection.root_state === 'VERIFIED'
                    ? 'Zweryfikowano dostęp'
                    : 'Wymagana weryfikacja dostępu do folderu'}
                </dd>
                <dt>Ostatnie odnowienie dostępu</dt>
                <dd>
                  {connection.last_refresh_at
                    ? new Date(connection.last_refresh_at).toLocaleString(
                        'pl-PL',
                        { timeZone: 'Europe/Warsaw' },
                      )
                    : 'Nie wykonano'}
                </dd>
              </dl>
              {connection.publishing_state === 'UNKNOWN' ||
              connection.publishing_state === 'TESTING' ? (
                <p className="notice">
                  Trwałość autoryzacji produkcyjnej wymaga potwierdzenia
                  ustawień Google i rzeczywistego odnowienia dostępu.
                </p>
              ) : null}
              {connection.last_error && (
                <p className="notice">
                  Dostęp wymaga sprawdzenia lub odzyskania. Dane w Core i
                  mapowanie folderu pozostają zachowane.
                </p>
              )}
              <button
                disabled={busy || !data.configured}
                onClick={() => void connect(connection.connection_id)}
              >
                Połącz ponownie
              </button>
              <DriveRootPreview
                connectionId={connection.connection_id}
                revision={connection.revision}
                enabled={
                  data.configured &&
                  connection.auth_state === 'CONNECTED' &&
                  connection.offline_credential_present
                }
                changed={() => setRevision((value) => value + 1)}
              />
            </article>
          ))}
          {data.truncated && (
            <p className="notice">
              Pokazano pierwszych 50 połączeń; lista nie jest kompletna.
            </p>
          )}
          <p className="notice">
            Eksport do Drive oczekuje na weryfikację folderu i bezpiecznej
            aktualizacji plików. Zbieranie materiałów w Core działa niezależnie.
          </p>
        </section>
      )}
    </>
  );
}
