import { useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
export function today() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Warsaw',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
const event = 'bi-route';
function subscribe(callback: () => void) {
  window.addEventListener('popstate', callback);
  window.addEventListener(event, callback);
  return () => {
    window.removeEventListener('popstate', callback);
    window.removeEventListener(event, callback);
  };
}
export function useRoute() {
  return useSyncExternalStore(
    subscribe,
    () => location.pathname + location.search,
  );
}
export function navigate(href: string, replace = false) {
  if (!href.startsWith('/') || href.startsWith('//'))
    throw new Error('INVALID_ROUTE');
  history.replaceState(
    { ...history.state, biScroll: window.scrollY },
    '',
    location.href,
  );
  if (replace) history.replaceState({}, '', href);
  else history.pushState({}, '', href);
  window.dispatchEvent(new Event(event));
  window.scrollTo(0, 0);
}
export function AppLink({
  href,
  children,
  ...props
}: {
  href: string;
  children: ReactNode;
  className?: string;
  'aria-current'?: 'page';
  'aria-label'?: string;
}) {
  function click(e: MouseEvent<HTMLAnchorElement>) {
    if (
      e.button === 0 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      navigate(href);
    }
  }
  return (
    <a href={href} onClick={click} {...props}>
      {children}
    </a>
  );
}
