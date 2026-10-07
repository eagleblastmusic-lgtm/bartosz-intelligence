import { useEffect, useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import { AppLink } from '../app/router.js';
import type { PromptDrafts } from '../../../../packages/core/src/registry/draft.js';
import { PromptPublication } from './prompt-publication.js';
import { PromptTestRun } from './prompt-test-run.js';
type Families = Awaited<ReturnType<PromptDrafts['families']>>;
type Version = Awaited<ReturnType<PromptDrafts['version']>>;
const names: Record<string, string> = {
  ECONOMY_ANALYSIS_V1: 'Analiza Economy',
  FULL_ANALYSIS_V1: 'Analiza Full',
  ADVANCED_ANALYSIS_V1: 'Analiza Custom',
  HISTORICAL_COMPARE_V1: 'Historia wypowiedzi',
  FULL_TRANSLATION_V1: 'Tłumaczenie źródła',
  JSON_REPAIR_V1: 'Naprawa odpowiedzi',
};
const states = {
  DRAFT: 'Draft',
  TESTED: 'Przetestowana',
  PUBLISHED: 'Opublikowana',
};
export function Prompts() {
  const [families, setFamilies] = useState<Families>([]),
    [family, setFamily] = useState('ECONOMY_ANALYSIS_V1'),
    [version, setVersion] = useState(2),
    [base, setBase] = useState<Version | null>(null),
    [text, setText] = useState(''),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<Families>('/prompts', undefined, undefined, controller.signal)
      .then(setFamilies)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    const controller = new AbortController();
    setBase(null);
    setError('');
    setReason('');
    setBusy(true);
    api<Version>(
      '/prompts/' + encodeURIComponent(family) + '/' + version,
      undefined,
      undefined,
      controller.signal,
    )
      .then((row) => {
        if (!controller.signal.aborted) {
          setBase(row);
          setText(row.prompt_text);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [family, version, revision]);
  const selected = families.find((f) => f.prompt_id === family);
  const latest = selected?.versions[0]?.version;
  async function save() {
    if (busy || !base || latest === undefined) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const row = await api<Version>('/prompts/drafts', {
        prompt_id: family,
        base_version: base.version,
        expected_latest_version: latest,
        text,
        reason,
      });
      setBase(row);
      setText(row.prompt_text);
      setVersion(row.version);
      setReason('');
      setRevision((n) => n + 1);
      setMessage(
        'Zapisano nową wersję ' +
          row.version +
          ' jako draft. Opublikowany prompt pozostaje aktywny.',
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Prompt Studio</h1>
          <p className="muted">Treść promptów, wersje i zgodność wejść.</p>
        </div>
        <AppLink href="/system">System</AppLink>
      </div>
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
      <section
        className="panel"
        aria-label="Wersje promptów"
        style={{ overflowWrap: 'anywhere', minWidth: 0 }}
      >
        <label>
          Rodzina promptu
          <select
            value={family}
            disabled={busy}
            onChange={(e) => {
              const id = e.target.value;
              setFamily(id);
              setVersion(
                families.find((f) => f.prompt_id === id)?.versions[0]
                  ?.version ?? 2,
              );
            }}
          >
            {Object.entries(names).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Wersja bazowa
          <select
            value={version}
            disabled={busy}
            onChange={(e) => setVersion(Number(e.target.value))}
          >
            {selected?.versions.map((v) => (
              <option key={v.version} value={v.version}>
                {v.version} · {states[v.status]}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <p className="metadata">
            Wire: {selected.wire_schema_id} · Canonical:{' '}
            {selected.canonical_schema_id}
          </p>
        )}
        {!base && !error && <p role="status">Pobieranie wersji…</p>}
        {base && (
          <>
            <p>
              Stan wersji {base.version}: {states[base.status]}.
            </p>
            <p className="metadata">Hash: {base.prompt_hash}</p>
            <PromptTestRun
              key={'test:' + family + ':' + version}
              prompt={base}
            />
            <PromptPublication
              key={family + ':' + version + ':' + revision}
              prompt={base}
              onChanged={() => setRevision((n) => n + 1)}
            />
            <label>
              Treść nowego draftu
              <textarea
                value={text}
                disabled={busy}
                rows={20}
                maxLength={120000}
                onChange={(e) => {
                  setText(e.target.value);
                  setMessage('');
                }}
              />
            </label>
            <p className="muted">
              Wymagane wejścia: {base.required_inputs.join(', ')}. Zachowaj ich
              nazwy w podwójnych nawiasach klamrowych.
            </p>
            <details>
              <summary>Porównaj z wersją bazową {base.version}</summary>
              <h2>Wersja bazowa</h2>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {base.prompt_text}
              </pre>
              <h2>Nowy draft</h2>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {text}
              </pre>
            </details>
            <label>
              Powód zmiany
              <textarea
                rows={2}
                value={reason}
                maxLength={1000}
                disabled={busy}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button
              disabled={
                busy ||
                !reason.trim() ||
                !text.trim() ||
                text === base.prompt_text ||
                latest === undefined
              }
              onClick={() => void save()}
            >
              Zapisz nową wersję draftu
            </button>
            <p className="notice">
              Zapis nie uruchamia AI ani ponownego przetwarzania. Publikacja
              wymaga testów zgodności i jakości dla tego promptu.
            </p>
          </>
        )}
      </section>
    </>
  );
}
