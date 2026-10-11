# Kontrolowane wznowienie D1 — 2026-10-10

## Zakończony zakres jednorazowego wykonania — 2026-10-11

Schema 39, końcowy deploy `9d3b376e-990d-48c7-a97e-a0877f918aa0`, niezależny
Drive-copy restore i pełny transcript readback/dedup PASS. Kod `7b79a79`.
Jednorazowy heartbeat został usunięty; nie odtwarzać codziennego ciężkiego run.
Autorytatywny wynik: RELEASE_READINESS_REPORT.md oraz
`docs/verification/release/controlled-resume-completion-2026-10-11.json`.
Nie ponawiać probe/migracji/folder/archive/capture. Odczyt po zmianie UTC day
był dodatkowym pojedynczym 1-read probe dla dokończenia poprzedniego wykonania.
Retencja read-only dry-run, deletion 0/approval NULL. P0 AI → Daily pozostaje
pending; 19 new-only IDs są zatwierdzone i czekają na stabilne dostarczanie P0.
Następny Gemini/model request wymaga osobnej zgody, human quality odbioru nie
zastępuje GUI. Windows Capacity Observation i cadence backupu są odrębne.

Priorytet wznowienia: **rzeczywiste AI → zweryfikowany Google Drive**.
Nowe doprecyzowanie i lokalna delta P0 są w decyzji Drive-only oraz
[diagnozie Gemini](../verification/gate-ai/GEMINI_503_P0_2026-10-09.md).
Rzeczywiste wznowienie 2026-10-10 zastosowało 036/037/038/039; produkcja ma
schema 39. Aktualny wynik i receipts są w RELEASE_READINESS_REPORT.md.
Poniższa sekwencja pozostaje runbookiem, nie poleceniem ponowienia wykonanych kroków.
Zatwierdzono prywatne pełne transkrypcje. Po preflight/probe wykonać setup
podfolderu i jeden archive-once według runbooka retencji, bez Gemini. Następnie
P0 summary live E2E tylko po faktycznej osobnej zgodzie. Awaria archiwizacji
transkrypcji nie zatrzymuje Daily; blokuje cleanup pozyskanego źródła.
Po minimalnym potwierdzeniu poprawki D1 nie wracaj do mikrobenchmarków.
Historyczne Knowledge/Ledger/Bridge nie blokują samego dostarczania;
integralność, jakość, retry/dedup i recovery nadal wymagają prawdziwych dowodów.

Zakres: istniejący Implementation Master Plan V1. Gemini: zero wywołań bez
osobnej zgody na materiał i liczbę prób. Kanały: lista zatwierdzona, staged new-only z zachowanych IDs. `paid_services_enabled=false`. Istniejące Daily/Backups i ich
identyfikatory pozostają autorytatywne. Nie wykonujemy ponownie 8 historycznych
PASS Gate R ani 6 PASS D-export tylko dla uzyskania nowej daty evidence.

## Warunek rozpoczęcia

Właściciel zatwierdził **jedno wznowienie 10 października 02:05 Europe/Warsaw**.
Środowisko wykonało je faktycznie od 20:29 UTC, czyli 22:29 Europe/Warsaw.
Nie przypisujemy wyników do planowanej godziny. Po zakończeniu wykonalnego
zakresu usunąć ten heartbeat; nie uruchamiać codziennie ciężkich testów.
Windows Capacity Observation i istniejąca cadence backupu są odrębne.
Nie zastępuje unattended ChatGPT Scheduled / Voice ani ciągłej obserwacji Gate C.

1. `node --env-file=.env --import=tsx tools/deployment/d1-resume.ts --probe`.
   Dopiero po 00:00 UTC; jeden lookup tabeli `owner_users` po kluczu głównym
   właściciela z istniejącego zweryfikowanego backupu. Bez ujawniania owner ID,
   sesji i danych. Wymagane `rows_read` 1–4, `rows_written=0`, właściwy wynik.
   `SELECT 1` i sam termin resetu nie wystarczają. Exclusive intent zapobiega
   ponownej próbie nawet po przerwaniu procesu. Przy błędzie stop tego dnia.
2. `node --env-file=.env --import=tsx tools/deployment/d1-usage.ts --read-analytics --local`.
   Analytics całego konta, bez D1 SQL. To opóźnione wykorzystanie, nie dokładny
   licznik remaining. Wymagany bieżący dzień UTC i receipt młodszy niż 15 min.
   Przy >=80% odczytów lub zapisów odraczamy testy/obserwację. Recovery i
   canonical cleanup nie mogą być porzucane przez pomocniczy budżet testu.
3. Zastosować oczekujące migracje `036_d1_read_indexes.sql`, `037_drive_only_retention.sql`, `038_verified_archive_append.sql` i `039_transcript_drive_archive.sql` po
   sprawdzeniu 35 istniejących nazw/hashów. Na lokalnej kopii koszt indeksów
   jest mierzony w benchmarku; produkcyjne metadata zachować, nie zgadywać.
   Następnie wdrożyć zweryfikowany build z obsługą daily quota i poprawionym SQL.
   Historyczny stan przed wznowieniem: 35 migracji / Worker
   `93995293-fd49-4f25-b843-63f326c30a32`. Aktualny stan 39 i rzeczywisty deploy
   potwierdzają receipts z 10 października; nie ponawiać migracji dla nowej daty PASS.
   Istniejący tryb: `node --env-file=.env tools/deployment/prepare.mjs migrate`;
   później właściwy zweryfikowany deploy przez `tools/deployment/deploy.mjs`.
   Backup cadence odmawia capture przed zgodnym applied checksum set, więc
   nie wolno omijać preflight lub stemplować 39 na bazie z applied 35.
4. Minimalny pomiar produkcyjny: po jednej próbie admission, jednej stronie
   Capacity i jednej kontroli metadata-refresh; zapis `meta.rows_read/written`.
   Bez pełnego skanu danych, bez pięciu identycznych powtórek. Różnice od
   lokalnego workerd są rzeczywistymi wynikami, a nie powodem do zmiany progów.
   Gotowy runner: `node --env-file=.env --import=tsx tools/gates/d1/measure-live.ts --live --once`.
   Wymaga rzeczywistego dzisiejszego probe AVAILABLE, fresh usage, zgodnych
   aktualnych 39 applied migrations oraz istniejących scoped worker credentials.
   Exclusive intent chroni przed replay; budget metadata zachowuje rzeczywiste
   koszty także przy częściowym wykonaniu. Due metadata job jest trwałą zwykłą
   intencją aplikacji; nie tworzy się tymczasowej sesji ani prywatnego dumpu.

5. Zatwierdzone 19 źródeł ma już rzeczywiste canonical IDs i uploads playlists:
   `docs/verification/capacity/approved-channel-identities-2026-10-09.json`.
   Użyć zachowanego wyniku i włączać stopniowo z new-only; nie powtarzać 19
   provider requests. Zgoda właściciela z
   2026-10-09 jest w `docs/decisions/GATE_C_CHANNEL_PROPOSAL_2026-10-09.md`.
   Nie pytać ponownie o listę/tryb; nie uruchamiać pełnego backfill lub AI.
   Aktywacja pozostaje po stabilnym podstawowym przepływie. Sam zapis
   transkrypcji nie stanowi dowodu dostarczenia polskiego streszczenia P0.

## Backup: istniejąca kopia najpierw

Kopia `5a30668c-f9f2-4aae-b965-b9e15dc9c073`, SHA-256
`31cd69361a6bb1342dd76726ba9aa1f430791cda36f90818dba61857cd027bd0`,
4678 wierszy, cut 1593, capture `2026-10-08T18:33:32.355Z`, obejmuje wszystkie
canonical tabele i 35 migracji. Upload/download/restore już PASS. Lokalny
benchmark porównuje restore do bazy z migracją 036: to wyłącznie indeksy,
nie zmiana tabel lub projekcji backupu. Zweryfikowany historyczny prefix jest
akceptowany tylko dla tego jawnie kwalifikowanego suffixu. Inna zmiana schema
wciąż wymaga zgodnego zestawu migracji.

Ta kopia wystarcza dla fixture i recovery porównań. O 02:00 ma jednak około
29 h 26 min; nie spełnia celu RPO <=24 h. Najnowszy kompletny retained snapshot
ma cut 2255, więc istnieją również późniejsze zdarzenia. **Jedna świeża kopia
ma uzasadnienie RPO i zmian danych**, nie powtarzania PASS. Capture dopiero po
odczycie dostępności, świeżej ocenie Analytics i migracji, z bounded barrier.
Gdy cadence już wykonała zweryfikowaną świeżą kopię, użyć jej i nie tworzyć
drugiej. Przy przerwaniu zachować manifest/intencję i wykonać właściwy cleanup.

## Minimalny zestaw: Gate R — dwa brakujące przypadki

Nowe preregistration/config/baseline zapisać przed injection, z prawdziwymi
pins, granicą <=4 h i izolowanym D1. Historycznych pins nie przepisywać.
Oba wymagają `ACTUAL_PROVIDER`; obecne local functional PASS pozostają lokalne.

Niezależny actual-provider transcript recovery już wykonał real process failure
przy ustawionym timeout 1ms, persisted runtime restart i jeden SOURCE acceptance
w 15.556s. Receipt `provider-transcript-bc3b398b-de67-45c9-83bd-859248354139`
ma własne preregistration/pins oraz restore-compatible 35-migration backup.
Nie importować go jako case PASS do innego preregistered baseline po fakcie.
Strict evaluator wymaga tego samego candidate/migration set dla pełnego Gate R;
jeśli formalny odbiór potrzebuje ponownego case pod nowym baseline, uzasadnieniem
jest zmiana schema/pins, nie nowa data. Historyczne 8 zachowuje zakres; lokalna
regresja database rollback/backup i inne przypadki wymagane przez zgodność
jednego frozen candidate są bez produkcyjnego D1. Nie kopiować/sztucznie
przepinać ich receipts; nie wykonywać kolejnego prod backupu poza potrzebą RPO.

| Przypadek                | Jedna kontrolowana sekwencja                                                                                                                                                                                                                                          | Obowiązkowy dowód                                                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript_failure`     | Izolowany job dla zatwierdzonego `rUhllpnYWR8`; kontrolowane przerwanie rzeczywistego yt-dlp procesu/transportu, trwała failure disposition, restart executora, odzyskanie przez aktualny rzeczywisty yt-dlp, pełne source acceptance. Bez prod D1 i AI.              | Prerejestrowany fault przy rzeczywistym providerze; failure i późniejszy raw hash/1071 cues lub rzeczywisty nowy wynik, anchors, zaakceptowany SOURCE, ten sam job/origin, zwiększony fence, odrzucony stary fence, zero duplicate/lost effects, rzeczywisty elapsed. Nie relabelować starego live success na recovery. |
| `drive_consumer_failure` | Jednoznacznie nowy canary w zatwierdzonym prywatnym folderze aplikacji; izolowany D1/runtime, prawdziwy grant/provider. Przerwać response/consumer po trwałym przygotowaniu; restart, readback/reconcile tej samej sealed rewizji/reserved ID, najwyżej jeden create. | Rzeczywisty request i kontrolowany fault opisany jako injection; preserved artifact, ID/hash, monotonic fence, restart/recovery, jeden remote effect i zero utraconych jobs. Próbę można połączyć z D core independence i late revision.                                                                                |

Najwyżej dwa osobne provider drills, nie cały local-drill od początku. Test
transcript jest niezależny od produkcyjnego D1; dostęp do rzeczywistego Drive
grantu wymaga małego odczytu credential repositories po resecie. Nie eksportować
sekretów do backupu/evidence. Cooldown logiczny nie jest pomiarem rzeczywistego RTO.

## Minimalny zestaw: D-export — siedem brakujących przypadków

Wykorzystać jeden nowy canary i jeden izolowany runtime; nie ręcznie nadpisywać
istniejącego Daily. Przedstawione poniżej sekwencje mogą współdzielić provider
session i readback. Nie ponawiać root/create-timeout/mode-switch/CAS/hash checks,
które mają retained PASS. Nie wpisywać ACTUAL dla synthetic transportu.

| Przypadek                   | Minimalny brakujący scenariusz                                                                                                                                                                                               | Kryteria                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth_offline_renewal`     | Zachować istniejący successful offline renewal; na diagnostycznym request context sprawdzić rzeczywistą odmowę providera dla nieprawidłowego grant/klienta, widoczny reason, bez unieważniania aktywnego grantu właściciela. | `offline_refresh_success`, `failure_visible`, `publishing_verified`. Weryfikacja failure path aplikacji lokalnie nie jest ACTUAL provider failure. Nie rozszerzać OAuth scopes.                                                     |
| `stable_snapshot`           | Zapieczętować rzeczywisty izolowany cut A, podczas opóźnionego readback wprowadzić zdarzenie repository B, zakończyć eksport A i wykazać, że B pozostało dirty.                                                              | `stable_cut`, `late_change_retained`; rzeczywiste seq/canonical event, nie ręcznie podmieniony cut.                                                                                                                                 |
| `same_file_late_revision`   | Po poprzednim kroku wyrenderować B i wysłać nowszą rewizję pod tym samym canary ID, następnie readback.                                                                                                                      | `same_file_id`, `newer_revision`, `no_duplicate`; prawdziwy material change i hash.                                                                                                                                                 |
| `manual_edit_conflict`      | Na tym samym diagnostycznym canary wprowadzić świadomy manual edit; wznowić consumer ze starym expected hash.                                                                                                                | `manual_preserved`, `conflict_visible`, `no_overwrite`; trwały conflict attempt i odczyt zachowanych bytes. Żaden istniejący raport użytkownika nie jest fixture.                                                                   |
| `quota_storage_stop`        | Jeden read-only aktualny provider storage/quota odczyt oraz kontrolowana lokalna odpowiedź 403 storageQuotaExceeded / 429 sprawdzająca durable retry i brak utraty danych.                                                   | Fresh actual quota/storage jest osobnym dowodem; synthetic failure nie daje ACTUAL PASS. Jeśli nie wystąpi rzeczywista kwalifikująca odmowa i DoD wymaga jej, zachować NOT_RUN; nie zapełniać dysku i nie wyczerpywać quota celowo. |
| `core_independent_of_drive` | Podczas tego samego consumer fault przyjąć materiał i trwale enqueue transcript w izolowanym Core; wykazać intake/origin/idempotency oraz zero dodatkowego Daily AI.                                                         | `intake_continues`, `jobs_durable`, `no_extra_daily_ai`; rzeczywisty provider drill + actual local D1, bez zastępczej generacji.                                                                                                    |
| `human_compact_quality`     | Przygotować COMPACT/FULL i porównanie canonical accepted danych dla largest przypadku, Custom fallback, Source vs Inference, qualifiers i pełnego spisu Items.                                                               | Osobny `HUMAN_REVIEW`; obecny Daily ma 0 ready / 4 pending. Nie nadać sobie roli recenzenta i nie generować accepted AI fixture.                                                                                                    |

Budżet całego wznowienia testów produkcyjnego D1: początkowo **50 000
zmierzonych odczytów / 5000 zapisów / 250 REST batches**, poza pojedynczą
uzasadnioną kopią i migracją. `d1TestBudget` zatrzymuje następny request po
wykorzystaniu pułapu lub nieznanym metadata. Limit nie może cofnąć już
zaakceptowanego requestu ani gwarantować account cap. Do pojedynczych dużych
queries używać uprzednio sprawdzonych indexed plans i lokalnych kosztów.
Cleanup/session revocation oraz reconcile nie mogą zostać pominięte przez guard.
Żadnych automatycznych replay po ambiguous failure. Journal checkpointów
sprawdzać przed nową próbą; nie powtarzać całej sekwencji po niepewnym zapisie.

OAuth negative property już PASS: jeden real invalid_grant diagnostic request
i local owner API REAUTH_REQUIRED/REFRESH_REJECTED.
`docs/verification/drive/oauth-negative-d53ce5b4-e8b4-4ab4-a52d-009460d58235.json`.
W D-export OAuth check użyć tego receipt razem z retained actual publishing
i offline-renewal success; sprawdzić report/configuration binding i scope,
nie powtarzać negatywnego requestu tylko dla kolejnego timestamp.

## Przygotowane live AI E2E

Zachować material `rUhllpnYWR8` i source hash/anchors z istniejących receipts.
Przed późniejszą, osobno zatwierdzoną próbą: aktualny model profile,
eligibility oraz rzeczywisty Free quota snapshot, prawidłowy purpose
QUALITY_TEST i aktualny lease. Stare prepared tokens i consumed authorization
z `.local/approved-2026-10-09-*` nie są upoważnieniem do nowego requestu.

Wykorzystać istniejący prepareAnalysis / executePreparedAnalysis / retain /
validate / quality-finish harness z exclusive markerem autoryzacji i maksymalnie
jednym POST. Bez hidden retry. Sukces QUALITY_TEST nadal nie jest PRODUCTION
accepted run: dopiero kwalifikacja/review i rzeczywista autoryzowana ścieżka
prowadzą do Observation, Knowledge/Ledger, GUI i Daily/Drive. Zebrać te dowody
osobno; nie deklarować pełnego E2E dla poprawnej odpowiedzi samego providera.

## Drive-only: zakres wznowienia po rewizji właściciela

Przeczytać docs/decisions/DRIVE_ONLY_RETENTION_V1_2026-10-09.md i
docs/runbooks/drive-only-retention.md. Lokalne schema 37 i zmieniony runtime
wymagają bieżących pins; historycznych 35-migration PASS nie przepisywać.
Po migracji produkcja wyłącznie observation i dry-run: deletion_enabled=0,
approval_reference=NULL. Pierwszy rzeczywisty DELETE pozostaje NIEZATWIERDZONY;
przedstawić exact item/report/file/version/hash/due/dependency scope z readback
i uzyskać osobną zgodę. Nie aktywować cleanup na podstawie samej decyzji produktu.
Nie usuwać istniejących kopii. Przy unknown Analytics po północy wolno ponowić
jedynie bounded metadata Analytics/inventory po niezależnej pracy; żadnego
powtarzanego D1 SQL/capture w celu szukania quota. Integrity/recovery trwałe.

Zweryfikowano lokalnie oryginalny backup 35→37 i restore po purge. Kopia z
8 października nadal chroni swój historyczny cut, ale o 00:00 UTC ma >29h;
świeży capture może być uzasadniony RPO/canonical delta, jeśli cadence nie ma
już nowszej niezależnie zweryfikowanej kopii. Nie tworzyć kolejnej tylko dla PASS.
