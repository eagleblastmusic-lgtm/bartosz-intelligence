import { useEffect, useRef, useState } from 'react';
import type { enrichEconomy } from '../../../../packages/core/src/ai/enrichment/canonical.js';
import type { EvidenceRead } from '../../../../packages/contracts/src/evidence-read.js';
import { api, errorMessage } from '../app/api.js';
import { SourceCorrectionEditor } from './source-correction-editor.js';
type Evidence = Awaited<
  ReturnType<typeof enrichEconomy>
>['canonical']['evidence'][number];
function sourceLink(value: string, timed: boolean) {
  const url = new URL(value);
  if (
    url.origin !== 'https://www.youtube.com' ||
    url.pathname !== '/watch' ||
    !/^[\w-]{11}$/.test(url.searchParams.get('v') ?? '') ||
    [...url.searchParams.keys()].some(
      (key) => key !== 'v' && (!timed || key !== 't'),
    ) ||
    (timed && !/^\d+s$/.test(url.searchParams.get('t') ?? ''))
  )
    throw new Error('INVALID_EVIDENCE_LINK');
  return url.href;
}
export function EvidenceChips({
  ids,
  evidence,
  runId,
}: {
  ids: string[];
  evidence: Evidence[];
  runId: string;
}) {
  const [selected, setSelected] = useState<Evidence | null>(null),
    trigger = useRef<HTMLButtonElement | null>(null);
  function close() {
    setSelected(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  return (
    <>
      <div
        className="evidence-chips"
        role="group"
        aria-label="Fragmenty źródła"
      >
        {ids.map((id, index) => (
          <button
            key={id}
            onClick={(event) => {
              trigger.current = event.currentTarget;
              setSelected(
                evidence.find((value) => value.evidence_id === id) ?? null,
              );
            }}
          >
            Źródło {index + 1}
          </button>
        ))}
      </div>
      {selected && (
        <EvidenceDrawer evidence={selected} runId={runId} close={close} />
      )}
    </>
  );
}
function EvidenceDrawer({
  evidence,
  runId,
  close,
}: {
  evidence: Evidence;
  runId: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [metadata, setMetadata] = useState<EvidenceRead | null>(null),
    [error, setError] = useState(''),
    [player, setPlayer] = useState(false);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    const controller = new AbortController();
    void (async () => {
      const value = await api<EvidenceRead>(
        '/evidence/' +
          encodeURIComponent(evidence.evidence_id) +
          '?' +
          new URLSearchParams({ run_id: runId }),
        undefined,
        undefined,
        controller.signal,
      );
      const quoteHash = [
        ...new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(evidence.quote_original),
          ),
        ),
      ]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('');
      if (
        value.evidence_id !== evidence.evidence_id ||
        value.run_id !== runId ||
        value.source_artifact_id !== evidence.source_artifact_id ||
        value.source_hash !== evidence.source_hash ||
        quoteHash !== value.quote_hash ||
        quoteHash !== evidence.quote_hash ||
        value.quote_pl !== null ||
        (value.quote_original !== null &&
          value.quote_original !== evidence.quote_original) ||
        (value.quote_original === null &&
          value.quote_transport !== 'PAGED_CANONICAL') ||
        value.source_end - value.source_start !==
          evidence.quote_original.length ||
        value.offset_unit !== 'UTF16_CODE_UNIT' ||
        JSON.stringify(value.segment_ids) !==
          JSON.stringify(evidence.segment_ids) ||
        value.start_ms !== evidence.start_ms ||
        value.end_ms !== evidence.end_ms ||
        value.timestamp_precision !== evidence.timestamp_precision ||
        value.timestamp_url !== evidence.timestamp_url ||
        evidence.quote_pl !== null ||
        value.helper_available !== false
      )
        throw new Error('EVIDENCE_PROOF_MISMATCH');
      sourceLink(value.source_url, false);
      if (value.timestamp_url) sourceLink(value.timestamp_url, true);
      if (!controller.signal.aborted) setMetadata(value);
    })().catch((error) => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    });
    return () => {
      controller.abort();
      node.close();
    };
  }, [evidence, runId]);
  const precision = {
    CUE: 'Czas całego segmentu',
    WORD: 'Precyzja słowa',
    ESTIMATED: 'Czas szacunkowy',
    NONE: 'Czas nieznany',
  };
  return (
    <dialog
      ref={dialog}
      className="evidence-drawer"
      aria-labelledby="evidence-title"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const nodes = [
          ...dialog.current!.querySelectorAll<HTMLElement>(
            'button:not([disabled]),a[href],summary,input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe,[tabindex="0"]',
          ),
        ].filter((node) => node.getClientRects().length > 0);
        const index = nodes.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0) {
          event.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!event.shiftKey && index === nodes.length - 1) {
          event.preventDefault();
          nodes[0]?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="drawer-heading">
        <div>
          <p className="eyebrow">Dowód wypowiedzi źródła</p>
          <h2 id="evidence-title">Fragment źródła</h2>
        </div>
        <button autoFocus onClick={close} aria-label="Zamknij fragment źródła">
          ×
        </button>
      </header>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : !metadata ? (
        <p role="status">Sprawdzanie cytatu i kotwicy…</p>
      ) : (
        <>
          <p className="metadata">Oryginalny cytat · dokładny zapis źródła</p>
          <blockquote className="original-quote">
            {evidence.quote_original}
          </blockquote>
          <SourceCorrectionEditor
            evidence={metadata}
            quote={evidence.quote_original}
          />
          <p className="muted">
            Polski helper nie jest dostępny. Oryginał pozostaje podstawą dowodu.
          </p>
          <p>
            {precision[metadata.timestamp_precision]}
            {metadata.start_ms !== null
              ? ` · ${(metadata.start_ms / 1000).toFixed(3)}–${(metadata.end_ms! / 1000).toFixed(3)} s`
              : ''}
          </p>
          <p>
            {metadata.timestamp_url ? (
              <a href={metadata.timestamp_url} target="_blank" rel="noreferrer">
                Otwórz fragment w źródle
              </a>
            ) : (
              <a href={metadata.source_url} target="_blank" rel="noreferrer">
                {metadata.timestamp_precision === 'NONE'
                  ? 'Otwórz film — czas nieznany'
                  : 'Otwórz film — brak linku czasowego'}
              </a>
            )}
          </p>
          <button onClick={() => setPlayer(true)} disabled={player}>
            Wczytaj odtwarzacz
          </button>
          {player && (
            <iframe
              className="source-player"
              title="Odtwarzacz materiału źródłowego"
              src={
                'https://www.youtube-nocookie.com/embed/' +
                new URL(metadata.source_url).searchParams.get('v') +
                (metadata.start_ms === null
                  ? ''
                  : '?start=' + Math.floor(metadata.start_ms / 1000))
              }
              referrerPolicy="no-referrer"
              allowFullScreen
            />
          )}
          <details>
            <summary>Pochodzenie i integralność</summary>
            <p>Źródło: {metadata.source_artifact_id}</p>
            <p>SHA-256 źródła: {metadata.source_hash}</p>
            <p>SHA-256 cytatu: {metadata.quote_hash}</p>
            <p>
              Kotwica UTF-16: {metadata.source_start}–{metadata.source_end}
            </p>
            {Object.entries(metadata.provenance).map(([key, value]) => (
              <p key={key}>
                {key}: {String(value)}
              </p>
            ))}
          </details>
        </>
      )}
    </dialog>
  );
}
