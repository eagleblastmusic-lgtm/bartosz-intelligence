import { useEffect, useRef, useState } from 'react';
import type { EntityKnowledge } from '../../../../packages/core/src/knowledge/entities.js';
import type { IdentityProposal } from '../../../../packages/core/src/knowledge/identity.js';
import { api, errorMessage } from '../app/api.js';
import { AppLink } from '../app/router.js';
import { CorrectionEditor } from '../components/correction-editor.js';
type Catalog = Awaited<ReturnType<EntityKnowledge['list']>>;
type Detail = Awaited<ReturnType<EntityKnowledge['detail']>>;
const resolutions: Record<string, string> = {
  APPROVED_ALIAS: 'Zatwierdzony alias przy ekstrakcji',
  UNRESOLVED_LITERAL: 'Nazwa literalna — tożsamość nieustalona',
  AMBIGUOUS_LITERAL: 'Nazwa niejednoznaczna',
};
const types: Record<string, string> = {
  PERSON: 'Osoba',
  ORG: 'Organizacja',
  TOOL: 'Narzędzie',
  MODEL: 'Model',
  PRODUCT: 'Produkt',
  TOPIC: 'Temat',
  PLACE: 'Miejsce',
  OTHER: 'Inna encja',
};
export function Entities({ route }: { route: string }) {
  const id = new URL(route, location.origin).pathname
    .slice('/entities'.length)
    .replace(/^\//, '');
  const currentId = useRef(id);
  currentId.current = id;
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [targets, setTargets] = useState<Catalog | null>(null),
    [targetId, setTargetId] = useState(''),
    [identityReason, setIdentityReason] = useState(''),
    [identityProposal, setIdentityProposal] = useState<IdentityProposal | null>(
      null,
    );
  const [literal, setLiteral] = useState(''),
    [reason, setReason] = useState(''),
    [language, setLanguage] = useState(''),
    [proposal, setProposal] = useState<{
      literal: string;
      reason: string;
      language: string | null;
      action: 'APPROVE' | 'REVOKE';
      expected_revision: number;
      decision_id: string;
    } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setBusy(true);
    setCatalog(null);
    setDetail(null);
    setProposal(null);
    setIdentityProposal(null);
    setIdentityReason('');
    setTargetId('');
    setTargets(null);
    setReason('');
    const request = id
      ? api<Detail>(
          '/entities/' + encodeURIComponent(id),
          undefined,
          undefined,
          controller.signal,
        ).then((value) => {
          setDetail(value);
          setLiteral(value.entity.label);
        })
      : api<Catalog>(
          '/entities?limit=50',
          undefined,
          undefined,
          controller.signal,
        ).then(setCatalog);
    request
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [id, revision]);
  async function loadTargets() {
    setBusy(true);
    setError('');
    try {
      const next = await api<Catalog>(
        '/entities?limit=50' +
          (targets?.next_cursor
            ? '&cursor=' + encodeURIComponent(targets.next_cursor)
            : ''),
      );
      if (currentId.current === id)
        setTargets({
          ...next,
          entities: [...(targets?.entities ?? []), ...next.entities],
        });
    } catch (error) {
      if (currentId.current === id) setError(errorMessage(error));
    } finally {
      if (currentId.current === id) setBusy(false);
    }
  }
  async function previewIdentity(
    action: 'MERGE' | 'SPLIT' | 'UNDO',
    parent?: string,
  ) {
    if (!detail || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<IdentityProposal>('/entities/identity-preview', {
        action,
        source_entity_id: id,
        target_entity_id:
          action === 'SPLIT' ? detail.entity.effective_entity_id : targetId,
        reason: identityReason,
        parent_event_id: parent ?? null,
      });
      if (currentId.current === id) setIdentityProposal(result);
    } catch (error) {
      if (currentId.current === id) setError(errorMessage(error));
    } finally {
      if (currentId.current === id) setBusy(false);
    }
  }
  async function confirmIdentity() {
    if (!identityProposal || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(
        '/entities/identity-confirm',
        identityProposal,
        identityProposal.event_id,
      );
      if (currentId.current === id) {
        setIdentityProposal(null);
        setRevision((value) => value + 1);
      }
    } catch (error) {
      if (currentId.current === id) setError(errorMessage(error));
    } finally {
      if (currentId.current === id) setBusy(false);
    }
  }
  async function confirm() {
    if (!proposal || !detail || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(
        '/entities/' + encodeURIComponent(id) + '/aliases',
        proposal,
        proposal.decision_id,
      );
      if (currentId.current !== id) return;
      setProposal(null);
      setRevision((value) => value + 1);
    } catch (error) {
      if (currentId.current === id) setError(errorMessage(error));
    } finally {
      if (currentId.current === id) setBusy(false);
    }
  }
  async function more() {
    if (!catalog?.next_cursor || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<Catalog>(
        '/entities?limit=50&cursor=' + encodeURIComponent(catalog.next_cursor),
      );
      if (currentId.current !== id) return;
      setCatalog({
        ...next,
        entities: [...catalog.entities, ...next.entities],
      });
    } catch (error) {
      if (currentId.current === id) setError(errorMessage(error));
    } finally {
      if (currentId.current === id) setBusy(false);
    }
  }
  return (
    <>
      <AppLink href="/ledger">← Wiedza</AppLink>
      <div className="page-heading">
        <div>
          <h1>{detail?.entity.label ?? 'Encje'}</h1>
          <p className="muted">
            Literalne nazwy ze źródeł. Zatwierdzenie aliasu jest decyzją
            właściciela, a nie oceną prawdziwości wypowiedzi.
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          Odśwież encje
        </button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {busy && !detail && !catalog && <p role="status">Wczytywanie encji…</p>}
      {catalog && (
        <div className="daily-list">
          {!catalog.entities.length && (
            <p>Brak encji w przyjętych analizach.</p>
          )}
          {catalog.entities.map((entity) => (
            <article className="daily-row" key={entity.entity_id}>
              <h2>
                <AppLink
                  href={'/entities/' + encodeURIComponent(entity.entity_id)}
                >
                  {entity.label}
                </AppLink>
              </h2>
              <p className="muted">
                {types[entity.entity_type] ?? 'Encja'} ·{' '}
                {resolutions[entity.resolution] ?? 'Tożsamość nieustalona'}
              </p>
            </article>
          ))}
        </div>
      )}
      {catalog?.next_cursor && (
        <button disabled={busy} onClick={() => void more()}>
          Pokaż więcej encji
        </button>
      )}
      {detail && (
        <>
          <p className="notice">
            Stan zapisany przy ekstrakcji:{' '}
            {resolutions[detail.entity.resolution] ?? 'Tożsamość nieustalona'}.
            Historyczne rekordy zachowują swoje identyfikatory.
          </p>
          <AppLink href={'/ledger?entity_id=' + encodeURIComponent(id)}>
            Wypowiedzi i dowody dotyczące tej encji
          </AppLink>
          <section>
            <h2>Tożsamość encji</h2>
            <CorrectionEditor kind="ENTITY_LABEL" id={id} />
            {detail.entity.effective_entity_id &&
              detail.entity.effective_entity_id !== id && (
                <p className="notice">
                  Ta literalna encja należy do scalonej grupy.{' '}
                  <AppLink
                    href={
                      '/entities/' +
                      encodeURIComponent(detail.entity.effective_entity_id)
                    }
                  >
                    Otwórz wspólną tożsamość
                  </AppLink>
                </p>
              )}
            <p className="muted">
              Scalanie zmienia efektywną grupę. Oryginalne nazwy, wypowiedzi i
              cytaty pozostają zachowane.
            </p>
            <button disabled={busy} onClick={() => void loadTargets()}>
              {targets?.next_cursor
                ? 'Pokaż kolejne encje do scalenia'
                : 'Wybierz encję do scalenia'}
            </button>
            <div className="filter-bar">
              {targets && (
                <label>
                  Wspólna encja
                  <select
                    value={targetId}
                    onChange={(event) => {
                      setTargetId(event.target.value);
                      setIdentityProposal(null);
                    }}
                  >
                    <option value="">Wybierz encję</option>
                    {targets.entities
                      .filter(
                        (entity) =>
                          entity.entity_type === detail.entity.entity_type &&
                          entity.entity_id !== id &&
                          (entity.effective_entity_id ?? entity.entity_id) !==
                            detail.entity.effective_entity_id,
                      )
                      .map((entity) => (
                        <option key={entity.entity_id} value={entity.entity_id}>
                          {entity.label}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label>
                Powód zmiany tożsamości
                <input
                  maxLength={2000}
                  value={identityReason}
                  onChange={(event) => {
                    setIdentityReason(event.target.value);
                    setIdentityProposal(null);
                  }}
                />
              </label>
              <button
                disabled={busy || !targetId || !identityReason.trim()}
                onClick={() => void previewIdentity('MERGE')}
              >
                Podgląd scalenia
              </button>
              {detail.entity.effective_entity_id &&
                detail.entity.effective_entity_id !== id && (
                  <button
                    disabled={busy || !identityReason.trim()}
                    onClick={() => void previewIdentity('SPLIT')}
                  >
                    Podgląd wydzielenia tej encji
                  </button>
                )}
            </div>
            {identityProposal && (
              <section className="notice" aria-label="Podgląd tożsamości">
                <h3>
                  {identityProposal.action === 'MERGE'
                    ? 'Scalenie'
                    : identityProposal.action === 'SPLIT'
                      ? 'Wydzielenie'
                      : 'Cofnięcie zmiany'}
                </h3>
                <p>{identityProposal.reason}</p>
                <ul>
                  {identityProposal.expected.map((member) => (
                    <li key={member.entity_id}>
                      {member.label}
                      <span className="metadata">
                        {' '}
                        · rewizja tożsamości {member.identity_revision}, aliasów{' '}
                        {member.alias_revision}
                      </span>
                    </li>
                  ))}
                </ul>
                {identityProposal.impact && (
                  <p>
                    W chwili podglądu: {identityProposal.impact.observations}{' '}
                    wypowiedzi i {identityProposal.impact.aliases} zapisów
                    aliasów.
                  </p>
                )}
                <p>
                  Zmiana nie przepisuje historycznych dowodów ani nie uruchamia
                  AI.
                </p>
                <button disabled={busy} onClick={() => void confirmIdentity()}>
                  Potwierdź zmianę tożsamości
                </button>
                <button
                  disabled={busy}
                  onClick={() => setIdentityProposal(null)}
                >
                  Anuluj zmianę tożsamości
                </button>
              </section>
            )}
            {(detail.identity_history ?? []).map((event) => (
              <article className="daily-row" key={event.event_id}>
                <h3>
                  {event.action === 'MERGE'
                    ? 'Scalenie'
                    : event.action === 'SPLIT'
                      ? 'Wydzielenie'
                      : 'Cofnięcie zmiany'}
                </h3>
                <p>{event.reason}</p>
                <p className="metadata">
                  {event.recorded_at} · autor: właściciel
                </p>
                <button
                  disabled={busy || !identityReason.trim()}
                  onClick={() => void previewIdentity('UNDO', event.event_id)}
                >
                  Podgląd cofnięcia tej zmiany
                </button>
              </article>
            ))}
            {detail.identity_history_has_more && (
              <p className="notice">Widoczne ostatnie 50 zmian tożsamości.</p>
            )}
          </section>
          <section>
            <h2>Aliasy encji</h2>
            {detail.aliases.map((alias) => (
              <div className="daily-row" key={alias.alias_id}>
                <p>
                  {alias.literal} ·{' '}
                  {alias.status === 'APPROVED' ? 'Zatwierdzony' : 'Wycofany'}
                </p>
                {alias.status === 'APPROVED' && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setLiteral(alias.literal);
                      setProposal(null);
                    }}
                  >
                    Wybierz do wycofania
                  </button>
                )}
              </div>
            ))}
            {detail.aliases_has_more && (
              <p className="notice">
                Widoczne pierwsze 50 aliasów; lista nie jest pełna.
              </p>
            )}
            <form
              className="filter-bar"
              onSubmit={(event) => {
                event.preventDefault();
                setProposal({
                  literal,
                  reason,
                  language: language.trim() || null,
                  action: 'APPROVE',
                  expected_revision: detail.revision,
                  decision_id: crypto.randomUUID(),
                });
              }}
            >
              <label>
                Nazwa aliasu
                <input
                  required
                  maxLength={1024}
                  value={literal}
                  onChange={(event) => {
                    setLiteral(event.target.value);
                    setProposal(null);
                  }}
                />
              </label>
              <label>
                Język źródła (opcjonalnie)
                <input
                  maxLength={35}
                  placeholder="pl"
                  value={language}
                  onChange={(event) => {
                    setLanguage(event.target.value);
                    setProposal(null);
                  }}
                />
              </label>
              <label>
                Powód decyzji
                <input
                  required
                  maxLength={2000}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setProposal(null);
                  }}
                />
              </label>
              <button disabled={busy || !literal.trim() || !reason.trim()}>
                Podgląd zatwierdzenia
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  !reason.trim() ||
                  !detail.aliases.some(
                    (alias) =>
                      alias.literal === literal && alias.status === 'APPROVED',
                  )
                }
                onClick={() =>
                  setProposal({
                    literal,
                    reason,
                    language: language.trim() || null,
                    action: 'REVOKE',
                    expected_revision: detail.revision,
                    decision_id: crypto.randomUUID(),
                  })
                }
              >
                Podgląd wycofania
              </button>
            </form>
            {proposal && (
              <section className="notice" aria-label="Podgląd decyzji">
                <h3>
                  {proposal.action === 'APPROVE'
                    ? 'Zatwierdzenie'
                    : 'Wycofanie'}{' '}
                  aliasu
                </h3>
                <p>
                  „{proposal.literal}” → {detail.entity.label}.{' '}
                  {proposal.reason}
                </p>
                <p>
                  {proposal.language
                    ? 'Język źródła: ' + proposal.language
                    : 'Bez ograniczenia do języka źródła.'}
                </p>
                <p>
                  Decyzja będzie zapisana z autorem i powodem. Wpływa na
                  przyszłą ekstrakcję; stare cytaty i wypowiedzi pozostają
                  zachowane.
                </p>
                <button disabled={busy} onClick={() => void confirm()}>
                  Potwierdź decyzję
                </button>
                <button disabled={busy} onClick={() => setProposal(null)}>
                  Anuluj
                </button>
              </section>
            )}
          </section>
          <section>
            <h2>Historia decyzji</h2>
            {!detail.history.length && <p>Brak decyzji właściciela.</p>}
            {detail.history.map((event) => (
              <article className="daily-row" key={event.decision_id}>
                <h3>
                  {event.action === 'APPROVE' ? 'Zatwierdzenie' : 'Wycofanie'}:{' '}
                  {event.normalized_literal}
                </h3>
                <p>{event.reason}</p>
                <p className="metadata">
                  {event.language
                    ? 'Język: ' + event.language
                    : 'Wszystkie języki'}
                </p>
                <p className="metadata">
                  {event.recorded_at} · autor: właściciel · rewizja{' '}
                  {event.revision}
                </p>
              </article>
            ))}
            {detail.history_has_more && (
              <p className="notice">
                Widoczne ostatnie 50 decyzji; historia nie jest pełna.
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}
