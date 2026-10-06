import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import { OptionalResult } from './optional-result.js';
import type { OptionalTaskPreparation } from '../../../../packages/core/src/ai/tasks/preparation.js';
type Preview = Awaited<ReturnType<OptionalTaskPreparation['preview']>>;
type Task = 'TRANSLATE' | 'HISTORICAL_COMPARE';
type Capabilities = {
  tasks: {
    task: Task;
    adapter_available: boolean;
    preview_available: boolean;
  }[];
};
type Results = {
  results: { run_id: string; task_type: Task; created_at: string }[];
};
export function ItemOptional({ itemId }: { itemId: string }) {
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [open, setOpen] = useState(false),
    [task, setTask] = useState<Task>('TRANSLATE'),
    [scope, setScope] = useState<'FULL' | 'SELECTED_SEGMENTS'>(
      'SELECTED_SEGMENTS',
    ),
    [capabilities, setCapabilities] = useState<Capabilities | null>(null),
    [results, setResults] = useState<Results | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const intent = useRef<{ preview_hash: string; nonce: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setBusy(true);
    setError('');
    Promise.all([
      api<Capabilities>(
        '/optional/capabilities',
        undefined,
        undefined,
        controller.signal,
      ),
      api<Results>(
        '/optional/results/' + encodeURIComponent(itemId),
        undefined,
        undefined,
        controller.signal,
      ),
    ])
      .then(([caps, rows]) => {
        if (!controller.signal.aborted) {
          setCapabilities(caps);
          setResults(rows);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [open, itemId]);
  async function prepare() {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    setPreview(null);
    intent.current = null;
    try {
      const result = await api<Preview>('/optional/preview', {
        item_id: itemId,
        task,
        scope: task === 'TRANSLATE' ? scope : null,
      });
      setPreview(result);
      intent.current = {
        preview_hash: result.preview_hash,
        nonce: crypto.randomUUID(),
      };
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (
      busy ||
      !preview ||
      !intent.current ||
      intent.current.preview_hash !== preview.preview_hash
    )
      return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ job_id: string }>(
        '/optional/confirm',
        intent.current,
      );
      setMessage(
        'Zadanie zapisano w trwałej kolejce: ' +
          result.job_id +
          '. Executor sprawdzi aktualną quota przed wywołaniem.',
      );
      setPreview(null);
      intent.current = null;
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Zadania opcjonalne" className="panel">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        Tłumaczenie i historia
      </button>
      {open && (
        <>
          <p>
            Oddzielne zadania korzystają z Gemini Free. Przyjęta analiza
            pozostaje dostępna podczas oczekiwania lub błędu.
          </p>
          <label>
            Zadanie opcjonalne
            <select
              disabled={busy}
              value={task}
              onChange={(e) => {
                setTask(e.target.value as Task);
                setPreview(null);
                intent.current = null;
              }}
            >
              <option value="TRANSLATE">Polski helper źródła</option>
              <option value="HISTORICAL_COMPARE">
                Porównanie historii kanału
              </option>
            </select>
          </label>
          {task === 'TRANSLATE' && (
            <label>
              Zakres tłumaczenia
              <select
                disabled={busy}
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as typeof scope);
                  setPreview(null);
                  intent.current = null;
                }}
              >
                <option value="SELECTED_SEGMENTS">
                  Segmenty z przyjętych dowodów
                </option>
                <option value="FULL">Całe źródło</option>
              </select>
            </label>
          )}
          {capabilities &&
            !capabilities.tasks.find((t) => t.task === task)
              ?.preview_available && (
              <p className="notice">
                Adapter istnieje. Aktualna konfiguracja Free lub opublikowany
                prompt nie kwalifikują jeszcze tego zadania.
              </p>
            )}
          <button
            disabled={
              busy ||
              !capabilities?.tasks.find((t) => t.task === task)
                ?.preview_available
            }
            onClick={() => void prepare()}
          >
            Przygotuj zakres i koszt
          </button>
          {preview && (
            <div className="notice">
              <p>
                Zakres:{' '}
                {preview.source_scope === 'FULL'
                  ? 'całe źródło'
                  : preview.source_scope === 'SELECTED_SEGMENTS'
                    ? 'segmenty przyjętych dowodów'
                    : 'ograniczona historia tego samego kanału'}{' '}
                · liczba pozycji: {preview.scope_count}.
              </p>
              <p>
                Oddzielne wywołania: {preview.additional_model_requests}.
                Szacunek wejścia: {preview.token_estimate.input_tokens}; limit
                odpowiedzi: {preview.token_estimate.output_tokens}. Bieżąca
                quota: nieznana.
              </p>
              <p>
                Potwierdzenie zapisuje zadanie; nie zmienia przyjętej analizy.
                Brak aktualnej quota wstrzyma wywołanie API.
              </p>
              <button disabled={busy} onClick={() => void confirm()}>
                Potwierdź oddzielne zadanie
              </button>
            </div>
          )}
          {busy && <p role="status">Przygotowywanie…</p>}
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          {results && (
            <p className="muted">
              Przyjęte wyniki opcjonalne: {results.results.length}
              {results.results.length === 20 ? ' (ostatnie 20)' : ''}.
            </p>
          )}
          {results?.results.map((result) => (
            <button
              key={result.run_id}
              onClick={() => setSelectedRun(result.run_id)}
            >
              {result.task_type === 'TRANSLATE'
                ? 'Czytaj polski helper'
                : 'Czytaj porównanie historii'}{' '}
              · {new Date(result.created_at).toLocaleString('pl-PL')}
            </button>
          ))}
          {selectedRun && (
            <OptionalResult
              key={selectedRun}
              runId={selectedRun}
              itemId={itemId}
            />
          )}
        </>
      )}
    </section>
  );
}
