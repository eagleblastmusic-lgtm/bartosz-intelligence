import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CalendarSnapshot } from '../../../../packages/contracts/src/daily.js';
import { api, errorMessage } from '../app/api.js';
import { dayLabel, shiftDay, shiftMonth } from '../app/dates.js';
import { navigate, today } from '../app/router.js';

export function DayNavigator({
  date,
  sources,
}: {
  date: string;
  sources: string;
}) {
  const [open, setOpen] = useState(false),
    [month, setMonth] = useState(date.slice(0, 7)),
    [calendar, setCalendar] = useState<CalendarSnapshot | null>(null),
    [error, setError] = useState(''),
    [focused, setFocused] = useState(date),
    trigger = useRef<HTMLButtonElement>(null),
    grid = useRef<HTMLDivElement>(null);
  function go(value: string) {
    const query = new URLSearchParams(location.search);
    if (sources) query.set('source_ids', sources);
    navigate('/daily/' + value + (query.size ? '?' + query : ''));
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setCalendar(null);
    setError('');
    const query = new URLSearchParams({ month, timezone: 'Europe/Warsaw' });
    if (sources) query.set('source_ids', sources);
    api<CalendarSnapshot>(
      '/daily/calendar?' + query,
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setCalendar(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [open, month, sources]);
  useEffect(() => {
    if (open && calendar)
      grid.current
        ?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)
        ?.focus();
  }, [open, calendar, focused]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function keyboard(event: KeyboardEvent, value: string) {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[
      event.key
    ];
    if (delta !== undefined) {
      event.preventDefault();
      const next = shiftDay(value, delta);
      setFocused(next);
      setMonth(next.slice(0, 7));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const weekday = (new Date(value + 'T12:00:00Z').getUTCDay() + 6) % 7;
      const next = shiftDay(
        value,
        event.key === 'Home' ? -weekday : 6 - weekday,
      );
      setFocused(next);
      setMonth(next.slice(0, 7));
    }
  }
  return (
    <div className="day-navigation">
      <div className="day-controls" aria-label="Wybór dnia">
        <button
          onClick={() => go(shiftDay(date, -1))}
          aria-label="Poprzedni dzień"
        >
          ←
        </button>
        <button onClick={() => go(today())}>Dzisiaj</button>
        <button onClick={() => go(shiftDay(today(), -1))}>Wczoraj</button>
        <button
          ref={trigger}
          aria-expanded={open}
          aria-controls="day-calendar"
          onClick={() => {
            if (open) close();
            else {
              setFocused(date);
              setMonth(date.slice(0, 7));
              setOpen(true);
            }
          }}
        >
          Kalendarz
        </button>
        <button
          onClick={() => go(shiftDay(date, 1))}
          aria-label="Następny dzień"
        >
          →
        </button>
      </div>
      {open && (
        <section
          id="day-calendar"
          className="calendar panel"
          aria-label="Kalendarz publikacji"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        >
          <div className="calendar-heading">
            <button
              aria-label="Poprzedni miesiąc"
              onClick={() => {
                const next = shiftMonth(month, -1);
                setFocused(next + '-01');
                setMonth(next);
              }}
            >
              ←
            </button>
            <h2>
              {new Intl.DateTimeFormat('pl-PL', {
                month: 'long',
                year: 'numeric',
                timeZone: 'UTC',
              }).format(new Date(month + '-01T12:00:00Z'))}
            </h2>
            <button
              aria-label="Następny miesiąc"
              onClick={() => {
                const next = shiftMonth(month, 1);
                setFocused(next + '-01');
                setMonth(next);
              }}
            >
              →
            </button>
            <button onClick={close} aria-label="Zamknij kalendarz">
              ×
            </button>
          </div>
          {error ? (
            <p role="alert">{error}</p>
          ) : !calendar ? (
            <p role="status">Pobieranie kalendarza…</p>
          ) : (
            <>
              <div className="calendar-weekdays" aria-hidden="true">
                {['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'].map((day) => (
                  <span key={day}>{day}</span>
                ))}
              </div>
              <div
                className="calendar-grid"
                ref={grid}
                role="group"
                aria-label="Dni miesiąca"
              >
                {calendar.days.map((day, index) => (
                  <button
                    key={day.date}
                    data-date={day.date}
                    tabIndex={focused === day.date ? 0 : -1}
                    style={
                      index === 0
                        ? {
                            gridColumnStart:
                              ((new Date(day.date + 'T12:00:00Z').getUTCDay() +
                                6) %
                                7) +
                              1,
                          }
                        : undefined
                    }
                    aria-current={day.date === date ? 'date' : undefined}
                    aria-label={`${dayLabel(day.date)}; ${day.counts.items} materiałów, ${day.counts.ready} gotowych, ${day.counts.pending} oczekuje; ${day.discovery_complete ? 'sprawdzenie ukończone' : 'dzień niesprawdzony w całości'}`}
                    onFocus={() => setFocused(day.date)}
                    onKeyDown={(event) => keyboard(event, day.date)}
                    onClick={() => go(day.date)}
                  >
                    <strong>{Number(day.date.slice(8))}</strong>
                    <small>
                      {day.counts.items || (day.discovery_complete ? '0' : '—')}
                    </small>
                  </button>
                ))}
              </div>
              <p className="metadata">
                — sprawdzenie nieukończone · liczby oznaczają materiały
                <br />
                Odczyt:{' '}
                {new Date(calendar.freshness.sampled_at).toLocaleString(
                  'pl-PL',
                )}
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
