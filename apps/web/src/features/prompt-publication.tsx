import { useEffect, useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import type { PromptDrafts } from '../../../../packages/core/src/registry/draft.js';
import type { PromptTests } from '../../../../packages/core/src/registry/test.js';
import type { PromptPublications } from '../../../../packages/core/src/registry/publish.js';

type Version = Awaited<ReturnType<PromptDrafts['version']>>;
type Reports = Awaited<ReturnType<PromptTests['reports']>>;
type Preview = Awaited<ReturnType<PromptPublications['preview']>>;
export function PromptPublication({
  prompt,
  onChanged,
}: {
  prompt: Version;
  onChanged: () => void;
}) {
  const [reports, setReports] = useState<Reports>([]),
    [run, setRun] = useState(''),
    [modelRevision, setModelRevision] = useState(''),
    [reportHash, setReportHash] = useState(''),
    [reason, setReason] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null),
    [nonce, setNonce] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api<Reports>(
      '/prompts/' +
        encodeURIComponent(prompt.prompt_id) +
        '/' +
        prompt.version +
        '/tests',
      undefined,
      undefined,
      controller.signal,
    )
      .then((rows) => {
        setReports(rows);
        setReportHash(rows[0]?.report_hash ?? '');
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [prompt.prompt_id, prompt.version]);
  async function record() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/prompts/tests', {
        prompt_id: prompt.prompt_id,
        version: prompt.version,
        run_id: run,
        model_revision: Number(modelRevision),
      });
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function inspect(action: 'PUBLISH' | 'ROLLBACK') {
    if (busy) return;
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const row = await api<Preview>('/prompts/publication/preview', {
        action,
        prompt_id: prompt.prompt_id,
        version: prompt.version,
        report_hash: action === 'PUBLISH' ? reportHash : null,
        reason,
      });
      setNonce(crypto.randomUUID());
      setPreview(row);
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
      await api('/prompts/publication/confirm', {
        preview_hash: preview.preview_hash,
        nonce,
      });
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const report = reports.find((row) => row.report_hash === reportHash)?.report;
  return (
    <details>
      <summary>Testy i publikacja wersji {prompt.version}</summary>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <p className="muted">
        Raport wymaga zakończonej próby QUALITY_TEST, rzeczywistego użycia
        tokenów i istniejącej kwalifikacji jakości dla dokładnego promptu. Ten
        formularz nie uruchamia AI.
      </p>
      <label>
        Identyfikator zakończonej próby jakości
        <input
          value={run}
          disabled={busy}
          maxLength={128}
          onChange={(e) => setRun(e.target.value)}
        />
      </label>
      <label>
        Rewizja profilu modelu z kwalifikacją jakości
        <input
          type="number"
          min={1}
          step={1}
          value={modelRevision}
          disabled={busy}
          onChange={(e) => setModelRevision(e.target.value)}
        />
      </label>
      <button
        disabled={
          busy ||
          !run.trim() ||
          !Number.isSafeInteger(Number(modelRevision)) ||
          Number(modelRevision) < 1
        }
        onClick={() => void record()}
      >
        Zweryfikuj raport testu
      </button>
      <label>
        Zweryfikowany raport
        <select
          value={reportHash}
          disabled={busy}
          onChange={(e) => {
            setReportHash(e.target.value);
            setPreview(null);
          }}
        >
          <option value="">Wybierz raport</option>
          {reports.map((row) => (
            <option key={row.report_hash} value={row.report_hash}>
              {row.report.run_id} · {row.report.created_at}
            </option>
          ))}
        </select>
      </label>
      {report && (
        <p className="metadata">
          Zakres jakości: {report.quality_scope} · Zużycie:{' '}
          {report.usage.total_tokens} tokenów
        </p>
      )}
      <label>
        Powód publikacji lub rollbacku
        <textarea
          rows={2}
          maxLength={1000}
          value={reason}
          disabled={busy}
          onChange={(e) => {
            setReason(e.target.value);
            setPreview(null);
          }}
        />
      </label>
      <div className="actions">
        <button
          disabled={
            busy ||
            prompt.status !== 'TESTED' ||
            Boolean(prompt.usage_restriction) ||
            !reportHash ||
            !reason.trim()
          }
          onClick={() => void inspect('PUBLISH')}
        >
          Przygotuj publikację
        </button>
        <button
          disabled={
            busy ||
            prompt.status !== 'PUBLISHED' ||
            Boolean(prompt.usage_restriction) ||
            !reason.trim()
          }
          onClick={() => void inspect('ROLLBACK')}
        >
          Przygotuj rollback do tej wersji
        </button>
      </div>
      {preview && (
        <div className="notice" role="status">
          <p>
            {preview.action === 'PUBLISH' ? 'Publikacja' : 'Rollback'}: wersja{' '}
            {preview.target_version}, oczekiwana generacja{' '}
            {preview.expected_generation}.
          </p>
          <p>
            Nowe zadania użyją tej wersji. Rozpoczęte zadania zachowają zapisany
            prompt. Ponowne przetwarzanie: {preview.reprocess_jobs}. Nowe
            wywołania AI: {preview.new_model_requests}.
          </p>
          <button disabled={busy} onClick={() => void confirm()}>
            Potwierdź {preview.action === 'PUBLISH' ? 'publikację' : 'rollback'}
          </button>
          <button disabled={busy} onClick={() => setPreview(null)}>
            Anuluj
          </button>
        </div>
      )}
    </details>
  );
}
