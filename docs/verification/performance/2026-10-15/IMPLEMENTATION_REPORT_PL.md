# Implementacja uproszczenia pipeline — 2026-10-15

Praca rozpoczęta 2026-10-14, zakończenie i odbiór lokalny 2026-10-15, Europe/Warsaw.
Gałąź: `codex/remote-daily-reports`. Początkowy HEAD:
`ea15d283fe9097edb7deae152170f0fd86d4d527`.
Na wejściu nie było zmian śledzonego kodu; zastane nieśledzone raporty, backupy
i narzędzia pozostawiono. Wykorzystano wcześniejszy audyt. Nie wykonano commita,
push, merge, deployu, migracji produkcyjnej, produkcyjnych uploadów ani DELETE.

## 1. Wykonana zmiana

Pozostaje Oracle → Cloudflare → D1 → Drive. Nowe napisy przechodzą przez
wersjonowane zatwierdzenie `transcript-source:2`: RAW, SOURCE_ORIGINAL i mały
`caption-coverage:1`. Nie powstają automatyczne ANALYZE ani PROJECT. ChatGPT
nadal korzysta z czytelnych dokumentów Drive. Stare źródła, wyniki, accepted
IDs, hashe, manifesty i zaawansowane funkcje legacy pozostają obsługiwane.

Główne pliki:

| Obszar                | Pliki                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Oracle                | `apps/executor/src/cycle-loop.ts`, `local-worker.ts`, `worker-rpc.ts`, `artifact-client.ts`, `oracle-runtime.ts`; `tools/executor/run-oracle.ts`                                                                         |
| Monitoring            | `packages/core/src/sources/youtube/cycles.ts`, `reconcile.ts`, `discovery.ts`, `rss.ts`; `apps/api/src/scheduled.ts`, `queue.ts`, `control.ts` (reuse)                                                                   |
| Retry                 | `packages/core/src/transcript/recovery.ts`, `intake.ts`; `packages/core/src/jobs/store.ts`, `recovery.ts`; `apps/api/src/routes/jobs.ts`, `workers.ts`                                                                   |
| Reprezentacja         | `apps/executor/src/transcript-runner.ts`; `packages/core/src/transcript/acceptance.ts`; `packages/core/src/daily/enrollment.ts`; `packages/core/src/jobs/acceptance.ts`                                                  |
| Drive                 | `packages/core/src/transcript/archive.ts`, `payload-archive.ts`; `packages/core/src/daily/workflow.ts`, `drive.ts`; `packages/core/src/drive/client.ts`; `apps/api/src/drive-export.ts`, `daily-workflow.ts`, `index.ts` |
| Odczyt i retencja     | `packages/core/src/artifacts/store.ts`, `retention/payload-eviction.ts`; `apps/api/src/artifact-repository.ts`, `routes/items.ts`, `routes/system.ts`                                                                    |
| UI                    | `apps/web/src/features/daily.tsx`, `system.tsx`, `app/status.ts`; `packages/core/src/projections/daily.ts`; `apps/api/src/routes/sources.ts`                                                                             |
| Schemat i recovery    | migracje `041_monitoring_cycles.sql`, `042_caption_retry.sql`, `043_transcript_payload_archive.sql`; `db/migration-ledger.json`; `packages/core/src/backup/snapshot.ts`, `restore.ts`                                    |
| Konfiguracja i dowody | oba `apps/api/wrangler*`; `tools/performance/benchmark-pipeline.ts`; nowe testy cykli, retry i pipeline; istniejące testy rozszerzone; `TEST_RESULTS.md`, `BENCHMARK_MODEL.json`                                         |

Pełny wykaz zmian jest w `FILE_INVENTORY.txt`. Nie zmieniono silnika mweb,
trwałej sesji YouTube, Subs Proof-of-Origin ani konfiguracji sesji produkcyjnej.

## 2. Scheduler: 15:00 i 23:00 Warsaw

`MONITORING_SLOTS=15:00,23:00`. IANA `Europe/Warsaw` wyznacza datę i godzinę;
testy obejmują 29 marca i 25 października 2026. Nie ma stałego przesunięcia UTC.
Zmiana na `23:00` wymaga wyłącznie konfiguracji; **nie została włączona**.

Cykl ma unikalny klucz owner/data/slot, trwałą migawkę aktywnych źródeł,
cursor i liczniki w `monitoring_cycles`. Enrollment tworzy pięć kontroli przez
trzy set-based zapisy i CAS w jednej transakcji. Queue uruchamia następne
porcje oraz rzeczywiste skany, bez przesuwania czasu o pięć minut. D1 lease,
fencing i staged pages pozostają autorytatywne. Duplikaty triggerów i wiadomości
nie powtarzają zatwierdzonych efektów.

`COMPLETE` wymaga rzeczywiście zatwierdzonej strony i SUCCEEDED dla każdego
członka. Trwały retry nie oznacza zakończenia; terminalny błąd daje `FAILED`
z licznikiem błędów. Widok System i `/sources/monitoring-cycles` pokazują postęp.
RSS pozostaje kontrolą ostatnich publikacji, nie dowodem pełnego backfillu.
Dotychczasowe FULL/WEEKLY recovery korzysta z osobnych, ograniczonych
kontynuacji `SOURCE_RECOVERY`, bez dodatkowego RSS co pół godziny.

Maintenance Cron `*/5 * * * *` zostaje dla recovery. Może odtworzyć utracony
sygnał/cursor. W zdrowym przebiegu nie stanowi przerwy między kontrolami.
Awaria/utrata Queue hintu może opóźnić wznowienie do kolejnego maintenance;
to granica mechanizmu recovery, nie rytm normalnego wykonania.

## 3. Oracle i próby napisów

Po wykonanym zadaniu pętla natychmiast pobiera następne: dodatkowy sleep 0 ms,
`concurrency=1`. Pusta kolejka czeka 30 s. Błędy RPC zachowują 30/60/120 s
backoff, HTTP Retry-After oraz przerwę do resetu UTC dla limitu D1. Wynik
techniczny dostawcy ma jawny cooldown, nie udaje pustej kolejki. IP/parser
i rate-limit circuits pozostają współdzielone między zadaniami. Retry zapisu
chunków jest idempotentne, ograniczone i respektuje Retry-After także przy 429.

Terminy dostępności: `discovered_at+10 min`, `+1 h`, `+10 h`. Pierwszy termin
obowiązuje także po odtworzeniu brakującego intentu. Oracle promuje należne
DEFERRED/RETRY_WAIT podczas pull, więc nie czeka na pięciominutowy sweeper.
Potwierdzone NO_CAPTIONS są liczone oddzielnie od błędów technicznych.
Trzeci potwierdzony brak daje `LOCAL_YTDLP_NO_CAPTIONS_FINAL` i widoczny status
„Brak dostępnych napisów”. Nie ma dalszych automatycznych prób dostępności.
Przycisk „Sprawdź ponownie” zeruje epokę licznika poprzez dwa małe pola jobs;
historia prób pozostaje nienaruszona. Ręczne sprawdzenie zaczyna się od razu.

## 4. Archiwizacja bez przerw pięciominutowych

Zatwierdzenie źródła rejestruje trwały intent archiwum i wysyła Queue hint.
Każdy tick obsługuje najwyżej jeden materiał; po sukcesie następne gotowe
materiały wywołują kolejne krótkie invocation. Pusty backlog nie tworzy serii
komunikatów. Globalny Drive quota hold zatrzymuje transfery do właściwego retry.
Reserved IDs, readback hash/version, prywatność, lease i fencing pozostają.

Ciężki upload/render nie wykonuje się we wspólnym Cron invocation. Cron
wysyła ograniczone hints. Daily rozdziela tworzenie folderów, przygotowanie
immutable JSON i publikację Markdown, gdy jest to potrzebne dla limitu SQL.
Każdy etap ma trwały stan; kolejny etap rusza przez Queue, bez sleep.
Import raportów ChatGPT i dotychczasowe `_manifest.md` mają osobne wywołanie.
Nie wykonywano ponownych testów podstawowej możliwości czytania Drive przez ChatGPT.

## 5. AI i artefakty

`AUTOMATIC_AI_ENABLED=false` blokuje automatic scheduling i leasing historycznych
automatycznych ANALYZE. Zatwierdzenie transkrypcji nie tworzy PROJECT. Pozostałe
projekcje historycznych wyników/normalizacji działają według dawnych kontraktów.

Nowe źródło ma trzy istniejące typy artefaktów:

- RAW: dokładny odebrany payload, hash i możliwość odtworzenia wejścia parsera.
- SOURCE_ORIGINAL: cały oryginalny tekst cue połączonych LF; bez tłumaczenia,
  skracania, parafrazy i usuwania powtórzeń.
- `caption-coverage:1`: kolejność/upstream index, przedziały tekstu oraz dokładne
  start/end ms. Zachowane manual/generated, język, pochodzenie i niekompletność.

Nie powstają NORMALIZED, pełny manifest normalizatora ani OFFSET_MAP.
Trzy artefakty są świadomym etapem uproszczenia: RAW pozostaje potrzebny do
bezstratnego recovery; nie kopiuje się sześciu historycznych artefaktów.
Źródło PARTIAL jest zapisywane z prawdziwym statusem i brakami, bez dopisywania tekstu.

`BARTOSZ_TRANSCRIPT_REPRESENTATION=LEGACY` przywraca przygotowywanie starej
reprezentacji dla nowych pozyskań. Nie włącza AI. Stare źródła nadal obsługują
dotychczasowe korekty i dokładne kontrakty AI. Te zaawansowane funkcje nie są
automatycznie materializowane dla nowych źródeł compact; wymagają osobnego
pozyskania/normalizacji w trybie legacy. Historycznych danych nie renormalizowano.

## 6. D1, exact archive i payload-only eviction

D1 przechowuje metadane, source/accepted IDs, hashe, reprezentacje, historię
zadań, deduplikację, postęp cykli i małe receipts. Chunks trzech artefaktów
pozostają lokalnie, bo **produkcyjne kasowanie jest wyłączone**.

Immutable JSON `transcript-payload:1` na Drive przechowuje trzy dokładne
artefakty z oryginalnymi nagłówkami, chunk boundaries, byte hashes i źródłem
filmu/kanału. Zapis używa istniejącego DriveClient i stałego ID.
Identyfikator kanału nieustalony przy ręcznym video intake pozostaje NULL;
nie jest zastępowany identyfikatorem filmu. Czytelny
Markdown zachowuje dawną postać. JSON umożliwia dokładny rollback, którego
sam Markdown nie zapewnia dla RAW i historycznych chunk IDs.

Resolver używa lokalnych chunków, a gdy ich brak — zweryfikowanego JSON Drive.
Sprawdza owner, powiązanie artefaktu, prywatność, wersję i hash; zwraca te same
chunks i API paging. Brak Drive jest błędem technicznym, nigdy pustym sukcesem.
Odczyt zastępczy jest podłączony do owner transcript API i worker artifact API.
Legacy AI nie korzysta z usuwanych compact danych, a aktywne zadania blokują eviction.

Nowy mechanizm nie usuwa rekordów filmu, artefaktów, wyników, accepted outcomes,
reprezentacji, historii ani deduplikacji. Nie używa siedmiodniowego TTL.
Dry-run: owner/CSRF POST `/api/v1/system/retention/payload-dry-run` z
`source_artifact_id`. Przed kandydaturą wykonuje świeży pełny readback JSON
i Markdown. W lokalnym eksperymencie delete wymaga dodatkowo istniejącego
`deletion_enabled=1`, `approval_reference`, braku aktywnych konsumentów,
backup barrier i atomowego permitu. Jedna transakcja usuwa najwyżej 25 chunków.
Wyścig nowego konsumenta z verify/delete jest testowany.

Nie ma produkcyjnego endpointu kasowania ani automatycznego wywołania nowego
eviction. `RETENTION_DELETION_ENABLED=false` dodatkowo blokuje legacy cleanup.
Backup inventory obejmuje nowe tabele, odtwarza stare kolumny z bezpiecznymi
domyślnymi wartościami i zeruje permits/deletion approvals przy restore.

## 7. Pomiary i scenariusze

`BENCHMARK_MODEL.json` rozdziela replay, pomiary lokalne i estymacje.
`BACKLOG_BENCHMARKS.json` zawiera metryki rzeczywistych lokalnych D1/Drive mocks.

| Wejście                | Stare payloady / chunks / artifact RPC | Nowe payloady / chunks / artifact RPC |
| ---------------------- | -------------------------------------: | ------------------------------------: |
| Zachowana próbka TED   |                    269 294 B / 12 / 30 |                     64 595 B / 4 / 11 |
| Zachowana druga próbka |                    347 702 B / 13 / 32 |                     90 268 B / 4 / 11 |
| Syntetyczne 180 min    |              19 895 044 B / 610 / 1226 |               3 363 706 B / 104 / 211 |

To bieżący replay kodu, nie powtórne pozyskanie z YouTube. Jeden końcowy LF
pliku diagnostycznego pominięto zgodnie z parametrami wcześniejszego audytu.
RPC w tabeli to begin/write/verify artefaktów; control RPC i heartbeat są osobne.

| Gotowe materiały | Lokalny drain archiwum | D1 reads | D1 writes | Maks. SQL/tick |
| ---------------: | ---------------------: | -------: | --------: | -------------: |
|               10 |                1,175 s |     1023 |       110 |             38 |
|               30 |                2,975 s |     3373 |       330 |             38 |
|              100 |               10,754 s |   14 748 |      1100 |             38 |

Wartości dotyczą izolowanego przebiegu po przygotowaniu fixture, bez sieci
Google i OAuth. Nie obejmują wcześniejszego zapisu źródła. W pierwszej wersji
lokalnej serii 100 było 164 374 reads; rejestracja intentu przy acceptance
usunęła powtarzane skanowanie historii. Długi test zachował 10 800 cue:
4,140 s lokalnego wall, 35 SQL, 239 reads, 11 writes, 15 mock Drive requests.
To osobna syntetyczna treść od profilu 180 min w replay, więc rozmiary są inne.

| Filmy/dzień | Krótkie: artifact RPC/dzień | Długie: artifact RPC/dzień | Krótkie: bufor peak base64 MiB | Długie: bufor peak base64 MiB | Drive GB/30 dni: krótkie / długie |
| ----------: | --------------------------: | -------------------------: | -----------------------------: | ----------------------------: | --------------------------------: |
|           3 |                          33 |                        633 |                           0,25 |                         12,83 |                     0,011 / 0,530 |
|           9 |                          99 |                       1899 |                           0,74 |                         38,49 |                     0,032 / 1,589 |
|          30 |                         330 |                       6330 |                           2,46 |                        128,32 |                     0,105 / 5,295 |
|         100 |                        1100 |                     21 100 |                           8,21 |                        427,72 |                    0,351 / 17,650 |

Estymacje używają TED / syntetycznych 180 min oraz jawnego narzutu JSON.
Bufor zakłada jednoczesny backlog wszystkich filmów; nie jest rozmiarem całej
bazy. Model nie zakłada włączonego eviction. Indeksy, metadane i historia
dodatkowo zajmują D1. Przy 100 długich filmach dziennie wzrost Drive przekracza
nawet pełną darmową pulę 15 GB w 30 dni — ten skrajny model nie jest trwałym
wariantem 0 PLN bez innej polityki ilości/retencji i osobnej decyzji właściciela.

Usunięty celowy delay Oracle to `(N-1)×30 s`, a archiwum `(N-1)×5 min`.
Przy 100 materiałach znika odpowiednio 49,5 min i 495 min sztucznego oczekiwania.
Model 29 s/zadanie daje 48,3 min drain dla 100; to hipoteza oparta na historycznych
krótkich pozyskaniach, nie zmierzony Oracle backlog ani gwarancja dla długich filmów.

## 8. Diagnostyka

Istniejące logi workera zawierają detected/fetch-start, list/fetch+parse,
normalization, artifact-upload, czas cyklu, liczbę RPC i bajty żądań. Log archiwum
zawiera archive-wait, upload, verify oraz detected→verified. D1 timestamps,
job attempts, receipts i liczniki kolejki pozostają źródłem backlogu.
Nie ma dodatkowych dużych rekordów diagnostycznych. Nie loguje się tokenów,
cookies ani treści transkrypcji. Python/provider łączy fetch z parsowaniem;
ich osobne czasy nie są obecnie rozdzielone. CPU i memory Node replay nie są
CPU/memory rozliczanymi przez Workers.

## 9. Testy, ograniczenia i Free

Dokładne bieżące wyniki: `TEST_RESULTS.md`. Nie użyto 41 testów poprzedniego
audytu jako dowodu nowej implementacji. Naprawiono rzeczywiste regresje oraz
niekompletną fixture; nie podniesiono SQL limitów, timeoutów ani progów odbioru.
Pełne zestawy są uruchamiane z ograniczoną równoległością harnessu, aby nie
konkurowały o CPU z dużymi testami backupu.

**Free: UNVERIFIED.** Oficjalne limity sprawdzono: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
(5 mln reads i 100 tys. writes/dzień), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
(50 queries/invocation Free), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
(100 tys. requests/dzień, 128 MB, 10 ms HTTP/Cron CPU),
[Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
(osobny budżet consumer CPU; domyślnie 30 s), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
(10 tys. operacji/dzień; typowo trzy/wiadomość). Dane lokalne nie potwierdzają
całego konta ani produkcyjnego CPU. [Drive](https://support.google.com/drive/answer/6374270)
dzieli 15 GB z Gmail/Photos; aktualnej wolnej przestrzeni nie odczytywano.

Model minimum requests dla 100 wynosi ok. 2460 (krótkie) / 22 460 (długie)
przed dodatkowymi maintenance hints, report workflow, backfill, UI, OAuth,
retry i backupami. Same 100 wiadomości archiwum to ok. 300 Queue operations;
idle maintenance i Daily zwiększają ten wynik. Rows meta z lokalnego D1 są
wynikami harnessu, nie fakturą konta Cloudflare. Free storage i globalne
indeksy wymagają oceny z aktualnym rozmiarem produkcji. Nie aktywowano płatnych usług.

## 10. Instrukcja wdrożenia — tylko po osobnym zleceniu

1. Zachować świeży backup, rollback Worker version oraz bieżącą wersję Oracle.
   Zweryfikować konto/Drive capacity i produkcyjne metryki CPU/rows dla próbki.
2. W istniejącym procesie D1 zastosować addytywne migracje 041 → 042 → 043.
   Najpierw schemat i kompatybilny API, dopiero potem nowy executor.
3. Zbudować i wdrożyć zgodnie z istniejącym procesem Cloudflare. Zachować
   `MONITORING_SLOTS=15:00,23:00`, `AUTOMATIC_AI_ENABLED=false`,
   `RETENTION_DELETION_ENABLED=false`, `max_batch_size=1`, `max_concurrency=1`.
   Credentials CONTROL muszą mieć DISCOVER/RECONCILE, exporter DRIVE_EXPORT.
4. Wdrożyć kod Oracle bez zmiany sesji/yt-dlp/PoToken; zachować concurrency=1.
   Reprezentacja domyślnie COMPACT. Nie przenosić OAuth na Oracle.
5. Kontrolowany odbiór: jeden cykl, próbka źródła i readback obu plików,
   brak ANALYZE/PROJECT, widoczny postęp, metryki realnych limitów.
   Nie wykonywać produkcyjnego testu obciążenia 100 materiałów bez osobnego zakresu.
6. Kasowanie pozostaje OFF. Ewentualne włączenie nowego eviction jest odrębną
   decyzją po odbiorze dry-run/readback/restore i aktualnych konsumentów.

## 11. Rollback

Operacyjnie zatrzymać nowy executor, ustawić
`BARTOSZ_TRANSCRIPT_REPRESENTATION=LEGACY` i uruchomić kompatybilny kod ponownie.
Zachować addytywny schemat i API czytające obie wersje. Wyłączenie AI i deletion
pozostaje. Po eviction lokalny admin może wykonać `PayloadEviction.restore`
z VERIFIED immutable JSON; test potwierdza dokładne odtworzenie chunków.

Nie cofać w ciemno Workera do wersji sprzed obsługi `transcript-source:2`:
taka wersja nie pokaże nowych źródeł w dawnym transcript API. Nie usuwać migracji,
JSON ani metadanych. Pełny powrót do starego backupu wymaga izolowanego restore
i osobnego zatwierdzenia ewentualnej zamiany produkcji; nie nadpisywać nowych danych.
Dokumenty Drive pozostają dostępne w dotychczasowym procesie ChatGPT.

## 12. Czynności wymagające osobnej zgody

Deploy Cloudflare/Oracle, migracje D1 na produkcji, produkcyjne transfery testowe,
zmiany sesji YouTube, push/commit/merge, włączenie kasowania i każdy produkcyjny
DELETE, pełna zamiana bazy/rollback destrukcyjny, płatne zasoby oraz zmiana na
jeden slot dziennie. W tym zadaniu wykonano wyłącznie implementację i odbiór lokalny.
