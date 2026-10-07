import { useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import {
  PromptLabExperiment,
  type Experiment,
} from './prompt-lab-experiment.js';
import type { PromptLab } from '../../../../packages/core/src/registry/lab-store.js';
type Page = Awaited<ReturnType<PromptLab['list']>>;
export function PromptLabHistory() {
  const [page, setPage] = useState<Page | null>(null),
    [selected, setSelected] = useState<Experiment | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load(before: string | null = null) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setPage(
        await api<Page>(
          '/prompts/lab/experiments' +
            (before ? '?before=' + encodeURIComponent(before) : ''),
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function open(hash: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<Awaited<ReturnType<PromptLab['get']>>>(
        '/prompts/lab/experiments/' + hash,
      );
      setSelected({ ...result.definition, experiment_hash: hash });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="prompt-lab"
      onToggle={(e) => {
        if (e.currentTarget.open && !page) void load();
      }}
    >
      <summary>Historia eksperymentów Prompt Lab</summary>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={() => void load()}>
        Odśwież historię eksperymentów
      </button>
      {page && (
        <>
          <ul>
            {page.items.map((item) => (
              <li key={item.experiment_hash}>
                <button
                  disabled={busy}
                  onClick={() => void open(item.experiment_hash)}
                >
                  {item.reason} · {item.source_count} źródeł · {item.case_count}{' '}
                  prób
                </button>
                <p className="metadata">
                  {item.created_at} · {item.experiment_hash}
                </p>
              </li>
            ))}
          </ul>
          {!page.items.length && <p>Brak zapisanych eksperymentów.</p>}
          {page.next_before && (
            <button disabled={busy} onClick={() => void load(page.next_before)}>
              Starsze eksperymenty
            </button>
          )}
        </>
      )}
      {selected && (
        <PromptLabExperiment
          key={selected.experiment_hash}
          experiment={selected}
        />
      )}
    </details>
  );
}
