import { useState } from 'react';
import { api, ApiError, errorMessage } from '../app/api.js';
import type { DriveRootPreview as Preview } from '../../../../packages/core/src/drive/root.js';
type RootPreview = Preview & {
  created_candidate?: boolean;
  private_owner_only?: boolean;
};

export function DriveRootPreview({
  connectionId,
  revision,
  enabled,
  changed,
  candidates = [],
  candidatesTruncated = false,
}: {
  connectionId: string;
  revision: number;
  enabled: boolean;
  changed: () => void;
  candidates?: {
    name: string;
    folder_id: string;
    state: 'RESERVED' | 'CREATED';
  }[];
  candidatesTruncated?: boolean;
}) {
  const [root, setRoot] = useState(''),
    [name, setName] = useState('Daily'),
    [preview, setPreview] = useState<RootPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  function failed(error: unknown) {
    setError(errorMessage(error));
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.code === 'REVISION_CONFLICT'
    )
      changed();
  }
  return (
    <section aria-labelledby={'root-heading-' + connectionId}>
      <h4 id={'root-heading-' + connectionId}>Sprawdź wskazany folder Daily</h4>
      {candidates.length > 0 && (
        <div className="notice">
          <p>
            Wcześniej przygotowane foldery — nie są jeszcze zatwierdzone do
            eksportu.
          </p>
          <ul>
            {candidates.map((candidate) => (
              <li key={candidate.folder_id}>
                <strong>{candidate.name}</strong> ·{' '}
                {candidate.state === 'CREATED'
                  ? 'Utworzono'
                  : 'Tworzenie wymaga dokończenia'}{' '}
                <button
                  type="button"
                  disabled={busy || !enabled}
                  onClick={() => {
                    setRoot(candidate.folder_id);
                    setName(candidate.name);
                    setPreview(null);
                    setError('');
                  }}
                >
                  Użyj folderu {candidate.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {candidatesTruncated && (
        <p className="notice">Lista przygotowanych folderów jest niepełna.</p>
      )}
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
          void api<RootPreview>('/connections/drive/root/create', {
            connection_id: connectionId,
            name: name.trim(),
            expected_revision: revision,
          })
            .then((value) => {
              setPreview(value);
              setRoot(value.requested_root_id);
              changed();
            })
            .catch(failed)
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy || !enabled}>
          <label htmlFor={'root-name-' + connectionId}>
            Nazwa nowego prywatnego folderu
          </label>
          <input
            id={'root-name-' + connectionId}
            value={name}
            required
            maxLength={100}
            onChange={(event) => {
              setName(event.target.value);
              setPreview(null);
            }}
          />
          <button type="submit">Utwórz prywatny folder</button>
        </fieldset>
      </form>
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
            .catch(failed)
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
          {preview.private_owner_only && (
            <p>
              Uprawnienia: wyłącznie właściciel. Folder czeka na pełną
              weryfikację zapisu.
            </p>
          )}
          <p>
            Istniejące mapowania: {preview.existing_mapping_count}.{' '}
            {preview.root_changed
              ? 'Zmiana folderu wymaga przeglądu mapowań, aby nie tworzyć duplikatów.'
              : preview.current_root_id === null
                ? 'Nie wybrano jeszcze folderu do eksportu.'
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
