# Pobieranie transkrypcji YouTube

Przepływ: istniejący Worker API → D1 `jobs` → Oracle `LocalTranscriptWorker` → lokalny broker procesu → istniejący `mweb` + świeży token Subs → walidacja i artefakty D1 → odczyt właściciela przez API.

## Wywołanie produkcyjne

W zalogowanej karcie aplikacji można wykonać w konsoli przeglądarki poniższy kod. Korzysta z istniejącej sesji aplikacji i mechanizmu CSRF; nie używa sesji Google/YouTube przeglądarki do pobierania napisów.

```js
const csrf = decodeURIComponent(
  document.cookie
    .split('; ')
    .find((v) => v.startsWith('__Host-bi-csrf='))
    ?.split('=')[1] ?? '',
);
if (!csrf) throw new Error('Zaloguj się do aplikacji');
const response = await fetch('/api/v1/jobs/transcript', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
  body: JSON.stringify({ locator: 'https://youtu.be/aircAruvnKk' }),
});
if (!response.ok) throw new Error('HTTP ' + response.status);
const job = await response.json();
// Odczyt statusu; pobranie wykona Oracle niezależnie od tej karty.
const state = await (await fetch('/api/v1/jobs/' + job.job_id)).json();
```

Kontrakt HTTP, dla klienta posiadającego istniejącą sesję właściciela i jej token CSRF:

```http
POST /api/v1/jobs/transcript
Content-Type: application/json
Origin: <origin aplikacji>
X-CSRF-Token: <token bieżącej sesji aplikacji>

{"locator":"https://www.youtube.com/watch?v=aircAruvnKk"}
```

Odpowiedź 201: `video_id`, `item_id`, `job_id`, `state`. Można przekazać samo ID, URL `watch`, `youtu.be`, `shorts`, `live` lub `embed`. Powtórzenie tego samego zgłoszenia zwraca istniejące zadanie danego właściciela. Nie tworzy subskrypcji kanału.

- `GET /api/v1/jobs/JOB_ID` — stan, `reason_code`, liczba prób i terminy.
- `GET /api/v1/items/ITEM_ID/transcript?kind=source&start=0` — oryginalny tekst po dekodowaniu napisów.
- `GET /api/v1/items/ITEM_ID/transcript?kind=segments&start=0` — mapa segmentów, tekstów i czasów.

Odczyt jest dostępny po `SUCCEEDED`, bez uruchamiania analizy AI. Odpowiedź zawiera deskryptor, pochodzenie, język, `MANUAL` / `GENERATED` i porcje `body_base64` w kodowaniu base64url. Należy dekodować porcje do bajtów, łączyć w kolejności `byte_start` i pobierać kolejne strony przez `next_index` aż do `null`. `content_hash` jest SHA-256 całego artefaktu; każdy fragment ma własny hash. Mapa `coverage` przechowuje indeks, czas początku/końca i zakres tekstu każdego otrzymanego cue; offsety są jednostkami UTF-16. `complete` opisuje pokrycie otrzymanego tekstu przez normalizator, nie niezależne potwierdzenie kompletności filmu.

## Błędy i wznowienie

Sesja YouTube znajduje się tylko na Oracle, w `/home/bartosz-browser-runtime/youtube-session/youtube.cookies`, katalog 0700, plik 0600. Executor nie odczytuje jej wartości. Broker akceptuje wyłącznie lokalny UID wykonawcy i określone operacje transkrypcji, bez dowolnych poleceń. Kopia robocza sesji i token Subs są usuwane po zadaniu; token powstaje ponownie dla każdego filmu. Udane pobranie może bezpiecznie zaktualizować zachowaną sesję.

`BLOCKED` z `LOCAL_YTDLP_AUTH_REQUIRED` oznacza konieczność normalnego ponownego uwierzytelnienia. Nie ma automatycznego wpisywania hasła ani nieskończonych prób logowania. Po przywróceniu sesji właściciel może wykonać `POST /api/v1/jobs/JOB_ID/replay`, body `{}`, z istniejącymi nagłówkami sesji i CSRF. Wznawia to ten sam rekord; inne blokady dostępu pozostają zablokowane. Błędy transportu korzystają z istniejących ograniczonych ponowień i odzyskiwania dzierżaw. API i pozostałe rodzaje zadań pozostają dostępne przy utracie sesji YouTube.

## Uruchomienie i ograniczenia

Jednostki `bartosz-executor.service` i `bartosz-caption-broker.service` są aktywne i włączone przy starcie Oracle od 14 października 2026. Definicje znajdują się w `tools/deployment/oracle/`; konfiguracja produkcyjna to chroniony `/etc/bartosz-executor/executor.env`. Systemd uruchamia usługi po restarcie hosta; produkcyjne pobranie po restarcie executora sprawdzono bez Windows. Zadanie źródłowe nadal ma 768 MiB, CPUQuota 50%, swap 0, concurrency 1. Koordynator ma osobny limit 384 MiB i heap Node 192 MiB; nie wykonuje pobierania poza chronionym zadaniem źródłowym. Stan usług sprawdza `sudo systemctl status bartosz-executor bartosz-caption-broker`.

W repozytorium nie przechowujemy sekretów. Plik konfiguracji wykonawcy należy utworzyć poza repozytorium z minimalnymi uprawnieniami; poświadczenie ma wyłącznie scope `FETCH_TRANSCRIPT`. Produkcyjny executor nie otrzymuje tokenu Cloudflare ani danych logowania Google.

Końcowa zgoda produkcyjna została wykonana: D1 ma 40/40 migracji, API jest wdrożone, a zadania `FETCH_TRANSCRIPT` obsługuje wyłącznie `oracle-frankfurt-transcript-1`. Wyniki dwóch rzeczywistych produkcyjnych pobrań, restartu i kontroli D1 opisuje [raport końcowy](../verification/oracle/2026-10-14/production-deployment/FINAL_REPORT_PL.md). Skrypty `e2e-driver.py` / `e2e-api.ts` nadal służą wyłącznie lokalnemu emulatorowi. Osobny `e2e-production-api.ts` sprawdza istniejące produkcyjne API; jego tymczasową sesję właściciela po odbiorze unieważniono.

## Koszty i obserwacja sesji

Nie dodano płatnej usługi ani zasobu. [Cloudflare D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) obejmuje 5 mln odczytanych wierszy i 100 tys. zapisanych wierszy dziennie oraz 5 GB łącznie; przekroczenie limitu Free blokuje zapytania. [Workers Free](https://developers.cloudflare.com/workers/platform/limits/) ma własne limity żądań i czasu CPU. Nie deklarujemy nieograniczonej przepustowości ani zmiany planu rozliczeń istniejącego konta. Istniejące mechanizmy obsługują odmowę z powodu dziennego limitu D1. Korzystamy z istniejącej maszyny [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), bez zwiększania jej konfiguracji.

Długoterminowa ważność sesji pozostaje obserwacją, nie gwarancją. Po wdrożeniu wystarczą pojedyncze normalne zadania po 24 i 72 godzinach, z potwierdzeniem braku ponownego importu. Nie uruchomiono dodatkowego ciągłego monitora ani nieograniczonych zapytań testowych.
