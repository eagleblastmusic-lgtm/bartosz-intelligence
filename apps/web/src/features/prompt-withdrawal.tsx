import { useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import type { PromptDrafts } from '../../../../packages/core/src/registry/draft.js';
type Version = Awaited<ReturnType<PromptDrafts['version']>>;
export function PromptWithdrawal({
  prompt,
  onChanged,
}: {
  prompt: Version;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState(''),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function confirm() {
    if (busy || !review || !reason.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api('/prompts/deprecate', {
        prompt_id: prompt.prompt_id,
        version: prompt.version,
        expected_hash: prompt.prompt_hash,
        reason,
      });
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Wycofanie wersji z nowych użyć</summary>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {prompt.usage_restriction ? (
        <p className="notice">
          Wersja {prompt.version} wycofana: {prompt.usage_restriction.reason}.
          Data: {prompt.usage_restriction.created_at}. Treść i historyczne
          zadania pozostają dostępne.
        </p>
      ) : (
        <>
          <label>
            Powód wycofania wersji
            <textarea
              rows={2}
              maxLength={1000}
              value={reason}
              disabled={busy}
              onChange={(e) => {
                setReason(e.target.value);
                setReview(false);
              }}
            />
          </label>
          {!review ? (
            <button
              disabled={busy || !reason.trim()}
              onClick={() => setReview(true)}
            >
              Przygotuj wycofanie
            </button>
          ) : (
            <div className="notice" role="status">
              <p>
                Wersja {prompt.version} zostanie trwale zablokowana dla nowych
                zadań, prób i publikacji. Istniejące zadania zachowają swój
                prompt. Jeśli to aktywna wersja, wybierz inną zgodną wersję
                przez publikację lub rollback, aby wznowić nowe zadania.
              </p>
              <button disabled={busy} onClick={() => void confirm()}>
                Potwierdź wycofanie wersji
              </button>
              <button disabled={busy} onClick={() => setReview(false)}>
                Anuluj wycofanie
              </button>
            </div>
          )}
        </>
      )}
    </details>
  );
}
