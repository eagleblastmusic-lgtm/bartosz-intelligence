import { Hono } from 'hono';

// Public copy is deliberately independent of bindings, owner data and SPA assets.
const about = `<h1>Bartosz Intelligence</h1>
<p>Prywatna aplikacja jednego właściciela do porządkowania źródeł YouTube, analiz i raportów dziennych. Ta strona przedstawia aplikację publicznie; dostęp do jej danych i funkcji wymaga autoryzacji właściciela.</p>
<h2>Integracja z Google Drive</h2>
<p>Po osobnej zgodzie OAuth aplikacja zapisuje raporty dzienne jako pliki Markdown w prywatnym folderze Google Drive utworzonym lub wskazanym przez właściciela i dostępnym dla aplikacji. Odczytuje metadane i zawartość własnych eksportów, aby sprawdzić poprawność zapisu i wykryć ręczne zmiany. Automatyczne eksporty wymagają odrębnego włączenia.</p>
<p>Uprawnienie <code>drive.file</code> obejmuje pliki utworzone przez aplikację lub udostępnione jej przez użytkownika. Integracja nie służy do przeszukiwania całego Dysku ani analizowania jego dokumentów przez AI.</p>
<p><a href="/privacy">Polityka prywatności</a> · <a href="/terms">Warunki korzystania</a></p>`;

const privacy = `<h1>Polityka prywatności — Bartosz Intelligence</h1>
<p>Aktualizacja: 8 października 2026 r. Aplikacja jest narzędziem osobistym jednego właściciela, który zarządza swoim kontem i danymi. Nie oferuje rejestracji publicznej. Publiczne strony informacyjne nie wyświetlają danych właściciela.</p>
<h2>Dostęp do danych Google i cele</h2>
<p>Logowanie Google używa <code>openid</code> do weryfikacji identyfikatora konta (subject) uprawnionego właściciela. Osobna zgoda dla Drive używa wyłącznie <code>openid</code> i <code>https://www.googleapis.com/auth/drive.file</code> oraz dostępu offline do wykonywania eksportów bez otwartej sesji przeglądarki. Aplikacja nie prosi o zakresy email, profile ani pełny dostęp do Dysku.</p>
<p>Integracja tworzy prywatny folder i pliki raportów Markdown, zapisuje i aktualizuje eksporty w zatwierdzonym folderze oraz odczytuje ich treść do kontroli poprawności i konfliktów. Może odczytać ręcznie zmienioną treść pliku eksportu, aby wykryć zmianę i zachować wersję użytkownika. Pobiera identyfikatory, nazwy, typy plików, foldery nadrzędne, stan kosza, wersje, daty modyfikacji, właściwości aplikacji i możliwości dostępu. Sprawdza typy i role uprawnień folderu oraz wykorzystanie i limit przestrzeni konta, aby potwierdzić prywatność i możliwość zapisu. Dostęp ograniczają uprawnienie drive.file i zatwierdzony cel eksportu.</p>
<h2>Przechowywanie i ochrona</h2>
<p>Backend działa na Cloudflare Workers, a trwałe dane w Cloudflare D1. Przechowywane są identyfikator konta Google, identyfikator klienta OAuth, zakresy i stan połączenia, identyfikatory folderów i plików, mapowania eksportów, wersje, skróty kontrolne, rozmiary i techniczne wyniki operacji. Raporty wygenerowane z danych aplikacji są przechowywane w aplikacji i wysyłane do Google Drive. Ręcznie zmieniona treść eksportu jest odczytywana do porównania; podgląd konfliktu utrwala metadane i skrót, a nie tę treść.</p>
<p>Token odświeżania jest przechowywany wyłącznie po stronie serwera, zaszyfrowany AES-256-GCM kluczem przechowywanym osobno od bazy. Token dostępu pozostaje po stronie serwera i nie jest trwale zapisywany w bazie. Tokeny nie są ujawniane w GUI, eksportach ani dowodach operacyjnych. Komunikacja z Google używa HTTPS. Prywatne kopie odzyskiwania poświadczeń i klucza są oddzielne od zwykłych kopii danych. Zwykłe kopie aplikacji zachowują metadane i raporty, ale wykluczają tabelę poświadczeń OAuth.</p>
<h2>Odbiorcy i ograniczone wykorzystanie</h2>
<p>Google przetwarza autoryzację i pliki w Drive; Cloudflare przetwarza dane jako dostawca infrastruktury backendu i bazy. Dane i prywatne kopie są dostępne uprawnionemu właścicielowi. Integracja Drive nie przekazuje pobranych danych Google dostawcom modeli AI, nie używa ich do trenowania modeli, reklamy, profilowania reklamowego ani sprzedaży. Nie publikuje plików ani nie dodaje uprawnień publicznych. Analiza źródeł YouTube jest odrębną funkcją od integracji Drive.</p>
<p>Wykorzystanie informacji otrzymanych z interfejsów Google API przez Bartosz Intelligence jest zgodne z <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, w tym wymogami Limited Use. Dane Google są wykorzystywane wyłącznie do opisanych funkcji logowania i prywatnego eksportu.</p>
<h2>Retencja, odłączenie i usuwanie</h2>
<p>Połączenie i jego dane są przechowywane podczas korzystania z integracji. W prywatnym interfejsie właściciel może wybrać „Disconnect Drive”: usuwa to lokalny zaszyfrowany token odświeżania, unieważnia oczekujące zgody i blokuje dalsze eksporty z tego połączenia. Odłączenie zachowuje dane aplikacji, metadane połączenia, mapowania oraz istniejące pliki w Google Drive. Nie cofa zgody na koncie Google i nie usuwa wcześniejszych prywatnych kopii odzyskiwania.</p>
<p>Zgodę można osobno cofnąć w <a href="https://myaccount.google.com/connections">ustawieniach połączeń konta Google</a>. Pliki i foldery usuwa się bezpośrednio w Google Drive. Właściciel zarządza usunięciem danych aplikacji oraz prywatnych kopii i poświadczeń w ramach administracji własnej instalacji. Nie ma automatycznej daty wygaśnięcia wszystkich metadanych i kopii; odłączenie nie oznacza ich całkowitego usunięcia.</p>
<h2>Strony publiczne i kontakt</h2>
<p>Te strony nie używają skryptów analitycznych, reklam ani cookies aplikacji. Dostawca hostingu obsługuje techniczne dane żądania, takie jak adres IP i nagłówki HTTP, potrzebne do dostarczenia i zabezpieczenia strony. Prywatny interfejs używa cookies sesji i zabezpieczeń autoryzacji. Pytania o integrację i prywatność można skierować na adres pomocy wyświetlany na ekranie zgody Google dla Bartosz Intelligence; nie publikujemy tutaj prywatnych danych kontaktowych właściciela.</p>
<p>Zmiany sposobu wykorzystywania danych Google wymagają aktualizacji tej polityki i uzyskania zgody przed nowym wykorzystaniem.</p>
<p><a href="/about">Bartosz Intelligence — strona informacyjna</a></p>`;

const terms = `<h1>Warunki korzystania — Bartosz Intelligence</h1>
<p>Aplikacja jest prywatnym narzędziem jednego właściciela. Dostęp do funkcji i danych jest ograniczony do autoryzowanego właściciela. Publiczne strony służą wyłącznie informacji. Integracja Google Drive wymaga świadomej zgody i wskazania prywatnego celu eksportu. Właściciel kontroluje połączenie, eksporty oraz własne pliki i kopie danych. Raporty wymagają własnej oceny; nie stanowią gwarancji poprawności źródeł.</p>
<p><a href="/about">O aplikacji</a> · <a href="/privacy">Polityka prywatności</a></p>`;

function document(title: string, content: string) {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:18px/1.65 system-ui,sans-serif;color:#17212e;background:#f8fafc;margin:0}main{max-width:780px;margin:auto;padding:48px 24px}h1{line-height:1.2;font-size:2rem}h2{font-size:1.25rem;margin-top:2rem}a{color:#164e9b}code{overflow-wrap:anywhere;font-size:.85em}nav{margin-bottom:32px}</style></head><body><main><nav><a href="/about">Bartosz Intelligence</a> · <a href="/privacy">Prywatność</a></nav>${content}</main></body></html>`;
}

export const publicPages = new Hono();
for (const [path, title, content] of [
  ['/about', 'Bartosz Intelligence', about],
  ['/privacy', 'Polityka prywatności — Bartosz Intelligence', privacy],
  ['/terms', 'Warunki korzystania — Bartosz Intelligence', terms],
]) {
  publicPages.get(path!, (c) => {
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'public, max-age=300');
    return c.html(document(title!, content!));
  });
}
