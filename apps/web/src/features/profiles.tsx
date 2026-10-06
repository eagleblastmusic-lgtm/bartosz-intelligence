import { useEffect, useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import { AppLink } from '../app/router.js';
import {
  semanticModules,
  type SemanticModule,
  type SemanticProfile,
} from '../../../../packages/core/src/ai/semantic-profile.js';
import type {
  MaterializedSemanticProfile,
  SemanticProfileSnapshot,
} from '../../../../packages/core/src/registry/semantic-profiles.js';
const labels: Record<SemanticModule, string> = {
  summary: 'Podsumowanie',
  key_points: 'Kluczowe punkty',
  entities: 'Encje',
  tools: 'Narzędzia',
  claims: 'Twierdzenia',
  stance: 'Stanowisko',
  predictions: 'Przewidywania',
  usage: 'Użycie',
  recommendations: 'Rekomendacje',
  uncertainties: 'Niepewności',
  contradictions: 'Możliwe sprzeczności',
};
const groups: { name: string; modules: SemanticModule[] }[] = [
  { name: 'Zrozumienie', modules: ['summary', 'key_points'] },
  {
    name: 'Wypowiedzi',
    modules: [
      'claims',
      'stance',
      'predictions',
      'usage',
      'recommendations',
      'uncertainties',
    ],
  },
  { name: 'Powiązania', modules: ['entities', 'tools', 'contradictions'] },
];
const initial: SemanticProfile = {
  mode: 'ECONOMY',
  modules: Object.fromEntries(
    semanticModules.map((key, i) => [key, i < 7]),
  ) as SemanticProfile['modules'],
  translation: 'NONE',
  history: false,
  second_pass: null,
  validation_pass: null,
};
interface Row {
  profile_id: string;
  revision: number;
  name: string;
  config_json: string;
  created_at: string;
}
export function Profiles() {
  const sourceId = new URLSearchParams(location.search).get('source_id');
  const [config, setConfig] = useState(initial),
    [name, setName] = useState('Mój profil'),
    [reason, setReason] = useState(''),
    [rows, setRows] = useState<Row[]>([]),
    [hasMore, setHasMore] = useState(false),
    [selected, setSelected] = useState<{ id: string; revision: number } | null>(
      null,
    ),
    [preview, setPreview] = useState<MaterializedSemanticProfile | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(''),
    [assignment, setAssignment] = useState<{
      generation: number;
      profile_id?: string;
      revision?: number;
    } | null>(null),
    [applyPending, setApplyPending] = useState(false),
    [assignmentReason, setAssignmentReason] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    api<{ profiles: Row[]; has_more: boolean }>(
      '/profiles',
      undefined,
      undefined,
      abort.signal,
    )
      .then((result) => {
        if (!abort.signal.aborted) {
          setRows(result.profiles);
          setHasMore(result.has_more);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(errorMessage(error));
      });
    return () => abort.abort();
  }, []);
  function update(next: SemanticProfile) {
    setConfig(next);
    setPreview(null);
    setSaved('');
  }
  async function materialize() {
    setBusy(true);
    setError('');
    try {
      setPreview(
        await api<MaterializedSemanticProfile>('/profiles/preview', { config }),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!preview) return;
    setBusy(true);
    setError('');
    const profile_id = selected?.id ?? crypto.randomUUID(),
      revision = (selected?.revision ?? 0) + 1;
    // Keep identity on transport failure so retry cannot silently create a second profile.
    setSelected({ id: profile_id, revision: revision - 1 });
    try {
      const result = await api<SemanticProfileSnapshot>('/profiles/versions', {
        profile_id,
        revision,
        name,
        config,
        reason,
      });
      setSelected({ id: profile_id, revision });
      setRows((current) => [
        {
          profile_id,
          revision,
          name: result.name,
          config_json: JSON.stringify(result.compiled.config),
          created_at: new Date().toISOString(),
        },
        ...current.filter(
          (row) => row.profile_id !== profile_id || row.revision !== revision,
        ),
      ]);
      setSaved(`Zapisano wersję ${revision}.`);
      setPreview(null);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function inspectAssignment() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{
        assignments: {
          generation: number;
          source_id: string | null;
          profile_id: string;
          revision: number;
        }[];
        has_more: boolean;
      }>('/profiles/assignments');
      const current = result.assignments.find(
        (row) => row.source_id === sourceId,
      );
      if (!current && result.has_more)
        throw new Error('ASSIGNMENT_LIST_INCOMPLETE');
      setAssignment(current ?? { generation: 0 });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function activate() {
    if (!assignment || !selected) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ generation: number }>(
        '/profiles/assignments',
        {
          profile_id: selected.id,
          revision: selected.revision,
          source_id: sourceId,
          effective_from: new Date().toISOString(),
          apply_to_pending: applyPending,
          reason: assignmentReason,
          expected_generation: assignment.generation,
        },
      );
      setAssignment({
        generation: result.generation,
        profile_id: selected.id,
        revision: selected.revision,
      });
      setSaved(`Przypisano wersję ${selected.revision}.`);
    } catch (error) {
      setAssignment(null);
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const stored = rows.find(
    (row) =>
      row.profile_id === selected?.id && row.revision === selected?.revision,
  );
  const storedConfig = stored
    ? (JSON.parse(stored.config_json) as SemanticProfile)
    : null;
  const canAssign =
    storedConfig?.mode === 'ECONOMY' &&
    storedConfig.translation === 'NONE' &&
    !storedConfig.history &&
    !storedConfig.second_pass &&
    !storedConfig.validation_pass;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Profile analizy</h1>
          <p className="muted">
            Wybierz, co ma zawierać analiza każdego materiału.
          </p>
        </div>
        <AppLink href="/system">System</AppLink>
      </div>
      <p className="notice">
        Pipeline: Gemini Free. Usługi płatne wyłączone. Zapis wersji nie
        uruchamia analizy ani nie zmienia istniejących zadań.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="notice" role="status">
          {saved}
        </p>
      )}
      <section className="panel">
        <h2>Wersje profili</h2>
        {!rows.length && <p className="muted">Brak zapisanych wersji.</p>}
        {hasMore && (
          <p className="notice">
            Pokazano pierwszych 200 wersji. Lista jest niepełna.
          </p>
        )}
        <div className="row-actions">
          {rows.map((row) => (
            <button
              key={row.profile_id + ':' + row.revision}
              disabled={busy}
              onClick={() => {
                setSelected({ id: row.profile_id, revision: row.revision });
                setName(row.name);
                setReason('');
                update(JSON.parse(row.config_json) as SemanticProfile);
              }}
            >
              {row.name} · v{row.revision}
            </button>
          ))}
          <button
            disabled={busy}
            onClick={() => {
              setSelected(null);
              setName('Mój profil');
              setReason('');
              update(initial);
            }}
          >
            Nowy profil
          </button>
        </div>
      </section>
      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          void materialize();
        }}
      >
        <h2>Zakres semantyczny</h2>
        <fieldset disabled={busy}>
          <legend>Profil</legend>
          <label>
            Nazwa
            <input
              value={name}
              maxLength={120}
              required
              onChange={(e) => {
                setName(e.target.value);
                setSaved('');
              }}
            />
          </label>
          <label>
            Tryb
            <select
              aria-label="Tryb"
              value={config.mode}
              onChange={(e) => {
                const mode = e.target.value as SemanticProfile['mode'];
                update({
                  ...config,
                  mode,
                  modules:
                    mode === 'CUSTOM'
                      ? config.modules
                      : (Object.fromEntries(
                          semanticModules.map((key, i) => [
                            key,
                            mode === 'FULL' || i < 7,
                          ]),
                        ) as SemanticProfile['modules']),
                });
              }}
            >
              <option value="ECONOMY">Economy</option>
              <option value="FULL">Full</option>
              <option value="CUSTOM">Custom</option>
            </select>
          </label>
        </fieldset>
        {groups.map((group) => (
          <fieldset key={group.name} disabled={busy}>
            <legend>{group.name}</legend>
            {group.modules.map((key) => (
              <label key={key}>
                <input
                  type="checkbox"
                  disabled={config.mode !== 'CUSTOM'}
                  checked={config.modules[key]}
                  onChange={(e) =>
                    update({
                      ...config,
                      modules: { ...config.modules, [key]: e.target.checked },
                    })
                  }
                />
                {labels[key]}
              </label>
            ))}
            {group.name === 'Powiązania' && (
              <label>
                <input
                  type="checkbox"
                  checked={config.history}
                  onChange={(e) =>
                    update({ ...config, history: e.target.checked })
                  }
                />
                Porównanie historyczne · osobne wywołanie
              </label>
            )}
          </fieldset>
        ))}
        <fieldset disabled={busy}>
          <legend>Reprezentacje</legend>
          <label>
            Tłumaczenie
            <select
              aria-label="Tłumaczenie"
              value={config.translation}
              onChange={(e) =>
                update({
                  ...config,
                  translation: e.target.value as SemanticProfile['translation'],
                })
              }
            >
              <option value="NONE">Bez tłumaczenia</option>
              <option value="FULL">Całe źródło</option>
              <option value="IMPORTANT_SEGMENTS">Ważne fragmenty</option>
            </select>
          </label>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Dodatkowa kontrola</legend>
          {(['second_pass', 'validation_pass'] as const).map((key) => (
            <div key={key}>
              <label>
                <input
                  type="checkbox"
                  checked={config[key] !== null}
                  onChange={(e) =>
                    update({
                      ...config,
                      [key]: e.target.checked ? { purpose: '' } : null,
                    })
                  }
                />
                {key === 'second_pass'
                  ? 'Drugi przebieg źródła'
                  : 'Walidacja istniejącego kandydata'}{' '}
                · osobne wywołanie
              </label>
              {config[key] && (
                <label>
                  Cel{' '}
                  {key === 'second_pass' ? 'drugiego przebiegu' : 'walidacji'}
                  <input
                    required
                    maxLength={500}
                    value={config[key].purpose}
                    onChange={(e) =>
                      update({ ...config, [key]: { purpose: e.target.value } })
                    }
                  />
                </label>
              )}
            </div>
          ))}
        </fieldset>
        <p className="metadata">
          Dowody i problemy źródła są obowiązkowe. Wzmianki encji pozostają
          dostępne dla odwołań rekordów.
        </p>
        <button
          disabled={busy || !Object.values(config.modules).some(Boolean)}
          type="submit"
        >
          Sprawdź zakres
        </button>
        {preview && (
          <section aria-label="Podgląd zakresu">
            <h3>Podgląd</h3>
            <p>
              Minimum {preview.request_estimate.minimum} wywołań. Dzielenie
              źródła, naprawa i quota mogą zwiększyć liczbę lub odroczyć
              wykonanie. Bieżąca dostępna quota: nieodczytana.
            </p>
            <details>
              <summary>Dokładny schemat i wersje</summary>
              <p className="metadata">
                Prompt: {preview.prompt.id} v{preview.prompt.version}
                <br />
                Hash schematu: {preview.wire.hash}
              </p>
              <pre style={{ overflowX: 'auto', maxWidth: '100%' }}>
                {JSON.stringify(preview.wire.schema, null, 2)}
              </pre>
            </details>
            <label>
              Powód nowej wersji
              <textarea
                value={reason}
                required
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !name.trim() || !reason.trim()}
              onClick={() => void save()}
            >
              Zapisz wersję
            </button>
          </section>
        )}
      </form>
      <section className="panel">
        <h2>Przypisanie profilu</h2>
        <p>
          {sourceId
            ? 'Wybrany kanał'
            : 'Domyślnie dla kanałów bez własnego przypisania'}
          . Wybierz zapisaną wersję powyżej.
        </p>
        {stored && (
          <p>
            Wybrano: {stored.name} · v{stored.revision}
          </p>
        )}
        {stored && !canAssign && (
          <p className="notice">
            Ten zakres jest zapisany do przygotowania. Aktywny wykonawca
            obsługuje Economy bez dodatkowych przebiegów.
          </p>
        )}
        <button
          disabled={busy || !canAssign}
          onClick={() => void inspectAssignment()}
        >
          Sprawdź przypisanie
        </button>
        {assignment && (
          <>
            <p className="metadata">
              Aktualne przypisanie:{' '}
              {assignment.profile_id ? `wersja ${assignment.revision}` : 'brak'}
              .
            </p>
            <label>
              <input
                type="checkbox"
                disabled={busy}
                checked={applyPending}
                onChange={(e) => setApplyPending(e.target.checked)}
              />
              Zastosuj także do oczekujących materiałów bez przypiętej analizy
            </label>
            <p className="metadata">
              Zlecone analizy zachowują swój zakres. Zakończone wymagają jawnego
              ponownego przetwarzania. Nowe przypisanie obowiązuje od
              potwierdzenia.
            </p>
            <label>
              Powód przypisania
              <textarea
                disabled={busy}
                value={assignmentReason}
                maxLength={1000}
                onChange={(e) => setAssignmentReason(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !canAssign || !assignmentReason.trim()}
              onClick={() => void activate()}
            >
              Potwierdź przypisanie
            </button>
          </>
        )}
      </section>
    </>
  );
}
