# Pobieranie transkrypcji przez istniejące API

Origin: `https://bartosz-intelligence.eagleblastmusic.workers.dev`.
Właściciel loguje się istniejącym Google OIDC. Mutacje wymagają normalnego
cookie sesji, zgodnego Origin i `X-CSRF-Token` z `__Host-bi-csrf`.
Nie przekazuje się cookies YouTube ani danych logowania do tego API.

Przykład do wykonania w zalogowanej aplikacji; wartości sesji nie są logowane:

```js
const csrf = document.cookie.split('; ').find(v => v.startsWith('__Host-bi-csrf='))?.slice('__Host-bi-csrf='.length);
const response = await fetch('/api/v1/jobs/transcript', {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
  body: JSON.stringify({ locator: 'https://www.youtube.com/watch?v=aircAruvnKk' })
});
const { item_id, job_id, state, video_id } = await response.json();
```

`locator` przyjmuje ID lub HTTPS watch/youtu.be/shorts/live/embed.
POST zwraca 201 i `{item_id,job_id,state,video_id}`. Powtórzenie ID/URL
zwraca istniejące zadanie bez duplikowania pracy. To zgłoszenie pojedynczego
filmu, bez automatycznej subskrypcji kanału. Dostępność i czas publikacji
nie są domniemywane z samego adresu.

`GET /api/v1/jobs/JOB_ID` zwraca aktualny `state`, `reason_code`, `due_at`
i liczbę prób; `GET /api/v1/jobs?task_type=FETCH_TRANSCRIPT` listuje zadania
właściciela. `PENDING/LEASED/RUNNING` oznaczają trwającą pracę,
`DEFERRED/RETRY_WAIT` — odroczenie według istniejącej polityki,
`BLOCKED/FAILED` — przyczynę wymagającą sprawdzenia.
`AUTH_REQUIRED` nie uruchamia automatycznego logowania.

Po `SUCCEEDED` odczyt nie wymaga uruchamiania AI:

```text
GET /api/v1/items/ITEM_ID/transcript?kind=source&start=0
GET /api/v1/items/ITEM_ID/transcript?kind=segments&start=0
```

Odpowiedź zawiera `descriptor` z hashem/rozmiarem/rodzajem/authority,
`chunks` i `next_index`. `source` to pełny oryginalny zdekodowany tekst,
`segments` to zaakceptowana mapa segmentów z czasami i pokryciem.
`body_base64` używa **base64url**, zgodnie z istniejącym magazynem artefaktów.
Kolejne strony pobiera się z `start=next_index` do `null`, sprawdzając
kolejność bajtów i SHA-256. Przed akceptacją transkrypcji trasa zwraca 404;
status i przyczynę sprawdza się wtedy przez GET zadania.
Inny właściciel nie odczyta zadania ani artefaktów.

`POST /api/v1/jobs/JOB_ID/replay` z pustym JSON i zwykłym CSRF ponawia
zadanie `FAILED` zgodnie z istniejącą polityką, a po normalnym ponownym
uwierzytelnieniu również ten sam `FETCH_TRANSCRIPT` zablokowany przez
`LOCAL_YTDLP_AUTH_REQUIRED`. Nie tworzy duplikatu. Nie jest
uniwersalnym odblokowaniem innych `BLOCKED`, cooldownu ani ograniczeń źródła.
Ponowne wysłanie URL nie omija tej polityki. Potrzebę ponownego
uwierzytelnienia YouTube obsługuje chroniona sesja Oracle, nie klient HTTP.

Worker korzysta z istniejących lease/fencing, RPC, pięciu zaakceptowanych
artefaktów i D1. Transport YouTube wykonuje Oracle, a nie Cloudflare
ani działający Windows. Sesja YouTube i tokeny Subs pozostają poza D1.
