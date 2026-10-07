import { useState } from 'react';
import { api, errorMessage } from '../app/api.js';
import type { LabQuotaPolicies } from '../../../../packages/core/src/registry/lab-quota.js';
type Current = Awaited<ReturnType<LabQuotaPolicies['current']>>;
export function PromptLabQuota() {
  const [current, setCurrent] = useState<Current>(null),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [account, setAccount] = useState(''),
    [model, setModel] = useState(''),
    [daily, setDaily] = useState('0'),
    [rpm, setRpm] = useState('1'),
    [rpd, setRpd] = useState('1'),
    [tpm, setTpm] = useState('1'),
    [reason, setReason] = useState(''),
    [review, setReview] = useState(false);
  async function load() {
    if (loaded || busy) return;
    setBusy(true);
    setError('');
    try {
      const value = await api<Current>('/prompts/lab/quota');
      setCurrent(value);
      if (value) {
        setAccount(value.policy.account_key);
        setModel(value.policy.model);
        setDaily(String(value.policy.daily_requests));
        setRpm(String(value.policy.normal_headroom.RPM));
        setRpd(String(value.policy.normal_headroom.RPD));
        setTpm(String(value.policy.normal_headroom.INPUT_TPM));
      }
      setLoaded(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const valid =
    account.trim() &&
    model.trim() &&
    reason.trim() &&
    [daily, rpm, rpd, tpm].every(
      (value, index) =>
        Number.isSafeInteger(Number(value)) &&
        Number(value) >= (index === 0 ? 0 : 1),
    );
  async function save() {
    if (!review || !valid || busy) return;
    setBusy(true);
    setError('');
    try {
      setCurrent(
        await api<Current>('/prompts/lab/quota', {
          account_key: account.trim(),
          model: model.trim(),
          daily_requests: Number(daily),
          normal_headroom: {
            RPM: Number(rpm),
            RPD: Number(rpd),
            INPUT_TPM: Number(tpm),
          },
          expected_revision: current?.revision ?? 0,
          reason,
        }),
      );
      setReview(false);
      setReason('');
      setMessage(
        'Zapisano budżet Lab. Aktualna quota i kwalifikacja Free są nadal wymagane.',
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
        if (e.currentTarget.open) void load();
      }}
    >
      <summary>Budżet Prompt Lab</summary>
      {error && <p role="alert">{error}</p>}
      {error && !loaded && (
        <button disabled={busy} onClick={() => void load()}>
          Ponów odczyt budżetu
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {loaded && (
        <>
          <p>
            Limit prób Lab nie zwiększa quota Google. Zapas pozostaje dla
            zwykłego przetwarzania. Limit 0 wstrzymuje nowe rezerwacje Lab. Nie
            wpisuj klucza API.
          </p>
          <label>
            Identyfikator projektu Gemini
            <input
              maxLength={200}
              value={account}
              disabled={busy || review}
              onChange={(e) => setAccount(e.target.value)}
            />
          </label>
          <label>
            Model Gemini dla budżetu
            <input
              maxLength={200}
              value={model}
              disabled={busy || review}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label>
            Maksymalnie requestów Lab na dzień
            <input
              type="number"
              min={0}
              step={1}
              value={daily}
              disabled={busy || review}
              onChange={(e) => setDaily(e.target.value)}
            />
          </label>
          {(
            [
              ['Zapas requestów na minutę', rpm, setRpm],
              ['Zapas requestów na dzień', rpd, setRpd],
              ['Zapas tokenów wejścia na minutę', tpm, setTpm],
            ] as const
          ).map(([label, value, set]) => (
            <label key={label}>
              {label}
              <input
                type="number"
                min={1}
                step={1}
                value={value}
                disabled={busy || review}
                onChange={(e) => set(e.target.value)}
              />
            </label>
          ))}
          <label>
            Powód zmiany budżetu
            <input
              maxLength={1000}
              value={reason}
              disabled={busy || review}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {!review ? (
            <button disabled={busy || !valid} onClick={() => setReview(true)}>
              Przejrzyj budżet Lab
            </button>
          ) : (
            <div>
              <p>
                Limit: {daily} requestów dziennie. Zapas: {rpm} RPM / {rpd} RPD
                / {tpm} tokenów na minutę. Projekt: {account}. Model: {model}.
              </p>
              <button disabled={busy} onClick={() => void save()}>
                Potwierdź budżet Lab
              </button>
              <button disabled={busy} onClick={() => setReview(false)}>
                Wróć do edycji budżetu
              </button>
            </div>
          )}
        </>
      )}
    </details>
  );
}
