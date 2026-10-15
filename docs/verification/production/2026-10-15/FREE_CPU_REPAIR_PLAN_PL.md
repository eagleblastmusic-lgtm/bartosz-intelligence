# Poprawka regularnego CPU — plan do osobnego GO

Stan: kandydat lokalny, niewdrożony. Aktualny Worker to
`6b6a7844-e1f9-48a3-b70e-299b6d98cd90`. Canary TED i dokładny readback Drive: PASS.
Tylko TED aktywny; pozostałe 19 oraz MANUAL20 oczekują odbioru Free.

## Przyczyna i najmniejsza zmiana

Natywny SHA-256 został wdrożony zgodnie z osobnym GO, ale nie wykazano poprawy CPU.
Naturalny Cron nadal wykonywał maintenance w budżecie 10 ms: rzeczywiste próbki
22 i 11 ms. Istniejący consumer Queue ma odrębny domyślny budżet CPU 30 s,
również na Free. Nie potrzebujemy nowej kolejki, usługi ani płatnego planu.

1. `apps/api/src/index.ts`: Cron wysyła jeden `CONTROL_MAINTENANCE` do tej samej
   trwałej Queue. Cron nie wykonuje SQL. Dotychczasowe hinty Drive/Daily/archive
   i warunek DELETE OFF pozostają zachowane.
2. `apps/api/src/queue.ts`, `scheduled.ts`: consumer weryfikuje aktualne uprawnienia
   DISCOVER/RECONCILE i uruchamia tę samą ograniczoną funkcję maintenance.
   Oryginalny `scheduled_at` identyfikuje slot Warsaw/DST; aktualny czas konsumenta
   służy recovery i receipts ukończenia. D1 nadal odpowiada za deduplikację,
   postęp i odtwarzanie utraconych hintów. Bez samonapędzającej się pętli.
3. `index.ts`: jawny `TrieRouter` zamiast próby `RegExpRouter` i późniejszego
   automatycznego fallbacku do tego samego TrieRouter. Lokalna zgodność rzeczywistej
   tabeli 201 handlerów: 3689 przypadków, zero różnic. Lokalny cold p95
   1,398→0,659 ms jest mikrobenchmarkiem Node, a nie pomiarem CPU Cloudflare.
4. `tests/workers/cron-maintenance-queue.spec.ts`: regresje uprawnień, kolejki,
   deduplikacji, replay, dwóch zegarów, braku SQL w Cron i flag AI/DELETE.

Dokładne pliki, hashe pakietu i aktualne wyniki lokalne: `FREE_CPU_CANDIDATE.json`.
Nie zmieniamy migracji, Oracle, providera, sesji YouTube, tekstu, cue, formatów,
hashy archiwum, ograniczeń concurrency ani konfiguracji produkcyjnej.

## Zużycie i ograniczenia dowodów

Odczyt konta do 11:04 UTC: 5798 requests, 1 031 874 D1 reads, 6965 writes,
827 Queue operations, backlog0, runtime errors0. To część doby wdrożeniowej.
Dodatkowy maintenance: 288 małych wiadomości/dobę × 3 operacje = szacowane
864 operacje/dobę bez retry; 8,64% puli Queue Free. Nawet po konserwatywnym
zarezerwowaniu całych 864 wobec już zmierzonych 827 pozostaje 8309/10000 operacji.
Nie jest to pomiar pełnego cyklu20 ani dowód kosztu 100 filmów/dzień.

Cloudflare dopuszcza sporadyczne przekroczenia nominalnego CPU, bez gwarantowanej
wielkości/częstotliwości. Aktualne zwykłe RPC miały 4 przekroczenia na 34 próbki,
max32 ms; oba Crony przekroczyły10 ms. Nie opieramy procesu cyklicznego na burstach.
Ręczny endpoint payload-dry-run36 ms jest osobnym ryzykiem administracyjnym;
nie stanowi zależności normalnej archiwizacji i nie będzie uruchamiany cyklicznie.
Wszystkie te próbki zakończyły się `ok`, co samo nie daje Free PASS.

Źródła: [Workers CPU](https://developers.cloudflare.com/workers/platform/limits/#cpu-time),
[Queue limits](https://developers.cloudflare.com/queues/platform/limits/),
[Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/).
Aktualne pomiary: `POST_NATIVE_METRICS_REVIEW.json`, `NATIVE_HASH_FIRST_CPU.json`,
`NATIVE_HASH_1100_CRON_CPU.json`, `NATIVE_HASH_1105_CRON_CPU.json`.

## Dokładne operacje po GO

1. Sprawdzić bieżącą wersję100%, ledger43/checksums, brak aktywnego FETCH,
   DELETE0, nadal jeden aktywny kanał i hashe wszystkich wejść pakietu.
   Sprawdzić świeży backup z izolowanym restore; odświeżyć, jeśli starszy niż1 h.
2. Wdrożyć wyłącznie ten kompatybilny Worker. Potwierdzić dokładne bajty,
   bindingi, sloty15/23 Warsaw, AI OFF, DELETE OFF, Queue batch/concurrency1.
3. Zebrać dwa naturalne Crony z dokładnej wersji i zwykłe Oracle RPC.
   Cron CPU ≤10 ms, maintenance rzeczywiście w Queue; Queue CPU <30000 ms,
   bez wyjątków, exceededCpu lub narastającego backlogu. Zwykłe RPC odnieść do10 ms;
   powtarzające się przekroczenie regularnej ścieżki wymaga dalszej diagnozy.
   Sporadyczny burst raportować oddzielnie, bez automatycznego PASS ani FAIL całości.
4. Potwierdzić ten sam istniejący canary i historię przez rzeczywisty readback,
   bez nowego pobrania YouTube ani uploadu Drive. Sesję testowego właściciela odwołać.
5. Dopiero pełny odbiór danych i bezpiecznego wykorzystania Free otwiera wcześniej
   zatwierdzoną aktywację dokładnie19 kanałów NEW_ONLY oraz natychmiastowy MANUAL20.
   Potwierdzić faktyczne zakończenie20 kontroli i ponownie zmierzyć zużycie.
   Bez historycznego backfillu. Harmonogram pozostaje15/23 Europe/Warsaw.

Jeśli poprawka nie przejdzie odbioru, zatrzymać aktywację19; zachować dowody
i przedstawić konkretną przyczynę. Ten plan nie gwarantuje z góry CPU ani Free PASS.

## Rollback i granica zgody

Zachować bieżący pakiet `6b6a7844…`, zgodny z compact v2 i wersjami Drive.
Rollback przywraca tę wersję Workera bez cofania migracji ani nadpisywania D1.
Stary consumer może odrzucić nowy hint maintenance; trwałe D1 i kolejny Cron
odtworzą potrzebną pracę. Nie usuwać wyników ani zmieniać Oracle/sesji.

Wcześniejszy auto-review odrzucił rozszerzenie deploymentu bez wyraźnego GO;
został rozwiązany osobnym GO wyłącznie na natywny SHA, a tamto wdrożenie zakończono.
Niniejsza zmiana Cron/router wymaga nowego, jednoznacznego GO przed deployem.
Bez migracji, nowych płatnych zasobów, DELETE, nowych pobrań canary, commit/push/merge.
