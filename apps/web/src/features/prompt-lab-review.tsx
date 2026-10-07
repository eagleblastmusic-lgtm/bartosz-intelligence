import { useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import {
  labCriticalErrors,
  type LabHumanReview,
  type LabReviews,
} from '../../../../packages/core/src/registry/lab-reviews.js';
type Inspection = Awaited<ReturnType<LabReviews['inspect']>>;
type History = Awaited<ReturnType<LabReviews['history']>>;
export function PromptLabReview({
  experimentHash,
  runId,
}: {
  experimentHash: string;
  runId: string;
}) {
  const [inspection, setInspection] = useState<Inspection | null>(null),
    [history, setHistory] = useState<History | null>(null),
    [section, setSection] = useState<'CANONICAL' | 'SOURCE'>('CANONICAL'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [reviewer, setReviewer] = useState(''),
    [role, setRole] = useState<'PRIMARY' | 'INDEPENDENT'>('PRIMARY'),
    [label, setLabel] = useState(''),
    [scores, setScores] = useState(['', '', '', '']),
    [supported, setSupported] = useState(''),
    [complete, setComplete] = useState(''),
    [evidence, setEvidence] = useState(''),
    [checked, setChecked] = useState(false),
    [critical, setCritical] = useState<LabHumanReview['critical_errors']>([]),
    [notes, setNotes] = useState(''),
    [confirm, setConfirm] = useState(false);
  const path =
    '/prompts/lab/experiments/' +
    experimentHash +
    '/runs/' +
    encodeURIComponent(runId);
  async function load(nextSection = section, offset = 0) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const [result, reviews] = await Promise.all([
        api<Inspection>(
          path + '/inspect?section=' + nextSection + '&offset=' + offset,
        ),
        api<History>(path + '/reviews'),
      ]);
      setInspection(result);
      setHistory(reviews);
      setSection(nextSection);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const bool = (value: string) => (value === '' ? null : value === 'true');
  const revision = Math.max(
    0,
    ...(history?.reviews
      .filter((row) => row.review.reviewer_id === reviewer)
      .map((row) => row.revision) ?? []),
  );
  async function save() {
    if (busy || !confirm) return;
    setBusy(true);
    setError('');
    const review: LabHumanReview = {
      reviewer_id: reviewer,
      role,
      blind_label: label,
      scores: scores.map((value) =>
        value === '' ? null : Number(value),
      ) as LabHumanReview['scores'],
      supported: bool(supported),
      important_claims_complete: bool(complete),
      evidence_valid: bool(evidence),
      critical_errors: checked ? critical : null,
      notes,
    };
    try {
      const result = await api<{ revision: number }>(path + '/reviews', {
        review,
        expected_revision: revision,
      });
      setHistory(await api<History>(path + '/reviews'));
      setConfirm(false);
      setMessage(
        'Zapisano rewizję oceny ' +
          result.revision +
          '. Kwalifikacja jakości nie została nadana.',
      );
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
        if (e.currentTarget.open && !inspection) void load();
      }}
    >
      <summary>Wynik, źródło i oceny · {runId}</summary>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <p>
        To jawny podgląd diagnostyczny. Ślepą ocenę dwóch próbek wykonaj na
        przygotowanych materiałach, a tutaj zapisz ukończone oceny ludzi. Nie
        zastępuj ich oceną AI.
      </p>
      <button disabled={busy} onClick={() => void load('CANONICAL')}>
        Pokaż wynik kandydata
      </button>
      <button disabled={busy} onClick={() => void load('SOURCE')}>
        Pokaż przypięte źródło
      </button>
      {inspection && (
        <>
          <p>
            {inspection.section === 'SOURCE' ? 'Źródło' : 'Wynik'} · Znaki{' '}
            {inspection.offset}–{inspection.end} z {inspection.total_code_units}{' '}
            · {inspection.reason_code}
          </p>
          <p className="metadata">
            Hash kandydata: {inspection.candidate_hash} · Hash widoku:{' '}
            {inspection.content_hash ?? 'Brak zwalidowanego wyniku'}
          </p>
          <pre className="lab-inspection-text" tabIndex={0}>
            {inspection.text || 'Brak zwalidowanego wyniku canonical.'}
          </pre>
          {inspection.offset > 0 && (
            <button
              disabled={busy}
              onClick={() =>
                void load(section, Math.max(0, inspection.offset - 16384))
              }
            >
              Poprzedni fragment
            </button>
          )}
          {inspection.next_offset !== null && (
            <button
              disabled={busy}
              onClick={() => void load(section, inspection.next_offset!)}
            >
              Następny fragment
            </button>
          )}
        </>
      )}
      <h4>Zapis ręcznej oceny</h4>
      <p>
        Niewykonane oceny pozostaw puste. Korekta tworzy nową rewizję;
        wcześniejsze etykiety i rozbieżności pozostają w historii.
      </p>
      <fieldset disabled={busy || confirm}>
        <legend>Osoba i zakres oceny</legend>
        <label>
          Identyfikator oceniającego
          <input
            maxLength={80}
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
          />
        </label>
        <label>
          Rola oceniającego
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            <option value="PRIMARY">Główny annotator</option>
            <option value="INDEPENDENT">Niezależny reviewer</option>
          </select>
        </label>
        <label>
          Etykieta próbki ze ślepej oceny
          <input
            maxLength={80}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        {(
          [
            ['Twierdzenia poparte źródłem', supported, setSupported],
            ['Ważne twierdzenia uwzględnione', complete, setComplete],
            ['Evidence i anchory poprawne', evidence, setEvidence],
          ] as const
        ).map(([name, value, set]) => (
          <label key={name}>
            {name}
            <select value={value} onChange={(e) => set(e.target.value)}>
              <option value="">Nie oceniono</option>
              <option value="true">Tak</option>
              <option value="false">Nie</option>
            </select>
          </label>
        ))}
        <p>
          Dla tłumaczeń: 0–4, kolejno wierność (40%), liczby/negacje/warunki
          (25%), kompletność (20%), naturalność (15%). Pozostaw puste dla
          niewykonanej oceny lub innego zadania.
        </p>
        {[
          'Wierność tłumaczenia',
          'Liczby, negacje i warunki',
          'Kompletność tłumaczenia',
          'Naturalność polszczyzny',
        ].map((name, index) => (
          <label key={name}>
            {name}
            <select
              value={scores[index]}
              onChange={(e) =>
                setScores((values) =>
                  values.map((value, i) =>
                    i === index ? e.target.value : value,
                  ),
                )
              }
            >
              <option value="">Nie oceniono</option>
              {[0, 1, 2, 3, 4].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          Sprawdzono błędy krytyczne
        </label>
        {checked &&
          labCriticalErrors.map((code) => (
            <label key={code}>
              <input
                type="checkbox"
                checked={critical?.includes(code) ?? false}
                onChange={(e) =>
                  setCritical((values) =>
                    e.target.checked
                      ? [...(values ?? []), code]
                      : (values ?? []).filter((value) => value !== code),
                  )
                }
              />
              {
                {
                  NEGATION_CHANGED: 'Zmiana negacji',
                  NUMBER_CHANGED: 'Zmiana liczby',
                  FABRICATED_FACT: 'Zmyślony fakt',
                  ASR_GUESSED: 'Zgadywanie niejasnego ASR',
                  MISSING_SEGMENT: 'Brak segmentu',
                  FABRICATED_TIMESTAMP: 'Zmyślony timestamp',
                  SEVERE_HALLUCINATION: 'Poważna halucynacja',
                  UNSUPPORTED_CLAIM: 'Niepoparte twierdzenie',
                  INVALID_EVIDENCE: 'Niepoprawne Evidence',
                }[code]
              }
            </label>
          ))}
        <label>
          Uwagi oceniającego
          <textarea
            rows={4}
            maxLength={8000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      </fieldset>
      {!confirm ? (
        <button
          disabled={
            busy ||
            !history ||
            !/^[A-Za-z0-9_-]{1,80}$/.test(reviewer) ||
            !label.trim() ||
            ['A', 'B'].includes(label)
          }
          onClick={() => setConfirm(true)}
        >
          Przejrzyj zapis oceny
        </button>
      ) : (
        <div>
          <p>
            Zapiszesz ocenę osoby {reviewer}, jako rewizję {revision + 1}, dla
            kandydata {inspection?.candidate_hash}. Niewypełnione pola pozostaną
            nieocenione. Ten zapis nie publikuje promptu ani approval.
          </p>
          <button disabled={busy} onClick={() => void save()}>
            Potwierdź zapis ręcznej oceny
          </button>
          <button disabled={busy} onClick={() => setConfirm(false)}>
            Wróć do formularza oceny
          </button>
        </div>
      )}
      {history && (
        <>
          <h4>Historia ocen</h4>
          <ul>
            {history.reviews.map((row) => (
              <li key={row.hash}>
                <p>
                  {row.review.reviewer_id} ·{' '}
                  {row.review.role === 'PRIMARY'
                    ? 'Główny annotator'
                    : 'Niezależny reviewer'}{' '}
                  · Rewizja {row.revision}
                </p>
                <p>
                  Oceny tłumaczenia:{' '}
                  {row.review.scores
                    .map((value) => value ?? 'Nie oceniono')
                    .join(' / ')}{' '}
                  · Błędy krytyczne:{' '}
                  {row.review.critical_errors === null
                    ? 'Nie oceniono'
                    : row.review.critical_errors.join(', ') ||
                      'Nie stwierdzono'}
                </p>
                <p>{row.review.notes}</p>
              </li>
            ))}
          </ul>
          {!history.reviews.length && (
            <p>Brak ocen ludzi. Kwalifikacja jakości pozostaje otwarta.</p>
          )}
          {history.truncated && (
            <p>
              Pokazano 50 rewizji; wcześniejsze oceny pozostają w rejestrze.
            </p>
          )}
        </>
      )}
    </details>
  );
}
