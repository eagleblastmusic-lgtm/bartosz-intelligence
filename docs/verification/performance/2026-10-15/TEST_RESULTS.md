# Wyniki odbioru lokalnego — 2026-10-15

**917 testów PASS: 627 unit/contract + 290 Workers/D1/failure/security.**
Po końcowej korekcie NULL dla nieustalonego kanału dodatkowo przeszły dwa
celowane testy exact readback/eviction/rollback i wyścigu konsumenta oraz API typecheck.
Nie doliczono tych powtórzeń do 917 unikalnych przypadków.
Nowy kod, po wszystkich naprawach. Nie są to wyniki 41 testów wcześniejszego audytu.
Środowisko: Windows x64, Node 24.21.0, pnpm 12.9.1, Vitest 4.1.11,
lokalny workerd/Miniflare i izolowany D1 po 43 migracjach. Drive i YouTube
w testach integracyjnych są kontrolowanymi mockami/fixtures. Zero produkcyjnych
deployów, migracji, transferów i DELETE.

## Zestawy i wymagane checki

Końcowy bundle z `wrangler.production.json` również przeszedł **--dry-run**:
`PRODUCTION_CONFIG_DRY_RUN.log`. Nie wykonano produkcyjnego deployu.

| Weryfikacja                                 | Wynik                       | Dowód                                                                                |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| Unit + contract                             | PASS, 627/627               | `TEST_EVIDENCE.json`, per-file counts i hash surowego wyniku                         |
| Workers + D1 + failure + security           | PASS, 290/290               | `TEST_EVIDENCE.json`                                                                 |
| Pełny `pnpm typecheck`                      | PASS                        | `TYPECHECK.log`; wszystkie pakiety, tools oraz tests/workers                         |
| ESLint apps/packages/tools/tests            | PASS, 0 errors / 0 warnings | `TEST_EVIDENCE.json`                                                                 |
| `pnpm build`                                | PASS                        | `BUILD.log`; frontend, API Wrangler **--dry-run**, contracts/core/telemetry          |
| Migracje                                    | PASS, 43                    | `MIGRATIONS.json`; checksums/order, fresh install, independent restore, FK/integrity |
| `verify:config`                             | PASS, paid services OFF     | `CONFIG.json`                                                                        |
| Format zmienionych plików / diff whitespace | PASS                        | Prettier i `git diff --check`                                                        |

## Wymagania funkcjonalne

| Przypadek                                            | Wynik         | Test / dowód                                                                                |
| ---------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| 10 kolejnych gotowych zadań, 0 sleep                 | PASS          | `unit/executor-cycle-loop.spec.ts`                                                          |
| Pusta kolejka: 30 s, brak busy loop                  | PASS          | ten sam test; dwa kolejne idle polls                                                        |
| Backoff, Retry-After, reset D1, shutdown             | PASS          | executor-cycle-loop, artifact-client-retry, oracle-worker                                   |
| Lease/fencing, restart i completed dedup             | PASS          | `failure/job-recovery`, core-recovery-acceptance, artifacts, oracle-worker                  |
| 15:00/23:00 Warsaw, DST i opcjonalny jeden slot      | PASS          | `unit/monitoring-slots.spec.ts`; 2026-03-29 i 2026-10-25                                    |
| 30 kanałów: trwały jeden cykl i rzeczywiste kontrole | PASS          | `workers/monitoring-cycles.spec.ts`; actual Queue handler, 30 SUCCEEDED, 30 attempts        |
| Awaria między porcjami, utracony hint, duplikat      | PASS          | monitoring-cycles, control-queue; bez przesuwania zegara o pięć minut                       |
| +10 min / +1 h / +10 h od detekcji                   | PASS          | caption-retry-policy, transcript-recovery, discovery/scheduler                              |
| Dokładnie trzy braki, technical failure oddzielnie   | PASS          | caption-retry-policy, artifacts recovery circuit                                            |
| Ręczne sprawdzenie i zachowana historia              | PASS          | caption-retry-policy: nowa epoka i pięć historycznych attempts                              |
| Manual/generated, wszystkie cue i czasy              | PASS          | transcript-providers, transcript-normalize, archive-renderer, pipeline-performance          |
| Automatyczny pipeline bez ANALYZE/PROJECT            | PASS          | pipeline-performance: zero obu typów po 10/30/100 acceptance/archive                        |
| Historyczne wyniki i opcjonalny legacy               | PASS          | artifacts, projection-jobs, export, retention, backup/restore; stare IDs/hash nieprzepisane |
| Drive 10/30/100: automatyczna kontynuacja            | PASS          | pipeline-performance; brak sleep i oczekiwania pięciu minut                                 |
| Pusty backlog bez kolejnych wiadomości               | PASS          | pipeline-performance: IDLE, zero hints, stała liczba plików                                 |
| Przerwany upload i brak duplikatów                   | PASS          | pipeline-performance oraz transcript-archive; te same reserved IDs                          |
| Prywatność, readback, hash/version                   | PASS          | transcript-archive, drive-create-recovery, payload tests                                    |
| Długie źródło 10 800 cue                             | PASS          | pipeline-performance; dokładny tekst i ms, `BACKLOG_BENCHMARKS.json`                        |
| Daily/ChatGPT dokumenty z compact źródeł             | PASS          | pipeline-performance; trzy pliki, exporter credential, wszystkie invocation ≤50 SQL         |
| Produkcyjne deletion OFF                             | PASS lokalnie | konfiguracje false, brak nowego delete endpointu/automatycznego eviction; dry-run domyślny  |
| Dry-run identyfikuje tylko trzy dozwolone IDs        | PASS          | pipeline-performance; nie zmienia chunków/metadanych                                        |
| Drive failure lub mismatch blokuje delete            | PASS          | hash/unavailable faults, liczba chunków pozostaje 3                                         |
| Aktywny konsument w czasie readback blokuje delete   | PASS          | pipeline-performance; atomowy guard i trigger, zero usuniętych chunków                      |
| Odczyt po eviction, metadata/results zachowane       | PASS          | pipeline-performance; exact readVerifiedText + owner paging, trzy headers, jeden item/run   |
| Rollback po eviction                                 | PASS          | restore dokładnych trzech chunków i ponowny lokalny read                                    |

## Pomiary

`BACKLOG_BENCHMARKS.json` zawiera lokalne serie 10/30/100: odpowiednio
1,175 / 2,975 / 10,754 s wall, maksimum 38 SQL/tick. Test 180-minutowego
syntetycznego materiału zachował 10 800 cue; lokalny wall 4,140 s, 35 SQL.
To testy bez rzeczywistej sieci Drive i bez OAuth. Sekwencja Daily dodatkowo
rozdziela folder / immutable JSON / Markdown, utrzymując limit 50 z pełnym
credentialem workera. Nie podwyższono tego progu.

`BENCHMARK_MODEL.json` to oddzielny replay zachowanych wejść oraz model
3/9/30/100 filmów dziennie, wraz z byte/chunk/RPC counts, bufrem D1 i wzrostem Drive.
CPU/RSS tego replay jest CPU/RSS procesu Node, **nie produkcyjnego Workera**.

## Reprodukcja

Użyć przypiętych Node/pnpm. W tej sesji lokalny launcher pnpm naprawił
wybór starego globalnego pnpm/Node przez procesy potomne; nie wyłączano engine-strict.

```text
node node_modules/vitest/vitest.mjs run --project unit --project contracts --maxWorkers=2 --reporter=json
node node_modules/vitest/vitest.mjs run --project workers --maxWorkers=2 --reporter=json
pnpm typecheck
pnpm lint
pnpm build
pnpm verify:config
pnpm verify:migrations
node --import tsx tools/performance/benchmark-pipeline.ts
git diff --check
```

Duże testy oraz bootstrap workerd wymagają lokalnych procesów. Pierwsze
uruchomienie w sandboxie miało EPERM; ponowiono z uprawnieniem wyłącznie do
lokalnej weryfikacji. Jeden automatyczny przegląd uprawnienia zakończył się
timeoutem; pojedyncza dozwolona ponowna próba zadziałała. Nie używano tego do
zmian produkcji. Nie zmieniano progów testów ani timeoutów.

## Naprawione problemy podczas odbioru

- RSS kończy sprawdzenie bez statusu pełnego historycznego backfillu. Licznik
  cyklu korzysta z realnego page commit + SUCCEEDED, nie samego enrollmentu.
- Fixture języka nie zawierała translation_languages; uzupełniono cały kontrakt.
- Stary positional INSERT jobs nie uwzględniał dwóch nowych kolumn; użyto nazw kolumn.
- Test przerwanego uploadu wymusza trzy błędy, bo pojedynczy 503 podlega już
  istniejącemu retry. Integration używa wstrzykniętego wait; unit sprawdza
  rzeczywiste wartości 500/1500 ms i Retry-After. Produkcyjne czekanie pozostaje.
- Daily przekraczał 50 SQL przy wspólnym przygotowaniu folderów/JSON/Markdown:
  rozdzielono etapy na trwałe, natychmiast kontynuowane invocation.
- Classic renderer AI nie może traktować samego Markdown transcript jako
  gotowego canonical AI result. Status i link transkrypcji są osobne.
- Równoległe duże suites powodowały timeouty backupu. Pełny końcowy przebieg
  ogranicza równoległość harnessu; kryteria i timeouty pozostały niezmienione.

## Granice dowodów

Free i gotowość całego konta: **UNVERIFIED**. Nie mierzono produkcyjnego
Workers CPU, zużycia całego konta, ARM64 backlog 100 filmów ani aktualnego
wolnego Drive. Nie przeprowadzano nowego testu możliwości czytania Drive
przez ChatGPT. Nie wykonywano produkcyjnego soak ani e2e przez realne konto.
Build, regresje i lokalne integracje stanowią odbiór implementacji lokalnej.
Pakiet jest gotowy do kontrolowanego wdrożenia po osobnym zleceniu, z deletion OFF.
