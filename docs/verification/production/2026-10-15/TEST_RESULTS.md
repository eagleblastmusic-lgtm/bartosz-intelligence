# Wyniki odbioru — 15.10.2026

**DEPLOYED, E2E VERIFIED, MANUAL20 PASS.** Aktywne są dokładnie zatwierdzone
20 kanałów. Kontrolowany odbiór Free ma zapas zasobów; pełna doba, 100 filmów/dzień
i soak 24–72 h pozostają niepotwierdzone.

| Sprawdzenie produkcyjne                                                      | Wynik                                                             | Dowód                                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Worker 901e9506, 100%, dokładne bajty i bindingi, AI/DELETE OFF              | PASS                                                              | FREE_CPU_WORKER_POSTFLIGHT.json                                                   |
| Ledger 43, checksums, FK; świeży backup i izolowane odtworzenie              | PASS                                                              | MIGRATION_RESULT.json; ../../deployment/2026-10-15T11-27-41.135Z-pre-upgrade.json |
| Oracle COMPACT, active/running, restart count=0                              | PASS                                                              | POST_FREE_CPU_ORACLE_HEALTH.json                                                  |
| Rzeczywisty TED: manual en, 226 cue, pełny tekst i start/end ms, 3 artefakty | PASS                                                              | FREE_CPU_CANARY_INTEGRITY.json; REPAIR_ORACLE_CANARY_DIAGNOSTICS.json             |
| Prywatne Markdown i techniczny JSON, pełny readback/hash/restore             | PASS                                                              | FREE_CPU_CANARY_INTEGRITY.json                                                    |
| Dry-run rzeczywistego Workera, 619 chunków zachowanych, DELETE OFF           | PASS                                                              | FREE_CPU_LIVE_WORKER_DRY_RUN.json                                                 |
| Historia v1 i v2 czytelna, brak nowych ANALYZE/PROJECT                       | PASS w obserwowanym zakresie                                      | ACTUAL_LEGACY_COMPACT_API_READS.json; FINAL20_STATE.json                          |
| Ograniczony uploads fallback po wcześniejszym RSS404                         | PASS; wcześniejsze RSS UNAVAILABLE                                | REPAIR_CANARY_DISCOVERY_RESULT.json                                               |
| RSS podczas MANUAL20                                                         | PASS, 20 rzeczywistych odbiorów                                   | MANUAL20_PRODUCTION_VERIFICATION.json                                             |
| Aktywacja 19 NEW_ONLY i MANUAL20                                             | PASS 20/20, 86,773 s, błędy/duplikaty/backfill=0                  | APPROVED19_ACTIVATION_RECEIPT.json; MANUAL20_RESULT.json                          |
| Natywny SHA sam obniża CPU                                                   | NIE WYKAZANO                                                      | NATIVE_HASH_FIRST_CPU.json; NATIVE_HASH_1100_CRON_CPU.json                        |
| Cron → Queue: regularny CPU                                                  | PASS kontrolowanego odbioru, z opisanym pojedynczym RPC burstem   | RELEASE_FREE_ACCEPTANCE.json                                                      |
| Wykorzystanie Free                                                           | Bieżące wykorzystanie z zapasem; pełna doba/100 filmów UNVERIFIED | POST_MANUAL20_FREE_METRICS.json                                                   |
| Soak 24–72 h                                                                 | IN_PROGRESS, NOT_PASSED                                           | SOAK_STATUS.json; SOAK_RUNBOOK_PL.md                                              |

W ostatnim pakiecie lokalnie zweryfikowano:

- 331/331 Workers/D1 przed ostatnią poprawką rozdzielenia zegarów.
- 25/25 focused Workers po poprawce: 17 nowych regresji i 8 istniejących testów
  schedulera, control i monitoringu. 24 przypadki nakładają się z pełnym zestawem;
  łącznie 332 test instances, nie pojedynczy finalny run 332 testów.
- Warsaw/DST 7/7; pełny typecheck i build; lint/format czterech zmienionych plików;
  finalny production dry-run; niezależny review: PASS.
- Równoważność routera w 3689 przypadkach: zero różnic. Mikrobenchmark Node
  nie jest dowodem CPU Cloudflare.
- Wcześniejsze 632 unit/contracts oraz 31 Python pozostają dowodem niezmienionych
  ścieżek; nie przedstawiamy ich jako świeżo powtórzonego całego zestawu.

Dokładne hashe, lista plików i JSON runnera: FREE_CPU_CANDIDATE.json.
Kontrole 30 kanałów, Oracle backlog 10 i Drive backlog 10/30/100 są dowodami
lokalnymi; nie generowano takich dodatkowych obciążeń produkcyjnych.

Rzeczywiste pomiary ostatniej wersji: naturalne Crony 0/1 ms; 47 zwykłych RPC,
mediana 3 ms, jeden heartbeat 11 ms, pozostałe ≤10 ms. Podczas MANUAL20:
29 HTTP 1–9 ms, 16 Queue 3–18 ms, Cron 0 ms, bez wyjątków. Ręczny admin dry-run
26 ms jest osobnym ryzykiem, bez cyklicznego uruchamiania. Wszystkie wartości
przekraczające nominalny CPU pozostają jawne w dowodach.

Poprawiono lokalne błędy harnessu: fixture jobs.finished_at zastąpiono job_attempts;
w dodatkowym odbiorze RSS odróżniono historyczne coverage COMPLETE od faktycznie
zakończonej kontroli RSS. SUCCEEDED, zakończony fenced attempt i committed page
potwierdzają wykonanie. Nie zmieniano produkcji ani kryteriów akceptacji.
Ostrzeżenie pełnego lokalnego run o odrzuconej wiadomości Queue pochodzi z testu
obsługi niepowodzeń; wynik runnera 331 PASS / 0 FAIL.

FINAL20_STATE potwierdza zachowanie wszystkich 45 wcześniejszych accepted,
244 artefaktów, 616 chunków i 45 archiwów: missing=0, changed=0.

Poniżej zachowano wyniki pierwszej próby. Ich FAIL nie opisuje obecnego canary.

## Historyczny pierwszy odbiór

# Odbiór produkcyjny oraz lokalna naprawa canary — 15.10.2026

**Produkcja wdrożona; pełny E2E nieodebrany. Nie aktywowano 19 dodatkowych kanałów.**

| Sprawdzenie produkcyjne                                                             | Wynik                                                                            | Dowód                                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Świeży backup i izolowany restore/upgrade 40→43                                     | PASS                                                                             | ../../deployment/2026-10-15T01-14-12.632Z-pre-upgrade.json |
| Migracje 041–043, ledger 43, checksums, FK/quick check                              | PASS                                                                             | MIGRATION_RESULT.json                                      |
| Zachowanie wszystkich wcześniejszych accepted/artifacts/chunks/archive IDs i hashów | PASS                                                                             | MIGRATION_BASELINE.json, MIGRATION_RESULT.json             |
| Worker wersja/bindings, dokładne bajty, AI/DELETE OFF                               | PASS                                                                             | WORKER_DEPLOYMENT_REVIEW.json, WORKER_BYTE_REVIEW.json     |
| Oracle immutable package, runtime, start i concurrency=1                            | PASS                                                                             | ORACLE_DEPLOYMENT.json                                     |
| Bez sztucznej pauzy po wykonanym canary do kolejnego idle RPC                       | Obserwacja 225 ms; bez 30 s przerwy; udany backlog niezweryfikowany produkcyjnie | ORACLE_CANARY_DIAGNOSTICS.json                             |
| Rzeczywisty RSS TED                                                                 | FAIL: upstream404, retry, pages0                                                 | CANARY_DISCOVERY_RESULT.json, STAGE_B_CURRENT_STATE.json   |
| Nowy compact transcript accepted → Drive                                            | BLOCKED: UNKNOWN_SOURCE_AUTHORITY; brak artefaktów/accepted/uploadu              | CANARY_FETCH_RESULT.json, ORACLE_CANARY_DIAGNOSTICS.json   |
| Drive istniejący grant/privacy/quota/legacy readback                                | PASS                                                                             | DRIVE_RELEASE_REVIEW.json                                  |
| Nowa techniczna JSON + Markdown para                                                | NOT_RUN, ponieważ brak accepted compact                                          | STAGE_B_CURRENT_STATE.json                                 |
| Brak nowych automatycznych ANALYZE/PROJECT i DELETE OFF                             | PASS w obserwowanym oknie                                                        | STAGE_B_METRICS_REVIEW.json, STAGE_B_CURRENT_STATE.json    |
| Rzeczywisty MANUAL20                                                                | NOT_RUN; warunkowa aktywacja nadal zamknięta                                     | STAGE_B_CURRENT_STATE.json                                 |
| Free dla zdrowego nowego pełnego pipeline                                           | UNVERIFIED; bieżący częściowy usage ma zapas na mały canary                      | STAGE_B_METRICS_REVIEW.json                                |
| Soak24–72h                                                                          | NOT_STARTED                                                                      | PRODUCTION_DEPLOYMENT_REPORT_PL.md                         |

Lokalna naprawa po tych wynikach, **niewdrożona**:

| Suite                                                   | PASS | FAIL | SKIP |
| ------------------------------------------------------- | ---- | ---- | ---- |
| Vitest unit + contracts                                 | 632  | 0    | 1    |
| Vitest Workers/D1                                       | 307  | 0    | 0    |
| Python selection/broker/parser/public asset permissions | 31   | 0    | 0    |

939 unikalnych testów Vitest PASS; targeted42 jest podzbiorem. Jedyny skip dotyczy
nie-Windows gałęzi istniejącego Windows ACL helpera. Typecheck, lint11 zmienionych
plików TS, build, production dry-run, exact-byte pack i secret scan PASS.
Szczegóły, hashe rzeczywistych JSON test runnera oraz naprawione początkowe błędy
harnessu: [REPAIR_TEST_RESULTS.json](REPAIR_TEST_RESULTS.json).

Nowe regresje obejmują: RSS404/410 bounded fallback; brak fallbacku dla429/403/5xx
i parser errors; zero importu historii NEW_ONLY; staged resume bez drugiego requestu;
fencing, dedup i rzeczywisty completed receipt; dokładny video ID/defaultAudioLanguage;
zakaz zgadywania z defaultLanguage/tytułu; manual/generated, konflikty/translation;
pełny tekst oraz start/end ms; technical metadata failure nie zwiększa NO_CAPTIONS.

Do produkcyjnego zastosowania delty potrzebne jest wąskie zatwierdzenie opisane w
[REPAIR_PLAN_PL.md](REPAIR_PLAN_PL.md). Nie oznaczamy tych lokalnych wyników jako
produkcyjnego E2E, Free lub soak PASS.
