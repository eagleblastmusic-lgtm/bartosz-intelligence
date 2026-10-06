import { useEffect, useState } from 'react';
import type {
  KnowledgeCorrections,
  CorrectionKind,
} from '../../../../packages/core/src/knowledge/corrections.js';
import { api, errorMessage } from '../app/api.js';
type Target = Awaited<ReturnType<KnowledgeCorrections['read']>>;
export function CorrectionEditor({
  kind,
  id,
  changed,
}: {
  kind: CorrectionKind;
  id: string;
  changed?: () => void;
}) {
  const [open, setOpen] = useState(false),
    [target, setTarget] = useState<Target | null>(null),
    [value, setValue] = useState(''),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [proposal, setProposal] = useState<{
      new_value: string;
      action: 'APPLY' | 'REVERT';
      reason: string;
      correction_id: string;
    } | null>(null);
  const path = '/corrections/' + kind + '/' + encodeURIComponent(id);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setBusy(true);
    setError('');
    setProposal(null);
    api<Target>(path, undefined, undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setTarget(result);
          setValue(result.effective_value);
          setReason('');
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [open, path, revision]);
  async function confirm() {
    if (!target || !proposal || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(
        path,
        {
          ...proposal,
          expected_revision: target.revision,
          target_hash: target.target_hash,
          old_value: target.effective_value,
        },
        proposal.correction_id,
      );
      setProposal(null);
      setRevision((value) => value + 1);
      changed?.();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <button onClick={() => setOpen(true)}>
        {kind === 'ENTITY_LABEL'
          ? 'Korekta nazwy właściciela'
          : 'Korekta interpretacji właściciela'}
      </button>
    );
  return (
    <section
      className="notice correction-editor"
      aria-label="Korekta właściciela"
    >
      <h3>Korekta właściciela</h3>
      <p>
        To odrębna interpretacja autora korekty. Oryginalna ekstrakcja, cytaty i
        przyjęty wynik pozostają zachowane.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && !target && <p role="status">Wczytywanie korekt…</p>}
      {target && (
        <>
          <p>Oryginał: {target.original_value}</p>
          <label>
            Tekst korekty
            <textarea
              maxLength={20000}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setProposal(null);
              }}
            />
          </label>
          <label>
            Powód korekty
            <input
              maxLength={2000}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setProposal(null);
              }}
            />
          </label>
          <div className="header-controls">
            <button
              disabled={busy || !value.trim() || !reason.trim()}
              onClick={() =>
                setProposal({
                  new_value: value,
                  reason,
                  action: 'APPLY',
                  correction_id: crypto.randomUUID(),
                })
              }
            >
              Podgląd korekty
            </button>
            <button
              disabled={
                busy ||
                !reason.trim() ||
                target.effective_value === target.original_value
              }
              onClick={() =>
                setProposal({
                  new_value: target.original_value,
                  reason,
                  action: 'REVERT',
                  correction_id: crypto.randomUUID(),
                })
              }
            >
              Podgląd przywrócenia oryginału
            </button>
          </div>
          {proposal && (
            <section aria-label="Podgląd korekty">
              <p>{proposal.new_value}</p>
              <p>Powód: {proposal.reason}</p>
              <button disabled={busy} onClick={() => void confirm()}>
                Potwierdź korektę
              </button>
              <button disabled={busy} onClick={() => setProposal(null)}>
                Anuluj korektę
              </button>
            </section>
          )}
          <details>
            <summary>
              Historia korekt ({target.history.length}
              {target.history_has_more ? '+' : ''})
            </summary>
            {target.history.map((event) => (
              <article key={event.correction_id}>
                <p>{event.new_value}</p>
                <p>{event.reason}</p>
                <p className="metadata">
                  {event.recorded_at} · autor: właściciel
                </p>
              </article>
            ))}
          </details>
        </>
      )}
      <button disabled={busy} onClick={() => setOpen(false)}>
        Zamknij korektę
      </button>
    </section>
  );
}
