import { useEffect, useRef, useState } from 'react';
import type {
  KnowledgeOrganization,
  ManualInsight,
} from '../../../../packages/core/src/knowledge/organization.js';
import { api, errorMessage } from '../app/api.js';
type Organization = Awaited<ReturnType<KnowledgeOrganization['read']>>;
type Spaces = {
  spaces: Awaited<ReturnType<KnowledgeOrganization['spaces']>>;
  has_more: boolean;
};
export function ItemOrganization({
  itemId,
  runId,
  observations,
}: {
  itemId: string;
  runId: string | null;
  observations: { observation_id: string; content_pl: string }[];
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<Organization | null>(null),
    [spaces, setSpaces] = useState<Spaces | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [spaceName, setSpaceName] = useState(''),
    [spaceDraftId, setSpaceDraftId] = useState(() => crypto.randomUUID()),
    [noteDraftId, setNoteDraftId] = useState(() => crypto.randomUUID()),
    [editingSpace, setEditingSpace] = useState<Spaces['spaces'][number] | null>(
      null,
    ),
    [note, setNote] = useState(''),
    [refs, setRefs] = useState<string[]>([]),
    [editing, setEditing] = useState<ManualInsight | null>(null);
  const path = '/organization/items/' + encodeURIComponent(itemId);
  const intent = useRef<{ key: string; mutation_id: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setBusy(true);
    setError('');
    Promise.all([
      api<Organization>(path, undefined, undefined, controller.signal),
      api<Spaces>(
        '/organization/spaces',
        undefined,
        undefined,
        controller.signal,
      ),
    ])
      .then(([organization, spaces]) => {
        if (!controller.signal.aborted) {
          setData(organization);
          setSpaces(spaces);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [open, path, revision, runId]);
  async function mutate(route: string, input: Record<string, unknown>) {
    if (busy) return false;
    setBusy(true);
    setError('');
    const key = JSON.stringify([route, input]);
    const mutation_id =
      intent.current?.key === key
        ? intent.current.mutation_id
        : crypto.randomUUID();
    intent.current = { key, mutation_id };
    try {
      await api(route, { ...input, mutation_id }, mutation_id);
      intent.current = null;
      setRevision((value) => value + 1);
      return true;
    } catch (error) {
      setError(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function review(
    action: 'SAVE' | 'UNSAVE' | 'OPEN' | 'READ' | 'REVIEW',
  ) {
    if (!data) return;
    await mutate(path + '/review', {
      action,
      reviewed_run_id: action === 'REVIEW' ? runId : null,
      expected_revision: data.review.revision,
    });
  }
  function edit(insight: ManualInsight) {
    setEditing(insight);
    setNote(insight.text);
    setRefs(
      data?.observation_refs
        .filter((ref) => ref.insight_id === insight.insight_id)
        .map((ref) => ref.observation_id) ?? [],
    );
  }
  async function saveNote(
    active = true,
    existing: ManualInsight | null = editing,
    draft = true,
  ) {
    const observation_ids =
      existing && !draft
        ? (data?.observation_refs
            .filter((ref) => ref.insight_id === existing.insight_id)
            .map((ref) => ref.observation_id) ?? [])
        : refs;
    const text = existing && !draft ? existing.text : note;
    if (
      await mutate(path + '/insights', {
        insight_id: existing?.insight_id ?? noteDraftId,
        text,
        active,
        observation_ids,
        expected_revision: existing?.revision ?? 0,
      })
    ) {
      setEditing(null);
      setNoteDraftId(crypto.randomUUID());
      setNote('');
      setRefs([]);
    }
  }
  if (!open)
    return <button onClick={() => setOpen(true)}>Organizacja i notatki</button>;
  const options = new Map(
    observations.map((row) => [row.observation_id, row.content_pl]),
  );
  for (const id of refs)
    if (!options.has(id))
      options.set(id, 'Wypowiedź wcześniejszego wyniku · ' + id);
  return (
    <section
      className="notice correction-editor"
      aria-label="Organizacja i notatki"
    >
      <h2>Organizacja i notatki</h2>
      <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>
        Odśwież organizację
      </button>
      {error && <p role="alert">{error}</p>}
      {busy && !data && <p role="status">Wczytywanie organizacji…</p>}
      {data && (
        <>
          {data.review.updated && (
            <p role="status">Wynik zaktualizowany od ostatniego przeglądu.</p>
          )}
          <p>
            {data.review.saved
              ? 'Zapisany do późniejszego czytania.'
              : 'Niezapisany.'}
            {data.review.read_at
              ? ' Przeczytany: ' +
                new Date(data.review.read_at).toLocaleString('pl-PL')
              : ''}
          </p>
          <div className="header-controls">
            <button
              disabled={busy}
              onClick={() => void review(data.review.saved ? 'UNSAVE' : 'SAVE')}
            >
              {data.review.saved ? 'Usuń z zapisanych' : 'Zapisz na później'}
            </button>
            <button disabled={busy} onClick={() => void review('READ')}>
              Oznacz jako przeczytany
            </button>
            <button
              disabled={busy || !runId}
              onClick={() => void review('REVIEW')}
            >
              Oznacz ten wynik jako przejrzany
            </button>
            <button disabled={busy} onClick={() => void review('OPEN')}>
              Zapamiętaj otwarcie
            </button>
          </div>
          <h3>Spaces</h3>
          <p>
            Materiał może należeć do wielu Spaces. Wiedza i dowody pozostają
            wspólne.
          </p>
          {spaces?.spaces.map((space) => {
            const member = data.memberships.find(
              (member) => member.space_id === space.space_id,
            );
            return (
              <div key={space.space_id}>
                <span>
                  {space.name}
                  {space.active ? '' : ' · archiwalny'}
                </span>
                {(!!space.active || !!member?.active) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void mutate(path + '/membership', {
                        space_id: space.space_id,
                        active: !member?.active,
                        expected_revision: member?.revision ?? 0,
                      })
                    }
                  >
                    {member?.active ? 'Usuń ze Space' : 'Dodaj do Space'}:{' '}
                    {space.name}
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void mutate('/organization/spaces', {
                      space_id: space.space_id,
                      name: space.name,
                      active: !space.active,
                      expected_revision: space.revision,
                    })
                  }
                >
                  {space.active ? 'Archiwizuj Space' : 'Przywróć Space'}:{' '}
                  {space.name}
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setEditingSpace(space);
                    setSpaceName(space.name);
                  }}
                >
                  Zmień nazwę Space: {space.name}
                </button>
              </div>
            );
          })}
          {(spaces?.has_more || data.memberships_has_more) && (
            <p className="muted">Lista Spaces nie jest pełna.</p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate('/organization/spaces', {
                space_id: editingSpace?.space_id ?? spaceDraftId,
                name: spaceName,
                active: editingSpace ? !!editingSpace.active : true,
                expected_revision: editingSpace?.revision ?? 0,
              }).then((ok) => {
                if (ok) {
                  setSpaceName('');
                  setEditingSpace(null);
                  setSpaceDraftId(crypto.randomUUID());
                }
              });
            }}
          >
            <label>
              {editingSpace ? 'Nowa nazwa Space' : 'Nazwa nowego Space'}
              <input
                required
                maxLength={120}
                value={spaceName}
                onChange={(event) => setSpaceName(event.target.value)}
              />
            </label>
            <button disabled={busy || !spaceName.trim()}>
              {editingSpace ? 'Zapisz nazwę Space' : 'Utwórz Space'}
            </button>
            {editingSpace && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditingSpace(null);
                  setSpaceName('');
                }}
              >
                Anuluj zmianę nazwy Space
              </button>
            )}
          </form>
          <h3>Notatki właściciela</h3>
          <p>
            Własne uwagi, oddzielne od wypowiedzi źródła. Zapis nie uruchamia
            AI.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveNote();
            }}
          >
            <label>
              Treść własnej notatki
              <textarea
                required
                maxLength={20000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <label>
              Powiązane wypowiedzi (do 20)
              <select
                multiple
                value={refs}
                onChange={(event) =>
                  setRefs(
                    [...event.target.selectedOptions].map(
                      (option) => option.value,
                    ),
                  )
                }
              >
                {[...options].map(([id, text]) => (
                  <option key={id} value={id}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy || !note.trim() || refs.length > 20}>
              {editing ? 'Zapisz zmianę notatki' : 'Zapisz własną notatkę'}
            </button>
            {editing && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setNote('');
                  setRefs([]);
                }}
              >
                Anuluj edycję notatki
              </button>
            )}
          </form>
          {data.insights.map((insight) => (
            <article className="daily-row" key={insight.insight_id}>
              <p className="metadata">
                Autor: właściciel ·{' '}
                {insight.active ? 'notatka aktywna' : 'notatka archiwalna'} ·
                rewizja {insight.revision}
              </p>
              <p style={{ whiteSpace: 'pre-wrap' }}>{insight.text}</p>
              <p className="metadata">
                {new Date(insight.updated_at).toLocaleString('pl-PL')}
              </p>
              <button
                disabled={busy || data.observation_refs_has_more}
                onClick={() => edit(insight)}
              >
                Edytuj notatkę
              </button>
              <button
                disabled={busy || data.observation_refs_has_more}
                onClick={() => void saveNote(!insight.active, insight, false)}
              >
                {insight.active ? 'Archiwizuj notatkę' : 'Przywróć notatkę'}
              </button>
            </article>
          ))}
          {(data.insights_has_more || data.observation_refs_has_more) && (
            <p className="muted">
              Widoczna lista notatek lub powiązań nie jest pełna.
            </p>
          )}
        </>
      )}
      <button disabled={busy} onClick={() => setOpen(false)}>
        Zamknij organizację i notatki
      </button>
    </section>
  );
}
