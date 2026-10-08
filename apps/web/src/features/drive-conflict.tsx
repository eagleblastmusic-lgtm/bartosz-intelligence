import { useState } from 'react';
import type {
  DriveStatus,
  DailyExportStatus,
} from '../../../../packages/contracts/src/drive.js';
import type { DriveConflictPreview } from '../../../../packages/core/src/drive/conflict.js';
import { api, errorMessage } from '../app/api.js';

export function DriveConflict({
  day,
  changed,
}: {
  day: DailyExportStatus['days'][number];
  changed: () => void;
}) {
  const [preview, setPreview] = useState<DriveConflictPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function inspect() {
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const status = await api<DriveStatus>('/connections/drive/status');
      const connection = status.connections.find(
        (row) =>
          row.connection_id === day.connection_id &&
          row.auth_state === 'CONNECTED' &&
          row.root_state === 'VERIFIED' &&
          row.root_id === day.root_id,
      );
      if (!connection) throw new Error('DRIVE_CONNECTION_REQUIRED');
      setPreview(
        await api<DriveConflictPreview>(
          '/connections/drive/exports/conflict/preview',
          {
            connection_id: day.connection_id,
            root_id: day.root_id,
            date: day.date,
            expected_connection_revision: connection.revision,
            expected_settings_revision: day.settings_revision,
          },
        ),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await api('/connections/drive/exports/conflict/confirm', {
        connection_id: preview.connection_id,
        preview_hash: preview.preview_hash,
        expected_connection_revision: preview.connection_revision,
        action: 'KEEP_MANUAL',
      });
      setPreview(null);
      changed();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={'Konflikt eksportu ' + day.date}>
      <p>
        Ręczna wersja pliku pozostaje zachowana. Podgląd sprawdza aktualny plik;
        nie wykonuje zapisu do Drive.
      </p>
      <button
        disabled={
          busy ||
          day.auth_state !== 'CONNECTED' ||
          day.root_state !== 'VERIFIED'
        }
        onClick={() => void inspect()}
      >
        Sprawdź konflikt {day.date}
      </button>
      {busy && <p role="status">Sprawdzanie konfliktu…</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <div className="notice">
          <p>
            Plik:{' '}
            <a
              href={
                'https://drive.google.com/file/d/' +
                encodeURIComponent(preview.file_id) +
                '/view'
              }
              target="_blank"
              rel="noreferrer"
            >
              Otwórz ręczną wersję w Drive
            </a>
          </p>
          <p>
            Rewizja zdalna: {preview.remote_version}. Rozmiar:{' '}
            {preview.remote_bytes} B.
          </p>
          <p>
            Hash sprawdzonej treści: <code>{preview.remote_hash}</code>
          </p>
          <p>Podgląd ważny do: {preview.expires_at}.</p>
          <p>
            Ta decyzja wstrzyma automatyczny eksport tego dnia, również dla
            przyszłych zmian. Plik i mapowanie pozostaną zachowane. Wiedza i
            analizy w Core nadal będą aktualizowane niezależnie.
          </p>
          <button disabled={busy} onClick={() => void confirm()}>
            Zachowaj ręczną wersję i wstrzymaj eksport {day.date}
          </button>
        </div>
      )}
    </section>
  );
}
