import { useEffect, useRef, useState } from 'react';
import type { DailySnapshot } from '../../../../packages/contracts/src/daily.js';
import { api, errorMessage } from '../app/api.js';
import { AppLink, navigate } from '../app/router.js';
import { DayNavigator } from '../components/day-navigator.js';
import { statusLabels, reasonLabel } from '../app/status.js';
export function Daily({ route }: { route: string }) {
  const url = new URL(route, location.origin),
    date = url.pathname.slice('/daily/'.length),
    sources = url.searchParams.get('source_ids') ?? '',
    key = date + ':' + sources,
    [stored, setStored] = useState<{ key: string; data: DailySnapshot } | null>(
      null,
    ),
    result = stored?.key === key ? stored.data : null,
    [incoming, setIncoming] = useState<{
      key: string;
      data: DailySnapshot;
    } | null>(null),
    [paging, setPaging] = useState(false),
    pageRequest = useRef<AbortController | null>(null),
    lastReadKey = useRef<string | null>(null),
    [catalog, setCatalog] = useState<{ source_id: string; title: string }[]>(
      [],
    ),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const entries: { source_id: string; title: string }[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: '50' });
        if (cursor) query.set('cursor', cursor);
        const page = await api<{
          sources: { source_id: string; title: string }[];
          next_cursor: string | null;
        }>('/sources?' + query, undefined, undefined, controller.signal);
        entries.push(...page.sources);
        cursor = page.next_cursor;
      } while (cursor && !controller.signal.aborted);
      if (!controller.signal.aborted) setCatalog(entries);
    }
    void load().catch(() => {
      /* Daily coverage remains available if the source list fails. */
    });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setPaging(false);
    return () => pageRequest.current?.abort();
  }, [key, revision]);
  useEffect(() => {
    const controller = new AbortController();
    const restoreScroll = lastReadKey.current !== key;
    lastReadKey.current = key;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({
      date,
      timezone: 'Europe/Warsaw',
      limit: '20',
    });
    if (sources) query.set('source_ids', sources);
    api<DailySnapshot>(
      '/daily?' + query,
      undefined,
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setStored({ key, data });
          setIncoming(null);
          requestAnimationFrame(() => {
            if (
              !controller.signal.aborted &&
              restoreScroll &&
              typeof history.state?.biScroll === 'number'
            )
              window.scrollTo(0, history.state.biScroll);
          });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [key, date, sources, revision]);
  useEffect(() => {
    if (!result || loading) return;
    const controller = new AbortController();
    let checking = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || checking) return;
      checking = true;
      const query = new URLSearchParams({
        date,
        timezone: 'Europe/Warsaw',
        limit: '20',
      });
      if (sources) query.set('source_ids', sources);
      api<DailySnapshot>(
        '/daily?' + query,
        undefined,
        undefined,
        controller.signal,
      )
        .then((data) => {
          if (
            !controller.signal.aborted &&
            data.projection_revision !== result.projection_revision
          )
            setIncoming({ key, data });
        })
        .catch(() => {
          /* Passive refresh never removes the accepted visible revision. */
        })
        .finally(() => {
          checking = false;
        });
    }, 30000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [result, loading, key, date, sources]);
  async function more() {
    if (!result?.next_cursor || paging) return;
    setPaging(true);
    setError('');
    const controller = new AbortController();
    pageRequest.current = controller;
    const query = new URLSearchParams({
      date,
      timezone: 'Europe/Warsaw',
      limit: '20',
      cursor: result.next_cursor,
    });
    if (sources) query.set('source_ids', sources);
    try {
      const data = await api<DailySnapshot>(
        '/daily?' + query,
        undefined,
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setStored((current) =>
        current?.key === key &&
        current.data.projection_revision === data.projection_revision
          ? {
              key,
              data: { ...data, items: [...current.data.items, ...data.items] },
            }
          : current,
      );
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setPaging(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Dziennik</p>
          <h1>Publikacje z {date}</h1>
          <p className="muted">Według daty publikacji · Europe/Warsaw</p>
        </div>
        <button disabled={loading} onClick={() => setRevision((v) => v + 1)}>
          Odśwież
        </button>
      </div>
      {/^(20\d\d)-\d\d-\d\d$/.test(date) && !Number.isNaN(Date.parse(date)) && (
        <DayNavigator date={date} sources={sources} />
      )}
      <label className="density-control">
        Gęstość listy{' '}
        <select
          value={
            url.searchParams.get('density') === 'compact'
              ? 'compact'
              : 'comfortable'
          }
          onChange={(event) => {
            const query = new URLSearchParams(url.searchParams);
            query.set('density', event.target.value);
            navigate('/daily/' + date + '?' + query);
          }}
        >
          <option value="comfortable">Komfortowa</option>
          <option value="compact">Kompaktowa</option>
        </select>
      </label>
      {(catalog.length > 0 || (result?.source_coverage.length ?? 0) > 0) && (
        <div className="source-filters" role="group" aria-label="Filtr kanałów">
          {(catalog.length ? catalog : result!.source_coverage).map(
            (source) => (
              <label key={source.source_id}>
                <input
                  type="checkbox"
                  checked={sources.split(',').includes(source.source_id)}
                  onChange={(event) => {
                    const selected = new Set(sources ? sources.split(',') : []);
                    if (event.target.checked) selected.add(source.source_id);
                    else selected.delete(source.source_id);
                    const query = new URLSearchParams(url.searchParams);
                    if (selected.size)
                      query.set('source_ids', [...selected].sort().join(','));
                    else query.delete('source_ids');
                    navigate(
                      '/daily/' + date + (query.size ? '?' + query : ''),
                    );
                  }}
                />
                {source.title}
              </label>
            ),
          )}
          {sources && (
            <button
              onClick={() => {
                const query = new URLSearchParams(url.searchParams);
                query.delete('source_ids');
                navigate('/daily/' + date + (query.size ? '?' + query : ''));
              }}
            >
              Wszystkie kanały
            </button>
          )}
        </div>
      )}
      {incoming?.key === key && (
        <button
          className="update-notice"
          onClick={() => setRevision((value) => value + 1)}
        >
          {
            incoming.data.items.filter(
              (item) =>
                !result?.items.some(
                  (previous) => previous.item_id === item.item_id,
                ),
            ).length
          }{' '}
          nowych materiałów · Zastosuj zmiany
        </button>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {loading && !result && (
        <div role="status" aria-label="Pobieranie publikacji">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}
      {result && (
        <>
          <div className="count-line">
            <span>
              <strong>{result.counts.items}</strong> materiałów
            </span>
            <span>
              <strong>{result.counts.ready}</strong> gotowych
            </span>
            <span>
              <strong>{result.counts.pending}</strong> oczekuje
            </span>
          </div>
          {!result.discovery_complete && (
            <p className="notice">
              Sprawdzenie dnia nieukończone. Kolejne publikacje mogą pojawić się
              po discovery.
            </p>
          )}
          {result.items.length === 0 ? (
            <section className="empty-state">
              <h2>
                {result.discovery_complete
                  ? 'Tego dnia nie znaleziono publikacji'
                  : 'Jeszcze nie ma publikacji'}
              </h2>
              <p className="muted">
                {result.source_coverage.length === 0
                  ? 'Dodaj pierwszy kanał. Materiały pojawią się tutaj po sprawdzeniu źródła.'
                  : 'Materiały przypisujemy do dnia publikacji, również gdy analiza zakończy się później.'}
              </p>
              <AppLink href="/channels" className="primary-link">
                Przejdź do kanałów
              </AppLink>
            </section>
          ) : (
            <ul
              className="daily-rows"
              data-density={
                url.searchParams.get('density') === 'compact'
                  ? 'compact'
                  : 'comfortable'
              }
            >
              {result.items.map((item) => (
                <li className="daily-row" key={item.item_id}>
                  <div>
                    <h2>
                      <AppLink
                        href={
                          '/items/' +
                          encodeURIComponent(item.item_id) +
                          '?' +
                          new URLSearchParams({ return: route })
                        }
                      >
                        {item.title}
                      </AppLink>
                    </h2>
                    <p className="metadata">
                      {item.creator} ·{' '}
                      {item.published_at
                        ? new Intl.DateTimeFormat('pl-PL', {
                            timeZone: 'Europe/Warsaw',
                            hour: '2-digit',
                            minute: '2-digit',
                          }).format(new Date(item.published_at))
                        : 'Data nieustalona'}
                    </p>
                    {item.view?.summary_pl.map((note, index) => (
                      <p key={index}>{note.text_pl}</p>
                    ))}
                    {!item.view && (
                      <p className="metadata">
                        {item.analysis_status === 'READY'
                          ? 'Wynik przyjęty; podgląd jest dostępny w szczegółach.'
                          : (reasonLabel(item.reason) ??
                            'Analiza oczekuje na przetworzenie.')}
                      </p>
                    )}
                  </div>
                  <span
                    className="status-badge"
                    data-state={item.analysis_status}
                  >
                    <span aria-hidden="true">
                      {item.analysis_status === 'READY' ? '✓' : '◷'}
                    </span>
                    {statusLabels[item.analysis_status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {result.next_cursor && (
            <button disabled={paging || loading} onClick={more}>
              {paging ? 'Pobieranie…' : 'Pokaż więcej'}
            </button>
          )}
        </>
      )}
    </>
  );
}
