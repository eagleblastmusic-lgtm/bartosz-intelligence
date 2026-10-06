import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import type {
  AnalysisJobs,
  AnalysisSettings,
} from '../../../../packages/core/src/ai/jobs.js';
type Preview = Awaited<ReturnType<AnalysisJobs['previewExplicit']>>;
type Context = {
  source_run_id: string | null;
  candidate_run_id: string | null;
  available: boolean;
  settings: AnalysisSettings | null;
  profiles: {
    profile_id: string;
    revision: number;
    name: string;
    mode: string;
    second_pass: boolean;
    validation_pass: boolean;
    optional_tasks: boolean;
  }[];
  has_more: boolean;
};
export function ItemReprocess({ itemId }: { itemId: string }) {
  const [open, setOpen] = useState(false),
    [context, setContext] = useState<Context | null>(null),
    [profile, setProfile] = useState(''),
    [mode, setMode] = useState<'REPROCESS' | 'SECOND_PASS' | 'VALIDATE'>(
      'REPROCESS',
    ),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const intent = useRef<{ preview_hash: string; nonce: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setBusy(true);
    api<Context>(
      '/reprocess/context/' + encodeURIComponent(itemId),
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setContext(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [open, itemId]);
  const selected = context?.profiles.find(
    (p) => `${p.profile_id}:${p.revision}` === profile,
  );
  const supported =
    selected &&
    !selected.optional_tasks &&
    (mode === 'REPROCESS' ||
      Boolean(
        context?.candidate_run_id &&
        (mode === 'SECOND_PASS'
          ? selected.second_pass
          : selected.validation_pass),
      ));
  function reset() {
    setPreview(null);
    intent.current = null;
    setMessage('');
  }
  async function prepare() {
    if (
      busy ||
      !context?.source_run_id ||
      !context.settings ||
      !selected ||
      !supported
    )
      return;
    setBusy(true);
    setError('');
    reset();
    try {
      const value = await api<Preview>('/reprocess/preview', {
        source_run_id: context.source_run_id,
        settings: context.settings,
        semantic_profile_id: selected.profile_id,
        semantic_profile_revision: selected.revision,
        pass:
          mode === 'REPROCESS'
            ? null
            : { mode, candidate_run_id: context.candidate_run_id },
      });
      setPreview(value);
      intent.current = {
        preview_hash: value.preview_hash,
        nonce: crypto.randomUUID(),
      };
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (busy || !intent.current || !preview) return;
    setBusy(true);
    setError('');
    try {
      await api('/reprocess/confirm', intent.current);
      setPreview(null);
      intent.current = null;
      setMessage(
        'Zadanie zapisano w trwałej kolejce. Przyjęty wynik pozostaje wybrany; wybór nowego wyniku wymaga osobnej decyzji.',
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label="Ponowna analiza">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Ponowna analiza
      </button>
      {open && (
        <div>
          <p>
            Jawne dodatkowe zadanie. Oryginalne źródło pozostaje podstawą
            dowodów.
          </p>
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}
          {context && (
            <>
              <label>
                Profil i wersja
                <select
                  value={profile}
                  disabled={busy}
                  onChange={(e) => {
                    setProfile(e.target.value);
                    reset();
                  }}
                >
                  <option value="">Wybierz profil</option>
                  {context.profiles.map((p) => (
                    <option
                      key={`${p.profile_id}:${p.revision}`}
                      value={`${p.profile_id}:${p.revision}`}
                      disabled={p.optional_tasks}
                    >
                      {p.name} · wersja {p.revision}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Rodzaj zadania
                <select
                  value={mode}
                  disabled={busy}
                  onChange={(e) => {
                    setMode(e.target.value as typeof mode);
                    reset();
                  }}
                >
                  <option value="REPROCESS">
                    Ponownie zbadaj oryginalne źródło
                  </option>
                  <option
                    value="SECOND_PASS"
                    disabled={
                      !selected?.second_pass || !context.candidate_run_id
                    }
                  >
                    Dodatkowy cel Custom
                  </option>
                  <option
                    value="VALIDATE"
                    disabled={
                      !selected?.validation_pass || !context.candidate_run_id
                    }
                  >
                    Walidacja kandydata Custom
                  </option>
                </select>
              </label>
              {!context.available && (
                <p className="notice">
                  Źródło lub aktywny profil Gemini Free nie jest obecnie gotowy
                  do nowego zadania.
                </p>
              )}
              {context.has_more && (
                <p className="notice">Pokazano pierwsze 200 wersji profili.</p>
              )}
              <button
                type="button"
                disabled={busy || !context.available || !supported}
                onClick={() => void prepare()}
              >
                Przygotuj podgląd ponownej analizy
              </button>
            </>
          )}
          {preview && (
            <div>
              <p>
                Dodatkowe żądania modelu: {preview.additional_model_requests}.
                Szacowany input: {preview.token_estimate.input}. Bieżąca
                pozostała quota jest nieznana; executor sprawdzi ją przed
                żądaniem.
              </p>
              <p>Przyjęta analiza nie zostanie zastąpiona przez ten krok.</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void confirm()}
              >
                Potwierdź dodatkowe zadanie
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
