import { useEffect, useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import type { PromptDrafts } from '../../../../packages/core/src/registry/draft.js';
import type { PromptTests } from '../../../../packages/core/src/registry/test.js';
import type { AnalysisSettings } from '../../../../packages/core/src/ai/jobs.js';
import type { ItemRepository } from '../../../../packages/core/src/db/items.js';
type Version = Awaited<ReturnType<PromptDrafts['version']>>;
type Preview = Awaited<ReturnType<PromptTests['preview']>>;
type Items = Awaited<ReturnType<ItemRepository['list']>>;
type Context = {
  available: boolean;
  settings: AnalysisSettings | null;
  model_profile: { profile_id: string; revision: number; model: string } | null;
  source_choices: { run_id: string; role: string; label: string }[];
  profiles: {
    profile_id: string;
    revision: number;
    name: string;
    mode: string;
    optional_tasks: boolean;
  }[];
};
export function PromptTestRun({ prompt }: { prompt: Version }) {
  const [open, setOpen] = useState(false),
    [items, setItems] = useState<Items | null>(null),
    [item, setItem] = useState(''),
    [context, setContext] = useState<Context | null>(null),
    [source, setSource] = useState(''),
    [semantic, setSemantic] = useState(''),
    [model, setModel] = useState(''),
    [output, setOutput] = useState('4000'),
    [limits, setLimits] = useState('{}'),
    [preview, setPreview] = useState<Preview | null>(null),
    [nonce, setNonce] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const analysisMode: Record<string, string> = {
    ECONOMY_ANALYSIS_V1: 'ECONOMY',
    FULL_ANALYSIS_V1: 'FULL',
    ADVANCED_ANALYSIS_V1: 'CUSTOM',
  };
  const supported =
    prompt.prompt_id !== 'JSON_REPAIR_V1' && !prompt.usage_restriction;
  useEffect(() => {
    if (!open || !supported) return;
    const controller = new AbortController();
    api<Items>('/items?limit=50', undefined, undefined, controller.signal)
      .then(setItems)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [open, supported]);
  useEffect(() => {
    if (!item) return;
    const controller = new AbortController();
    setContext(null);
    setPreview(null);
    setMessage('');
    setError('');
    api<Context>(
      '/reprocess/context/' + encodeURIComponent(item),
      undefined,
      undefined,
      controller.signal,
    )
      .then((row) => {
        if (controller.signal.aborted) return;
        setContext(row);
        setSource(row.source_choices[0]?.run_id ?? '');
        setSemantic('');
        setModel(String(row.model_profile?.revision ?? ''));
        setOutput(String(row.settings?.max_output_tokens ?? 4000));
        setLimits(JSON.stringify(row.settings?.limits ?? {}, null, 2));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [item]);
  function reset() {
    setPreview(null);
    setMessage('');
  }
  async function next() {
    if (busy || !items?.next_cursor) return;
    setBusy(true);
    setError('');
    try {
      setItems(
        await api<Items>(
          '/items?limit=50&cursor=' + encodeURIComponent(items.next_cursor),
        ),
      );
      setItem('');
      setContext(null);
      reset();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    if (busy || !context?.settings || !source) return;
    setBusy(true);
    setError('');
    reset();
    const selected = context.profiles.find(
      (row) => row.profile_id + ':' + row.revision === semantic,
    );
    try {
      let parsedLimits: Record<string, number> = {};
      if (analysisMode[prompt.prompt_id]) {
        const value: unknown = JSON.parse(limits);
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).length > 64 ||
          Object.values(value).some(
            (n) => !Number.isSafeInteger(n) || (n as number) < 0,
          )
        )
          throw new Error('INVALID_ANALYSIS_SETTINGS');
        parsedLimits = value as Record<string, number>;
      }
      const result = await api<Preview>('/prompts/tests/preview', {
        prompt_id: prompt.prompt_id,
        version: prompt.version,
        source_run_id: source,
        semantic_profile_id: selected?.profile_id ?? null,
        semantic_profile_revision: selected?.revision ?? null,
        model_revision: Number(model),
        max_output_tokens: Number(output),
        purpose: context.settings.purpose,
        region: context.settings.region,
        limits: parsedLimits,
      });
      setNonce(crypto.randomUUID());
      setPreview(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (busy || !preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ job_id: string }>(
        preview.kind === 'ANALYSIS'
          ? '/reprocess/confirm'
          : '/optional/confirm',
        { preview_hash: preview.preview_hash, nonce },
      );
      setMessage(
        'Zapisano zadanie próby jakości: ' +
          result.job_id +
          '. Wynik nie zmienia wybranej analizy.',
      );
      setPreview(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Przygotuj próbę jakości tej wersji</summary>
      {!supported ? (
        <p className="notice">
          {prompt.usage_restriction ? (
            'Ta wersja została wycofana z nowych użyć.'
          ) : (
            <>
              Naprawa odpowiedzi wymaga rzeczywistego niepoprawnego kandydata i
              kontrolowanej ścieżki repair. Samodzielna próba tego adaptera jest
              niedostępna.
            </>
          )}
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="notice">
              {message}
            </p>
          )}
          <label>
            Materiał do próby
            <select
              value={item}
              disabled={busy}
              onChange={(e) => {
                setItem(e.target.value);
                reset();
              }}
            >
              <option value="">Wybierz materiał</option>
              {items?.items.map((row) => (
                <option key={row.item_id} value={row.item_id}>
                  {String(row.metadata.title ?? row.item_id)}
                </option>
              ))}
            </select>
          </label>
          {items?.next_cursor && (
            <button disabled={busy} onClick={() => void next()}>
              Następne materiały
            </button>
          )}
          {context && (
            <>
              {!context.available && (
                <p className="notice">
                  Brak zaakceptowanego źródła lub ważnej kwalifikacji Free Tier.
                  Nie można uruchomić próby.
                </p>
              )}
              <label>
                Rewizja źródła
                <select
                  value={source}
                  disabled={busy}
                  onChange={(e) => {
                    setSource(e.target.value);
                    reset();
                  }}
                >
                  {context.source_choices.map((row) => (
                    <option key={row.run_id} value={row.run_id}>
                      {row.label} · {row.run_id}
                    </option>
                  ))}
                </select>
              </label>
              {analysisMode[prompt.prompt_id] && (
                <label>
                  Profil semantyczny
                  <select
                    value={semantic}
                    disabled={busy}
                    onChange={(e) => {
                      setSemantic(e.target.value);
                      reset();
                    }}
                  >
                    <option value="">Wybierz profil</option>
                    {context.profiles
                      .filter(
                        (row) =>
                          row.mode === analysisMode[prompt.prompt_id] &&
                          !row.optional_tasks,
                      )
                      .map((row) => (
                        <option
                          key={row.profile_id + ':' + row.revision}
                          value={row.profile_id + ':' + row.revision}
                        >
                          {row.name} · {row.revision}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <p className="metadata">
                Model: {context.model_profile?.model} · Gemini Free · runtime
                local · {context.settings?.region}
              </p>
              <label>
                Rewizja Gemini Free do próby
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={model}
                  disabled={busy}
                  onChange={(e) => {
                    setModel(e.target.value);
                    reset();
                  }}
                />
              </label>
              <label>
                Limit tokenów odpowiedzi do próby
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={output}
                  disabled={busy}
                  onChange={(e) => {
                    setOutput(e.target.value);
                    reset();
                  }}
                />
              </label>
              {prompt.prompt_id === 'HISTORICAL_COMPARE_V1' && (
                <p className="notice">
                  Historia porówna przyjęte wypowiedzi wybranej analizy tego
                  materiału z ograniczonym wycinkiem wcześniejszych wypowiedzi
                  tego samego kanału.
                </p>
              )}
              {analysisMode[prompt.prompt_id] && (
                <label>
                  Limity modułów do próby (JSON)
                  <textarea
                    rows={4}
                    maxLength={4000}
                    value={limits}
                    disabled={busy}
                    onChange={(e) => {
                      setLimits(e.target.value);
                      reset();
                    }}
                  />
                </label>
              )}
              <button
                disabled={
                  busy ||
                  !context.available ||
                  !source ||
                  Boolean(analysisMode[prompt.prompt_id] && !semantic) ||
                  Number(model) < 1 ||
                  Number(output) < 1
                }
                onClick={() => void prepare()}
              >
                Przygotuj podgląd próby
              </button>
            </>
          )}
          {preview && (
            <div role="status" className="notice">
              <p>
                Prompt {preview.prompt_id}, wersja {preview.prompt_version},
                model revision {preview.model_revision}. Wywołania AI:{' '}
                {preview.additional_model_requests}.
              </p>
              {'wire_schema_id' in preview && (
                <p className="metadata">
                  Schemat: {preview.wire_schema_id} · Hash:{' '}
                  {preview.wire_schema_hash}
                </p>
              )}
              <p>
                Quota: {preview.quota_status}. Przydział zostanie sprawdzony
                przed wysłaniem requestu. Brak aktualnego odczytu zatrzyma
                zadanie. Brak płatnego fallbacku.
              </p>
              <button disabled={busy} onClick={() => void confirm()}>
                Potwierdź zadanie próby jakości
              </button>
              <button disabled={busy} onClick={reset}>
                Anuluj próbę
              </button>
            </div>
          )}
        </>
      )}
    </details>
  );
}
