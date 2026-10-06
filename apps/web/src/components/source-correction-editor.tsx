import { useState } from 'react';
import type { EvidenceRead } from '../../../../packages/contracts/src/evidence-read.js';
import { api, errorMessage } from '../app/api.js';
export function SourceCorrectionEditor({
  evidence,
  quote,
}: {
  evidence: EvidenceRead;
  quote: string;
}) {
  const [open, setOpen] = useState(false),
    [fragment, setFragment] = useState(quote),
    [replacement, setReplacement] = useState(''),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [jobId, setJobId] = useState('');
  const [proposal, setProposal] = useState<{
    source_start: number;
    source_end: number;
    old_value: string;
    new_value: string;
    reason: string;
    correction_id: string;
  } | null>(null);
  function preview() {
    setError('');
    const offset = quote.indexOf(fragment);
    if (
      !fragment ||
      /[\r\n]/.test(fragment) ||
      offset < 0 ||
      quote.indexOf(fragment, offset + 1) >= 0 ||
      !replacement.trim() ||
      /[\r\n\uD800-\uDFFF]/u.test(replacement) ||
      !reason.trim()
    ) {
      setError(
        'Wskaż jeden jednoznaczny fragment cytatu bez podziału wiersza, nowy tekst i powód.',
      );
      return;
    }
    setProposal({
      source_start: evidence.source_start + offset,
      source_end: evidence.source_start + offset + fragment.length,
      old_value: fragment,
      new_value: replacement,
      reason,
      correction_id: crypto.randomUUID(),
    });
  }
  async function confirm() {
    if (!proposal || busy) return;
    setBusy(true);
    setError('');
    try {
      const { reason, correction_id, ...patch } = proposal;
      const job = await api<{ job_id: string }>(
        '/corrections/source',
        {
          source_artifact_id: evidence.source_artifact_id,
          patches: [patch],
          reason,
          correction_id,
        },
        correction_id,
      );
      setJobId(job.job_id);
      setProposal(null);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return <button onClick={() => setOpen(true)}>Korekta zapisu źródła</button>;
  return (
    <section
      className="notice correction-editor"
      aria-label="Korekta zapisu źródła"
    >
      <h3>Korekta zapisu źródła</h3>
      <p>
        Powstanie osobna wersja autorstwa właściciela. Oryginał, cytaty i czasy
        pozostaną zachowane. Zadanie poczeka na lokalny executor; analiza AI
        wymaga późniejszej, osobnej decyzji.
      </p>
      {error && <p role="alert">{error}</p>}
      {jobId ? (
        <p role="status">
          Zapisano trwałe zadanie korekty: {jobId}. Jego przyjęcie można
          sprawdzić w Systemie.
        </p>
      ) : (
        <>
          <label>
            Fragment oryginalnego cytatu
            <input
              maxLength={20000}
              value={fragment}
              onChange={(event) => {
                setFragment(event.target.value);
                setProposal(null);
              }}
            />
          </label>
          <label>
            Poprawiony zapis
            <textarea
              maxLength={20000}
              value={replacement}
              onChange={(event) => {
                setReplacement(event.target.value);
                setProposal(null);
              }}
            />
          </label>
          <label>
            Powód poprawienia zapisu
            <input
              maxLength={2000}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setProposal(null);
              }}
            />
          </label>
          <button disabled={busy} onClick={preview}>
            Podgląd poprawienia źródła
          </button>
          {proposal && (
            <section aria-label="Podgląd poprawienia źródła">
              <p>Oryginał: {proposal.old_value}</p>
              <p>Korekta: {proposal.new_value}</p>
              <p>Powód: {proposal.reason}</p>
              <button disabled={busy} onClick={() => void confirm()}>
                Potwierdź poprawienie źródła
              </button>
              <button disabled={busy} onClick={() => setProposal(null)}>
                Anuluj poprawienie
              </button>
            </section>
          )}
        </>
      )}
      <button disabled={busy} onClick={() => setOpen(false)}>
        Zamknij poprawianie źródła
      </button>
    </section>
  );
}
