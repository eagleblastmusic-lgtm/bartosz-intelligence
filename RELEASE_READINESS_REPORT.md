# Bartosz Intelligence V1 — release readiness

Stan: 2026-10-09, Europe/Warsaw. Application commit: `ef67cdf`; recovery tooling
commit: `019b3f5` (poprzedzony `eb72dff`), base
`1f5e448`. Ten raport jest audytem dostępnych dowodów, nie zgodą na release.

**IMPLEMENTATION COMPLETE: NO. PRODUCTION ACCEPTED: NO.**
**OBSERVATION IN PROGRESS: YES; Gate C: NOT_YET_MATURE.**
Nie wszystkie niezależne odbiory techniczne są ukończone. Brak dowodu nie jest
awarią implementacji ani dowodem zewnętrznego blockera. Pozostałe nieprzeprowadzone
drille i pomiary wymieniono jawnie poniżej; nie oznaczono ich PASS.

## Aktualny kandydat i wykonane zmiany

- Poprawiono HTTP 408: TEMPORARY_FAILURE zamiast INVALID_REQUEST.
- Timeout transportu ma stałą kategorię TRANSPORT_TIMEOUT, bez tekstu wyjątku.
  Nieznane użycie tokenów pozostaje UNKNOWN; nie powstaje dodatkowe wysłanie.
- Trwały retry po błędzie przejściowym respektuje późniejszy Retry-After
  dostawcy, zachowując dotychczasowy budżet prób, jitter i fencing.
- Wdrożono Workera `639ca7d1-2264-48e1-ad0e-5daca72f870b`.
  `/health`: HTTP 200, DB/Queue/Assets obecne. To sprawdzenie bindings,
  nie E2E ani dowód dostępności zewnętrznych usług.
- Uruchomiono istniejący kolektor Gate C z PROJECT-scoped tożsamością,
  bez AI; kompletne próbki mają 53 przypadki. Interwał: 3600 sekund.
  Proces działa na tym komputerze; nie obiecuje pracy po wyłączeniu komputera.
- `paid_services_enabled=false`; wykonano dokładnie jedno nowo zatwierdzone
  żądanie Gemini QUALITY_TEST (503); brak zakupów,
  upgrade'ów, zmiany modelu i płatnego fallbacku. Nie zmieniono raportów Drive.

Fingerprint wdrożonej aplikacji: `26a763df6d4846e12d1b30615319a8d49706342a93bb8ce86680f3193b304b33`.
Fingerprint aktualnego kandydata z rozszerzonym toolingiem recovery:
`3f79efcc3e9216fc10731faac5a678580e0231ba4c51e2ae889c75164f130111`.
35 migracji; fingerprint zestawu:
`0ea54579fe5f0a5c4d8501a0ac3718f5fe9d6e317a93ebb1ff38f9e706b73f2a`.
Evidence wdrożenia: `docs/verification/deployment/2026-10-09T14-15-57.021Z.json`.

## Gemini Free — diagnoza bez nowego wywołania

Skonfigurowany model: `gemini-3.8-flash`; profil `gemini_free`, Free.
REST: POST `https://generativelanguage.googleapis.com/v1beta/interactions`,
JSON, x-goog-api-key, store=false, bez tools, thinking_level=low,
materializowany wire schema i ograniczony max_output_tokens. Oficjalny
[przykład Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview)
potwierdza model/endpoint. [Cennik](https://ai.google.dev/gemini-api/docs/pricing)
wymienia darmowe wejście/wyjście Standard dla tego modelu; nie daje gwarancji
obsłużenia konkretnego żądania. Nie stwierdzono wycofania modelu.

Ostatni zapisany GET capabilities z 2026-10-08 23:16 UTC: 1048576 input,
65536 output, generateContent/countTokens/cache/batch. To metadane modelu,
nie udana generacja ani osobny dowód capabilities Interactions.
Ostatnia rzeczywista obserwacja projektu przed wysłaniem: RPM 0/5,
RPD 1/20, INPUT_TPM 0/250000. Jest historyczna; nie uprawnia do dzisiejszego
wysłania. [Oficjalne limity](https://ai.google.dev/gemini-api/docs/rate-limits)
są zależne od projektu/modelu, wspólne dla kluczy projektu i niegwarantowane;
RPD resetuje się według czasu Pacific. Nie utożsamiono peak usage z current usage.

Historyczny live request z 2026-10-08: video `rUhllpnYWR8`, job
`8f1812f5-9dad-4451-a6c0-339e5c2aa77d`, jedna generacja,
HTTP_503:service_unavailable, brak token accounting, UNKNOWN reservation,
RETRY_WAIT/TRANSIENT, zero zaakceptowanych efektów. Odczyt produkcyjny z tego
audytu potwierdza tę samą kategorię w immutable artifact metadata.
Pusty output i jego hash dotyczą braku wyniku modelu, nie pełnego HTTP error body.
W evidence nie zachowano pełnej treści błędu ani correlation/request ID;
nie można ich odtworzyć ani wskazać wewnętrznej przyczyny Google.

Wniosek: ostatnie wysłanie otrzymało HTTP od providera; jego końcowe 503 nie
było lokalnym admission, walidacją wyniku ani lokalnym timeoutem. Nie dowodzi
quota exhaustion ani konkretnej awarii/model overload. Wcześniejsze lokalne
błędy harnessu przed wysłaniem opisano osobno w live receipt.
[Google zaleca backoff przy 503/429](https://ai.google.dev/gemini-api/docs/troubleshooting).
Adapter nie wykonuje ukrytych retry; kolejka zachowuje job/origin, a ponowienie
wymaga admission. Dotychczasowa jednożądaniowa zgoda została zużyta.

Właściciel następnie osobno zatwierdził dokładnie jedno nowe QUALITY_TEST tego
samego materiału. Wykonano je 2026-10-09 o 14:56 UTC: job
`c6a99a9d-4be4-446e-bbe5-29e5c0b92c24`, profil revision 5, ten sam model.
GET metadata zachował identyczny response hash; odświeżono eligibility przez
nową immutable revision bez quality approvals, nie zmieniając starych snapshotów.
Aktualne widoczne Google Cloud Free counters o 14:55:49 UTC: RPM 0/5,
RPD 0/20, INPUT_TPM 0/250000. Admission przyjęło jedną rezerwację.
Jedno wysłanie zakończyło się ponownie `HTTP_503:service_unavailable`;
reconciliation D1 potwierdziło UNKNOWN, RETRY_WAIT/TRANSIENT i 0 accepted effects.
Nie wykonano hidden retries ani drugiej generacji. Nowa zgoda również zużyta.
Primary evidence: `docs/verification/gate-ai/live-attempt-2026-10-09.json`,
`quota-live-2026-10-09.json`, `model-capabilities-2026-10-09.json`.
Powtarzalne 503 mimo dostępnych liczników nadal nie identyfikuje wewnętrznej
przyczyny Google i nie uprawnia do jednostronnej zmiany modelu.

Primary evidence: `docs/verification/gate-ai/live-attempt-2026-10-08T23-23Z.json`,
`model-capabilities-2026-10-08T23-16-59.681Z.json`,
`quota-live-2026-10-08T23-23Z.json` oraz
`docs/verification/release/current-production-2026-10-09.json`.
Minimalna kolejna opcja: osobno zatwierdzone, ograniczone ponowienie tego samego
materiału po świeżej obserwacji quota. Zmiana modelu wymaga osobnej decyzji
i kwalifikacji; nie jest automatycznym rozwiązaniem obecnego 503.

## Checkpointy i bramki

| Zakres               | Rzeczywisty stan                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Stage 01 / źródło    | Zachowane istniejące qualification; brak powodu do ponownego kosztownego benchmarku                                                    |
| Stage 02 / Core      | Istniejące implementacje i evidence; nie oznacza globalnego release PASS                                                               |
| CP-3.7 / live Gemini | Nieuzyskana udana generacja; ostatnia próba 503                                                                                        |
| CP-3.8–3.12          | Implementacja i lokalne regresje pipeline istnieją; brak live accepted AI E2E                                                          |
| CP-3.13              | AWAITING_HUMAN_REVIEW; materiały/procedura istnieją                                                                                    |
| CP-4.1–4.8           | Istniejące GUI/Daily i automatyczne testy; ręczny Gate U odroczony                                                                     |
| Stage 05A            | Instrumentation/collector istnieją; kolektor uruchomiony                                                                               |
| Stage 05B            | OBSERVATION IN PROGRESS, 1 kanał zamiast wymaganej kwalifikacji 20 kanałów                                                             |
| CP-6.1–6.7           | Knowledge/Ledger/profiles/compiler zaimplementowane; lokalne acceptance w checkpointach; Full quality otwarta                          |
| CP-7.1               | Production grant/root/renewal actual PASS w zapisanym zakresie; długotrwałość grantu nie jest gwarantowana                             |
| CP-7.2–7.4           | Renderer, file identity, dirty days/revisions zaimplementowane; rzeczywiste create/update i zmiany COMPACT/FULL na jednym ID zachowane |
| CP-7.5               | Pełny Gate D-export NOT_RUN / NOT_YET_QUALIFIED                                                                                        |
| CP-7.6               | Dziewięć D-bridge checks NOT_RUN; brak faktycznego dowodu UNAVAILABLE                                                                  |
| CP-7.7               | System zaimplementowany i wcześniej sprawdzony GUI E2E                                                                                 |
| CP-7.8–7.10          | Codex/optional płatne route DISABLED; Gate 0B NOT_RUN, brak dodatkowej capacity                                                        |
| CP-7.11              | Runbooki/backup istnieją; pełny operational acceptance i Stage DONE otwarte                                                            |
| CP-8.1               | Strict evidence evaluators/pins/preregistration istnieją; nowy kandydat nie odziedzicza pełnego PASS starego manifestu                 |
| CP-8.2               | Siedem actual local-D1 cases PASS na aktualnym przypiętym kandydacie; brak całego Gate R                                               |
| CP-8.3–8.4           | Immutable model/prompt rollback actual local-D1 PASS; full quality i pozostałe frozen drille nieukończone                              |
| CP-8.5               | Independent empty SQLite restore PASS; niezależny nośnik i pełne RPO/RTO niekwalifikowane                                              |
| CP-8.6               | Istniejące security negatives i secret scan PASS w opisanym zakresie                                                                   |
| CP-8.7               | Lokalny 10k/Gate S/U PASS; produkcyjna kwalifikacja CPU/query i Gate C otwarte                                                         |
| CP-8.8               | Clean install/build/bootstrap PASS na `95902f3`; live owner first-run i pełna checklist nieukończone                                   |
| CP-8.9               | Ten audit/handoff postępu; final release acceptance NOT_DONE                                                                           |

Gate AI: INCONCLUSIVE, brak udanej generacji i obowiązkowego human review.
Gate D-export: NOT_RUN jako kompletna bramka; częściowe actual provider PASS.
Gate D-bridge: NOT_RUN. Gate R: NOT_RUN jako kompletna bramka.
Gate S: lokalna kwalifikacja PASS; pełna produkcyjna INCONCLUSIVE.
Gate U: automatyczna kwalifikacja PASS w istniejących zakresach;
screen-reader NOT_RUN / DEFERRED. Gate C: NOT_YET_MATURE.

## E2E i Drive

**REAL FULL E2E: NOT_PASS / INCOMPLETE.** Production D1: 1 kanał, 53 Items,
37 accepted transcript runs, 37 ukończonych PROJECT, 0 Observations.
Accepted source runs nie są accepted Gemini analyses.
Ostatnie żądanie Gemini zatrzymało przepływ przed structured output/validation/
enrichment/accepted Evidence i Knowledge. Nie zastąpiono go fixture.

Źródło `transcript_39cfb0e1bcf555ab6cc5131d4908549af2713325a58858663832dddf0d55599a`:
rzeczywisty source byte fidelity/hash PASS, 1071 raw cues i 1071 anchors;
`docs/verification/transcript/source-production-2026-10-06.json`.
27 ponownie wykonanych Workers testów obejmuje źródło, wire validation,
canonical/Evidence, fenced acceptance, Full/Custom/chunking i błędy providera.
Provider w tych testach jest syntetyczny; to regresja implementacji, nie live E2E.
Istniejące 26 Chromium E2E i automatyczne accessibility evidence zachowano.

Drive: Production/Connected/Verified, odnowienie rzeczywistego grantu PASS.
Folder `1rn_5auxY_8HAeADc1RgGKQ6h9JimD7WM`, Daily file
`1WFfdndxp0GJAqKgybSZf1_Opt4yvzAnQ`, current COMPACT revision 4.
Istniejące actual receipts: create `7dad1744…`, FULL revision 3 `0b502df2…`,
COMPACT revision 4 `ea9032ff…`, renewal/same-file readback `6cd6d9de…`.
Rzeczywisty concurrency canary `d99d0b0d…`: jeden writer, drugi HTTP 412,
stable readback. Reserved-create response-loss `8c5d75bd…`: jedna próba create,
ten sam reserved ID, 83 bytes/hash readback, bez drugiego create.
Te próby nie domykają pełnego Daily recovery ani quality/full-data E2E.

Nowy rzeczywisty readback revision 4/version 7: pełne 3325 bytes zgodne z SEALED
canonical artifact `876ae4631dcb271086cc6aac8be5d09c917407048b3ab968351a6a1b81d8d582`,
full hash `791e6c05afa7d3d8feb5ddcbfeddc794b6ea2337e3ef9972d785db3448782b8b`,
body hash `27423a73fb1526e65cf2933ce9eb45200853ed907b88ac023adb256b5ddb19fd`.
Counts: 4 Items, 4 pending, 0 ready, 4 unique canonical IDs, partial=true;
source cut 1685, root/parent/name i remote version stable. Odnowiono aktualny
grant, zero Drive writes. Evidence: `docs/verification/drive/canonical-readback-2026-10-09.json`.
Początkowy FAIL harnessu zachowano w `canonical-readback-diagnostic-2026-10-09.json`:
string-only sha256 błędnie konwertowało Uint8Array; poprawiono byte hashing.
Readback PASS nie oznacza zaakceptowanych danych AI ani pełnego Gate D-export.

Brakuje pełnego scorecardu z primary observations dla wszystkich checków,
actual accepted AI content/counts, late accepted jobs/correction/conflict przez
cały executor, pełnego outage/reconciliation oraz wymaganej oceny COMPACT.
Istniejących raportów nie zmieniano dla zdobycia evidence. Automatic export
pozostaje wyłączony. Safe isolated test scope trzeba jawnie określić przed
próbą ingerującą w istniejący raport lub grant użytkownika.

## Recovery, backup i obserwacja

Aktualne Gate R evidence `docs/verification/gate-r/2081a456-c834-4bfc-9c6d-267dee40091c/`:
lease crash, queue loss, discovery interruption, database rollback,
auth revocation, quota/local offline i model/prompt rollback PASS w isolated
actual local D1 po odtworzeniu istniejącego backupu do pustej bazy.
Independent on-disk evaluator potwierdził hashe i pins, 7 PASS, overall NOT_RUN.
Unknown quota odrzuciła rezerwację, cloud executor nie przejął local-primary;
restart zachował job/origin, stary fence odrzucony, duplicate idempotent.
Rollback przywrócił zgodny prompt bez zmiany in-flight snapshotu; ten sam model
revision nie daje się nadpisać, nowa revision nie dziedziczy quality approval.
Wyniki AI i upływ 26 h są syntetyczne i jawnie opisane; nie stanowią quality proof.
Pozostałe transcript_failure, malformed_ai i drive_consumer_failure NOT_RUN
w pełnym frozen drill manifest. Istniejące testy malformed output są lokalnymi
regresjami, bez nowego actual frozen receipt. Nie uznano ich za zewnętrzny blocker.
Nowe lokalne testy retry nie zamieniają tych wierszy w actual gate receipts.
Symulacja 26 godzin transportu nie dowodzi rzeczywistej 26-godzinnej awarii Cloudflare.

Backup receipt `docs/verification/backup/2026-10-08T18-39-53.489Z.json`:
4678 canonical rows, 364 chunks, cut 1593, 35 migrations, independent empty
SQLite restore/integrity/FKs/hash PASS, bez aktywnych sessions/credentials.
Backup 379516 ms, restore 4698 ms. To zmierzone czasy komponentów,
**RPO/RTO całej aplikacji: NOT_QUALIFIED**. Independent medium: NOT_VERIFIED.
Dzisiejszy check: FRESH, capture 2026-10-08T18:33:29.275Z, backup_started=false.
Scheduler: ostatni run 2026-10-09T14:05:05Z, exit 0, missed runs 0.
Due backup execution nadal nie ma kwalifikującego dowodu; nie powtórzono kopii.

Gate C immutable chain: `.local/capacity-observation/`;
runtime/logi: `.local/capacity-runtime/`. Kolektor działa od 2026-10-09
16:11 Europe/Warsaw; aktualny proces 27412. Pierwszy watch launch odrzucił
logi w katalogu immutable evidence; logi przeniesiono do runtime i poprawny
watch uzyskał COMPLETE/53. Nie poluzowano walidacji chain.
Brak dojrzałych 20-channel windows, throughput/headroom, kosztowego billing
audit, saturation i pełnego outage recovery; nie obliczano fikcyjnego μ/RPO/SLO.
Świeże heartbeat non-AI usług potwierdzono produkcyjnym read-only snapshotem.

## Weryfikacja i pozostałe działania

Nowa regresja: 22 contracts + 27 pipeline Workers + 10 recovery/export Workers
= **59 PASS, 0 FAIL**. Core/API/executor/Workers typecheck, zmienione pliki lint,
format i Worker dry-run build PASS. Initial sandbox spawn EPERM usunięto przez
reviewed execution. Nie powtórzono całej niezmienionej baterii 649 testów
z `docs/verification/release/hardening-technical-acceptance.json`.
Nowe evidence: `docs/verification/release/gemini-recovery-2026-10-09.json`.

Rozszerzenie recovery: 2 Workers integration tests PASS, 16 strict recovery
evaluator unit tests PASS, tools/Workers typecheck, scoped lint i format PASS.
Final existing public-build secret scan PASS (4 pliki, 409413 bytes, 0 findings).
Nowe drille wykorzystały poprzedni verified backup zamiast ponownego production
exportu. Drugi przebieg rozszerzał zakres o rollback; nie był identycznym retestem.

Production search: `docs/verification/release/search-production-2026-10-09.json`:
5 rzeczywistych FTS zapytań, po 6 wyników, 447 rows_read/query, 0 rows_written,
1 attempt/query, SQL 1.76–3.86 ms, indeksowane canonical joins, FTS index64:M1>.
Index FRESH przed/po, cut 2213. To 53-item corpus, nie 10k production Gate S;
Worker CPU i GUI latency NOT_MEASURED. Pomiar czasu REST zawiera sieć.

Minimalne działania do pełnego V1 release:

1. Osobna zgoda na konkretny materiał/liczbę Gemini calls, świeża quota,
   udany QUALITY_TEST i wymagane quality evidence; następnie scoped production E2E.
2. Domknięcie actual Gate D-export pełnym scorecardem na bezpiecznych danych;
   D-bridge actual Scheduled/Voice lub faktyczny capability/owner scope decision.
3. Pozostałe trzy frozen Gate R scenarios, complete app recovery/RPO/RTO,
   niezależny recovery medium/locator; backup execution observation.
4. Produkcyjne 10k/search/CPU oraz pełne primary evidence 20-row release checklist;
   bieżące real corpus SQL/query measurement wykonane.
5. Kontynuacja realnego Gate C na docelowym scope i wymaganych windows;
   sam kolektor na jednym kanale nie jest kwalifikacją 20 kanałów.
6. CP-3.13 human review i odroczony screen-reader według decyzji właściciela,
   następnie formalne completion handoffy Stage 07/08 i production acceptance.

Zgody/decyzje właściciela: każde nowe Gemini wysłanie (materiał + liczba),
ewentualny model replacement, destructive auth/report drills, lokalizacja
niezależnego backup medium oraz rzeczywisty Bridge capability/active scope.
Żadnej z tych decyzji nie podjęto za właściciela. Nie ponowiono prośby o
odroczone formularze ludzkie. Niewykonane lokalne drille/pomiary pozostają
technicznym backlogiem, nie zostają zbiorczo nazwane zewnętrznym blockerem.

## Delta: szyfrowany backup Drive i uprawnienia docelowego folderu

Commit implementacji **e0c9917**. Zaimplementowano AES-256-GCM canonical envelope z uwierzytelnionym backup ID,
key ID i SHA-256, dedykowanym nieeksportowalnym kluczem oraz losowym IV.
Naprawiono base64url dla dużych backupów (bez przekroczenia limitu argumentów).
CLI wykorzystuje istniejący OAuth i canonical verification, zachowuje zarezerwowany
file ID przed uploadem, sprawdza download/hash/decryption i nie nadpisuje receipt.
Istniejący backup cadence może archiwizować szyfrowaną kopię; konfiguracja pozostaje
wyłączona do potwierdzenia docelowego Backups. Nie wykonano uploadu ani restore z Drive.
Klucz recovery zapisano poza repozytorium, D1 i Drive, w prywatnym katalogu
LOCALAPPDATA/Bartosz Intelligence/Recovery; brak klucza w evidence.

Regresja tej delty: 16 targeted unit PASS, 42 Drive/OAuth/export/backup Workers PASS.
Core/API/executor/tools typecheck oraz scoped ESLint PASS. Te testy nie zastępują
live upload/download/restore ani pełnego Gate R. Nowa delta zmienia fingerprint
kandydata; poprzednie frozen recovery evidence zachowuje własne piny.

Faktyczny APLIKACJE ACL: owner-only lista osób, ale ANYONE_WITH_LINK/EDITOR
(wymagane zalogowanie). Osobny OpenAI OAuth dla chatgpt.com ma grant odczytu
wszystkich plików Drive; publiczny link nie jest wymaganiem tego grantu.
Nie zmieniono uprawnień, nie przeniesiono plików, nie utworzono folderów.
Ostateczny wariant migracji wymaga zgody na nowy zakres: nowy ograniczony rodzic,
obecny immutable export root jako Daily, nowy Backups, diagnostyki w rodzicu.
Ograniczenie folderu nie izoluje go od OAuth działającego jako właściciel;
treść backupu chroni szyfrowanie i klucz poza Drive. Odczyt Daily w ChatGPT NOT_VERIFIED.
Evidence: docs/verification/drive/access-inspection-2026-10-09.json.

Production HTTP search: 5 poprawnych requestów, HTTP 200, po 6 wyników.
Cloudflare CPU telemetry HTTP 403: rzeczywisty CPU pozostaje INCONCLUSIVE.
Nie utożsamiono czasu sieciowego z CPU. IMPLEMENTATION COMPLETE i PRODUCTION ACCEPTED
pozostają niepotwierdzone; obowiązkowe bramki nie zostały poluzowane.
