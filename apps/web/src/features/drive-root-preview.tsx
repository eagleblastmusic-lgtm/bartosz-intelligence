import { useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import type { DriveRootPreview as Preview } from '../../../../packages/core/src/drive/root.js';

export function DriveRootPreview({
  connectionId,
  revision,
  enabled,
  changed,
}: {
  connectionId: string;
  revision: number;
  enabled: boolean;
  changed: () => void;
}) {
  const [root, setRoot] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <section aria-labelledby={'root-heading-' + connectionId}>
      <h4 id={'root-heading-' + connectionId}>Sprawdź wskazany folder Daily</h4>
      <p>
        Wskaż folder, do którego aplikacja ma już dostęp. Wpisanie
        identyfikatora nie nadaje nowych uprawnień Google. Ten krok pokazuje
        dostęp i wpływ zmiany, a nie uruchamia eksportu.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          setPreview(null);
          void api<Preview>('/connections/drive/root/preview', {
            connection_id: connectionId,
            root_id: root.trim(),
            expected_revision: revision,
          })
            .then((value) => {
              setPreview(value);
              changed();
            })
            .catch((error) => setError(errorMessage(error)))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy || !enabled}>
          <label htmlFor={'root-id-' + connectionId}>
            Identyfikator wybranego folderu
          </label>
          <input
            id={'root-id-' + connectionId}
            value={root}
            maxLength={200}
            pattern="[A-Za-z0-9_-]+"
            required
            autoComplete="off"
            onChange={(event) => {
              setRoot(event.target.value);
              setPreview(null);
            }}
          />
          <button type="submit">Sprawdź folder</button>
        </fieldset>
      </form>
      {busy && <p role="status">Sprawdzanie dostępu i mapowania…</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <div className="notice" role="status">
          <p>Folder: {preview.folder_name}. Odczyt metadanych: potwierdzony.</p>
          <p>
            Istniejące mapowania: {preview.existing_mapping_count}.{' '}
            {preview.root_changed
              ? 'Zmiana folderu wymaga przeglądu mapowań, aby nie tworzyć duplikatów.'
              : 'Brak zmiany istniejącego folderu.'}
          </p>
          <p>
            Poprzedni folder i identyfikatory plików pozostają zachowane.
            Wybranego folderu nie zapisano jako gotowego do eksportu.
          </p>
          <p>
            Próba zapisu, odczytu i aktualizacji pliku dziecka: nie wykonano.
            Eksport: niedostępny.
          </p>
          <p>
            Przestrzeń konta (bajty): wykorzystano{' '}
            {preview.storage.usage_bytes ?? 'nieustalone'}, limit{' '}
            {preview.storage.limit_bytes ?? 'nieustalony'}.
          </p>
        </div>
      )}
    </section>
  );
}
