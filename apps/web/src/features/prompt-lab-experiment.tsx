import { useEffect, useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import type { PromptLab } from '../../../../packages/core/src/registry/lab-store.js';
import { PromptLabReview } from './prompt-lab-review.js';
export type Experiment = Awaited<ReturnType<PromptLab['create']>>;
type History = Awaited<ReturnType<PromptLab['get']>>;
export function PromptLabExperiment({
  experiment,
}: {
  experiment: Experiment;
}) {
  const [history, setHistory] = useState<History | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [cancelReason, setCancelReason] = useState(''),
    [reviewCancel, setReviewCancel] = useState(false);
  const path = '/prompts/lab/experiments/' + experiment.experiment_hash;
  useEffect(() => {
    const controller = new AbortController();
    api<History>(path, undefined, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setHistory(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [path]);
  async function refresh() {
    setHistory(await api<History>(path));
  }
  async function act(index: number | null) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (index === null) await refresh();
      else {
        const job = await api<{ job_id: string }>(path + '/submit', {
          case_index: index,
        });
        setMessage(
          'Zapisano zadanie próby: ' +
            job.job_id +
            '. Zwykłe przetwarzanie ma pierwszeństwo.',
        );
        await refresh();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (busy || !reviewCancel) return;
    setBusy(true);
    setError('');
    try {
      setHistory(
        await api<History>(path + '/cancel', { reason: cancelReason }),
      );
      setReviewCancel(false);
      setMessage(
        'Anulowano dalsze wysyłanie prób. Zachowano dotychczasowe wyniki i zużycie.',
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Eksperyment Prompt Lab" className="notice prompt-lab">
      <h3>Porównanie A/B</h3>
      <p>
        Ten sam model: {experiment.controls.variants[0].model}. Te same źródło,
        schemat, reasoning i limit odpowiedzi. Każda próba wymaga osobnego
        uruchomienia.
      </p>
      <p>
        Wyniki mogą różnić się między powtórzeniami. Provider nie udostępnia
        seed. Ocena jakości wymaga ludzi; eksperyment nie publikuje promptu ani
        nie zmienia wybranej analizy.
      </p>
      <p className="metadata">Eksperyment: {experiment.experiment_hash}</p>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <button disabled={busy} onClick={() => void act(null)}>
        Odśwież wyniki porównania
      </button>
      {history?.cancelled && <p>Anulowany — dalsze requesty są zablokowane.</p>}
      <ul>
        {experiment.cases.map((trial, index) => {
          const jobs =
            history?.jobs.filter((job) => job.case_index === index) ?? [];
          return (
            <li key={index}>
              <p>
                Wariant {trial.variant} · Powtórzenie {trial.repeat} ·{' '}
                {jobs[0]?.state ?? 'Nie uruchomiono'}
              </p>
              <button
                disabled={busy || history?.cancelled}
                onClick={() => void act(index)}
              >
                {jobs.length ? 'Sprawdź zapis zadania' : 'Uruchom próbę'}{' '}
                {trial.variant}/{trial.repeat}
              </button>
              {jobs.map((job) => (
                <div key={job.job_id + (job.run_id ?? '')}>
                  <p className="metadata">
                    Zadanie: {job.job_id} ·{' '}
                    {job.reason_code ?? 'Oczekuje na przetwarzanie'}
                    {job.run_id && (
                      <>
                        {' '}
                        · Run: {job.run_id} ·{' '}
                        {job.validation_outcome ?? job.run_state}
                      </>
                    )}
                    {job.candidate_hash && (
                      <> · Hash wyniku: {job.candidate_hash}</>
                    )}
                  </p>
                  {job.run_id &&
                    job.candidate_hash &&
                    ['SUCCEEDED', 'FAILED'].includes(job.state) && (
                      <PromptLabReview
                        experimentHash={experiment.experiment_hash}
                        runId={job.run_id}
                      />
                    )}
                </div>
              ))}
            </li>
          );
        })}
      </ul>
      {history?.history_truncated && (
        <p>
          Historia przekroczyła limit widoku. Pełne wyniki pozostają w trwałym
          rejestrze.
        </p>
      )}
      {!history?.cancelled && (
        <>
          <label>
            Powód anulowania eksperymentu
            <input
              maxLength={1000}
              value={cancelReason}
              disabled={busy || reviewCancel}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </label>
          {!reviewCancel ? (
            <button
              disabled={busy || !cancelReason.trim()}
              onClick={() => setReviewCancel(true)}
            >
              Przejrzyj anulowanie
            </button>
          ) : (
            <div>
              <p>
                Anulowanie zatrzyma nowe wysyłki. Requesty już wysłane mogą się
                zakończyć; ich wyniki i koszt pozostaną zapisane.
              </p>
              <button disabled={busy} onClick={() => void cancel()}>
                Potwierdź anulowanie eksperymentu
              </button>
              <button disabled={busy} onClick={() => setReviewCancel(false)}>
                Zachowaj eksperyment
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
