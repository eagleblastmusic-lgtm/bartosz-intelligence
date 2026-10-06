import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  api,
  ApiError,
  clearPrivateRequests,
  errorMessage,
} from './app/api.js';
import { AppLink, navigate, today, useRoute } from './app/router.js';
import { applyTheme, savedTheme, type Theme } from './design/theme.js';
import { Channels } from './channels.js';
import { Daily } from './features/daily.js';
import { System } from './features/system.js';
import { ItemDetail } from './features/item-detail.js';
import { Ledger } from './features/ledger.js';
import './design/tokens.css';
import { NavIcon } from './components/nav-icon.js';
type Session = 'checking' | 'owner' | 'login' | 'setup' | 'denied' | 'error';
function App() {
  const route = useRoute(),
    [session, setSession] = useState<Session>('checking'),
    [epoch, setEpoch] = useState(0),
    [check, setCheck] = useState(0),
    [theme, setTheme] = useState<Theme>(savedTheme),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    applyTheme(theme);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => applyTheme(theme);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, [theme]);
  useEffect(() => {
    const expired = () => {
      clearPrivateRequests();
      setEpoch((value) => value + 1);
      setSession('login');
      setError('Sesja wygasła. Zaloguj się ponownie.');
    };
    window.addEventListener('bi-session-expired', expired);
    return () => {
      window.removeEventListener('bi-session-expired', expired);
      clearPrivateRequests();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api('/auth/session', undefined, undefined, controller.signal)
      .then(() => setSession('owner'))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setSession(
          error instanceof ApiError
            ? error.code === 'AUTH_CONFIGURATION_REQUIRED'
              ? 'setup'
              : error.status === 401
                ? 'login'
                : error.status === 403
                  ? 'denied'
                  : 'error'
            : 'error',
        );
      });
    return () => controller.abort();
  }, [check]);
  useEffect(() => {
    if (session !== 'owner') return;
    if (location.pathname === '/') {
      navigate('/daily/' + today(), true);
      return;
    }
    document.title =
      (route.startsWith('/channels')
        ? 'Kanały'
        : route.startsWith('/ledger')
          ? 'Wiedza'
          : route.startsWith('/system')
            ? 'System'
            : 'Dziennik') + ' · Bartosz Intelligence';
    const frame = requestAnimationFrame(() => {
      document.getElementById('main-content')?.focus({ preventScroll: true });
      if (typeof history.state?.biScroll === 'number')
        window.scrollTo(0, history.state.biScroll);
    });
    return () => cancelAnimationFrame(frame);
  }, [route, session]);
  async function logout() {
    setBusy(true);
    setError('');
    try {
      await api('/auth/logout', {});
      clearPrivateRequests();
      setSession('login');
      setEpoch((value) => value + 1);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401))
        setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  if (session !== 'owner')
    return (
      <main className="auth-page">
        <div className="brand">
          Bartosz Intelligence<small>Twoje źródła. Wiedza z dowodami.</small>
        </div>
        <section>
          <h1>Bartosz Intelligence</h1>
          {error && (
            <p role="alert" className="notice">
              {error}
            </p>
          )}
          {session === 'checking' && <p role="status">Sprawdzanie sesji…</p>}
          {session === 'login' && (
            <>
              <p>
                Zaloguj się, aby czytać materiały i zarządzać swoimi kanałami.
              </p>
              <a className="primary-link" href="/api/v1/auth/login">
                Zaloguj się przez Google
              </a>
            </>
          )}
          {session === 'setup' && (
            <p>
              Wymagane ustanowienie właściciela przez prywatny launcher
              administratora.
            </p>
          )}
          {session === 'denied' && (
            <p role="alert">
              To konto nie ma dostępu do aplikacji właściciela.
            </p>
          )}
          {session === 'error' && (
            <>
              <p role="alert">
                Nie udało się sprawdzić sesji. Sprawdź połączenie.
              </p>
              <button
                onClick={() => {
                  setSession('checking');
                  setCheck((value) => value + 1);
                }}
              >
                Spróbuj ponownie
              </button>
            </>
          )}
        </section>
      </main>
    );
  const section = route.startsWith('/channels')
    ? 'channels'
    : route.startsWith('/system')
      ? 'system'
      : route.startsWith('/ledger')
        ? 'ledger'
        : route.startsWith('/items/')
          ? 'item'
          : route.startsWith('/daily/')
            ? 'daily'
            : 'unknown';
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Przejdź do treści
      </a>
      <aside className="app-rail">
        <div className="brand">
          Bartosz
          <br />
          Intelligence<small>Research desk</small>
        </div>
        <nav className="rail-nav" aria-label="Główna nawigacja">
          {[
            {
              id: 'daily',
              href: '/daily/' + today(),
              label: 'Dziennik',
              symbol: '▤',
            },
            { id: 'channels', href: '/channels', label: 'Kanały', symbol: '◉' },
            { id: 'ledger', href: '/ledger', label: 'Wiedza', symbol: '◇' },
            { id: 'system', href: '/system', label: 'System', symbol: '▦' },
          ].map((item) => (
            <AppLink
              key={item.id}
              href={item.href}
              aria-label={item.label}
              aria-current={
                section === item.id ||
                (section === 'item' && item.id === 'daily')
                  ? 'page'
                  : undefined
              }
            >
              <span className="nav-symbol" aria-hidden="true">
                <NavIcon kind={item.id} />
              </span>
              <span className="nav-label">{item.label}</span>
            </AppLink>
          ))}
        </nav>
        <div className="rail-foot metadata">
          Przestrzeń właściciela
          <br />
          Strefa: Warszawa
        </div>
      </aside>
      <div className="workspace">
        <header className="app-header">
          <span className="eyebrow">
            {section === 'channels'
              ? 'Twoje źródła'
              : section === 'system'
                ? 'Stan pracy'
                : 'Publikacje i analizy'}
          </span>
          <div className="header-controls">
            <label className="theme-label">
              <span>Motyw</span>
              <select
                aria-label="Motyw"
                value={theme}
                onChange={(e) => setTheme(e.target.value as Theme)}
              >
                <option value="system">Systemowy</option>
                <option value="light">Jasny</option>
                <option value="dark">Ciemny</option>
              </select>
            </label>
            <button disabled={busy} onClick={() => void logout()}>
              Wyloguj
            </button>
          </div>
        </header>
        <main id="main-content" className="content" tabIndex={-1} key={epoch}>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          {section === 'channels' && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Kanały</h1>
                  <p className="muted">
                    Publiczne źródła, które chcesz śledzić.
                  </p>
                </div>
              </div>
              <Channels />
            </>
          )}
          {section === 'daily' && <Daily route={route} />}
          {section === 'item' && <ItemDetail route={route} />}
          {section === 'system' && <System />}
          {section === 'ledger' && <Ledger route={route} />}
          {section === 'unknown' && (
            <>
              <h1>Nie znaleziono widoku</h1>
              <AppLink href={'/daily/' + today()}>Wróć do Dziennika</AppLink>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
