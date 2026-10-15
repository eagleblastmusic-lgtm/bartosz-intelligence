# Bartosz Intelligence — wdrożenie produkcyjne i odbiór

Data: 15.10.2026, Europe/Warsaw. **DEPLOYED; E2E VERIFIED; MANUAL20 PASS.**
Kontrolowany odbiór Free zakończono z zapasem. Okno obserwacji 24–72 h jest w toku.

Aktualny Worker: `901e9506-5924-4e96-9735-19f43ee9a1d3`, 100%; Oracle: `116f52d8…3210e`.
Aktywne są dokładnie zatwierdzone 20 kanałów. Manualny cykl zakończył 20 kontroli
w 86,773 s, bez błędów, duplikatów i importu historii. Canary TED zachował 226 cue,
pełny tekst/ms/hash, trzy artefakty i prywatne pliki JSON/Markdown na Drive.
Harmonogram 15:00/23:00 Europe/Warsaw pozostaje aktywny; AI OFF i DELETE OFF.

Aktualny odbiór i ograniczenia: **§20**. §1–19 zachowują historyczne próby i statusy.
Pełna doba Free, 100 filmów dziennie i soak 24–72 h pozostają niepotwierdzone.
Godzinowe wznowienie odczytowego odbioru utworzono w Codex; jego pierwszy run
jeszcze nie został potwierdzony. Pipeline produkcyjny nie zależy od tego monitora.

## 1. Wynik końcowego preflight i granica zgody

**GO do kontrolowanego wdrożenia**, z obowiązkowym świeżym backupem i odtworzeniem
przed migracją oraz pełnym canary przed aktywacją 19 kolejnych kanałów.
Ocena Etapu A poprzedzała zgodę. Właściciel następnie przekazał wyraźne GO
na zakres kontrolowanego wdrożenia i warunkowej aktywacji kanałów.
[Zapis zakresu zgody](OWNER_GO.json). Dalsze odczyty w tej sekcji opisują
historyczny baseline przed wdrożeniem; aktualny stan zawiera §15.

Właściciel potwierdził boot volume: 47 GB, Balanced 10 VPU/GB,
2820 IOPS, 22,56 MB/s, status „Dostępne”, oznaczenie „Zawsze bezpłatne”,
replikacja i autotuning wyłączone. Parametry mają wynik **PASS_OWNER_VERIFIED**;
nie przypisujemy ich ponownemu samodzielnemu odczytowi agenta.
[Potwierdzenie właściciela](OWNER_BOOT_VOLUME_CONFIRMATION.json).

Inventory w widocznym głównym przedziale Frankfurt pokazuje jeden boot volume
i brak dodatkowych block volumes. Następna strona jest nieaktywna; selektor
przedziałów pokazuje tylko root. Odczyt subskrypcji regionów wskazuje jeden
READY region, Frankfurt, będący home region. W tym zakresie jest 47/200 GB,
pozostaje 153 GB. Nie zmieniano woluminów, IAM ani ustawień billing.
[Inventory](ORACLE_VOLUME_INVENTORY_REVIEW.json).

Konsola potwierdziła Free Tier/trial, regionalne użycie A1 1 OCPU / 6 GB
i koszt 0,00 PLN za 1–15 października. Billing ma około 24 h opóźnienia;
widoczne wiersze dotyczą 12–14 października, nie bieżącej doby.
Poprzednia odmowa CLI i konflikt IndexedDB pozostają w historii dowodów,
ale nie blokują już oceny parametrów dysku. Agent nie czyścił Chrome.

Połączona wtyczka Cloudflare odczytała aktywny deploy, D1, Queue,
SELECT metadanych i GraphQL. Lokalny pomocniczy odczyt wybrał starą lokalizację
OAuth i otrzymał 401; poprawiono pierwszeństwo lokalizacji wskazanej przez
oficjalne CLI. Istniejący klient wdrożeniowy od początku używa oficjalnego
Wrangler auth i wykonał poprawny GET oraz SELECT. Nie ujawniono tokenów.

Aktualna produkcja ma 40 zgodnych migracji, 1 aktywny kanał, backlog Queue 0,
aktualny heartbeat Oracle i DELETE OFF. Nie ma gotowego backlogu FETCH: 45
SUCCEEDED, 19 BLOCKED, 1 DEFERRED. Nie zaplanowano masowego historycznego retry.
[Metadane](CONTROL_PLANE_REVIEW.json), [logowanie narzędzia](DEPLOYMENT_AUTH_READINESS.json).

Drive pozostaje CONNECTED, bez ostatniego błędu; wolne miejsce z wcześniejszego
odczytu UI wynosi 14,59 GB. Świeża walidacja grant wymaga refresh i jest
odłożona do GO zgodnie ze zleceniem. Jest warunkiem canary oraz aktywacji
pozostałych kanałów. Nie przenosimy OAuth na Oracle.

**FREE VERIFIED nowej wersji nadal UNVERIFIED**, E2E NOT_RUN i soak NOT_STARTED.
Bieżące zasoby oraz zmierzone liczniki dają zapas na ograniczony canary.
CPU/SQL/Drive readback nowego kodu muszą przejść rzeczywisty odbiór.
Brak pełnego canary lub przekroczenie limitów zatrzymuje aktywację 19 kanałów.

Przed pierwszym backup barrier/export, migracją, zapisem konfiguracji, deployem,
restartem lub aktywacją wymagane jest **osobne GO**, zgodnie z §3 promptu
właściciela. „Dysk gotowy” potwierdza odczyt, nie autoryzuje wdrożenia.

## 2. Repozytorium i dokładne wydanie

Gałąź: `codex/remote-daily-reports`. HEAD:
`ea15d283fe9097edb7deae152170f0fd86d4d527`.
Zmiany implementacji pozostają niezatwierdzone commitem, z nowymi plikami.
Zachowano zastane materiały i working tree. Sam HEAD nie identyfikuje paczki.

Finalna paczka Oracle ma 815 plików, 1 378 125 bajtów i SHA-256:
`99585d9259044d4b72003a58861f077c94dcc2bb49207227cd3ffb1eb2309b89`.
Lokalizacja: `.local/production-readiness-20261015/oracle-final/executor.tar.gz`.
Wszystkie bajty paczki porównano z working tree; powtarzalność potwierdza test.
Pełny manifest: [RELEASE_MANIFEST.json](RELEASE_MANIFEST.json).

Worker z rzeczywistej konfiguracji produkcyjnej zbudowano przez `--dry-run`:
1 752 926 bajtów, SHA-256
`a6b8458d86021fcfa499bf0c95bf718fe3d3961172e643e33cadeb217e5ee00d`.
Paczka i mapy znajdują się w `.local/production-readiness-20261015/worker`.
Zachowano hashe zbudowanych assetów. Skan 13 rzeczywistych lokalnych sekretów
nie znalazł ich wartości w Oracle tar ani w Worker JS.

Silnik `mweb + persistent session + Subs Proof-of-Origin + yt-dlp`, broker,
systemd units, runtime-lock, Python requirements, package manifest i lockfile
są identyczne z działającym wydaniem Oracle. Nie potrzeba nowych zależności.

## 3. Dodatkowe poprawki wykryte w preflight

1. `tools/deployment/oracle/release.py` pomijał nowe nieśledzone moduły compact
   i migracje 041–043. Uzupełniono jawną listę plików bez dołączania zastanych
   eksperymentów, prywatnych plików czy katalogów zależności.
2. `packages/core/src/jobs/recovery.ts`, `apps/api/src/scheduled.ts`
   i `apps/api/src/index.ts`: wyłączone automatyczne ANALYZE nie są ponownie
   promowane, sygnalizowane ani wysyłane przez outbox w maintenance.
   Historyczne jobs/outbox pozostają niezmienione. Jawne włączenie funkcji
   opcjonalnej nadal umożliwia obsługę zachowanego intentu.
3. `tests/unit/oracle-deployment.spec.ts` weryfikuje pełne bajty, wymagane nowe
   pliki, brak prywatnych plików i deterministyczną paczkę.
   `tests/workers/jobstore.spec.ts` sprawdza zachowanie starych ANALYZE bez
   kolejnych hintów oraz dalszą obsługę FETCH_TRANSCRIPT.
4. `tests/workers/monitoring-cycles.spec.ts`: istniejący test rozszerzono o
   manualny cykl 20 kanałów o 01:50 Warsaw, poza godzinami harmonogramu.
   Istniejące porcje i Queue kończą wszystkie kontrole, duplicate intent nie
   tworzy nowych zadań, a slot pozostaje `MANUAL:fixture`.
   Test pakowania działa w checkout; w immutable release bez Git nie jest
   właściwą operacją. Tam obowiązkowe `release.py verify` sprawdza odebrane bajty.

Przyczyną drugiej poprawki był rzeczywisty stan produkcji: 1298 wysyłek hintów
ANALYZE przy nieaktywnym wykonawcy analizy. Nie skasowano tych rekordów.
Nie przypisujemy całych 324 zakończeń Queue `fail` wyłącznie temu problemowi;
to wymaga korelacji, której obecne logi nie zapewniają.

## 4. Aktualna produkcja Cloudflare

Odczyt 15.10.2026 ok. 01:10 Warsaw, API + panel istniejącego konta:

| Właściwość                          | Stan                                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| Worker                              | `bartosz-intelligence`                                         |
| Deployment ID                       | `db7fca38-df83-4cab-842c-897d1c74ebaa`                         |
| Aktywna wersja (100%)               | `39edd639-eba3-40bb-93c7-022f1aec31d6`                         |
| Plan                                | `Workers Free`, Active — panel Billing                         |
| Cron                                | `*/5 * * * *`                                                  |
| D1                                  | `bartosz-intelligence-core`, poprawny binding                  |
| Queue                               | `bartosz-intelligence-signals`, producer/consumer tego Workera |
| Queue batch / concurrency / retries | 1 / 1 / 0                                                      |
| Queue delivery delay                | 0 s; `max_wait_time_ms=5000` jest batching timeout             |
| Backlog w chwili odczytu            | 0 wiadomości / 0 bajtów                                        |
| Health                              | HTTP 200, wszystkie DB/Queue/Assets bindings obecne            |

Wartości nowych `MONITORING_SLOTS`, `AUTOMATIC_AI_ENABLED` i
`RETENTION_DELETION_ENABLED` nie są jeszcze wdrożone. Odczytano tylko nazwy
sekretów, bez ich wartości. CONTROL ma DISCOVER/RECONCILE, exporter DRIVE_EXPORT;
lokalne credentials odpowiadają bieżącym hashom D1. Transcript identity Oracle
ma wyłącznie FETCH_TRANSCRIPT. Historyczny Windows transcript worker jest revoked.

API subskrypcji odmówiło odczytu (403); plan potwierdza panel właściciela.
Istniejąca subskrypcja R2 Paid dotyczy innych zasobów konta: ten Worker nie ma
bindingu R2. Nie traktujemy całego konta Cloudflare jako konta bez płatnych usług.

Wtyczka Cloudflare potwierdziła tożsamość `eagleblastmusic@gmail.com`.
Końcowy odczyt przez wtyczkę potwierdził HTTP 200 dla deployment, D1, Queue,
SELECT metadanych i GraphQL. Poprzednia chwilowa niedostępność metod nie jest
bieżącą blokadą. Oficjalne CLI Wrangler i istniejący klient wdrożenia również
wykonały poprawne odczyty. [Dowód połączenia](CLOUDFLARE_CONNECTOR_REVIEW.json).

## 5. Aktualny D1 i legacy

Odczyt ledger: **40/40 zgodnych checksums**, brakujące tylko 041–043.
`quick_check=ok`, zero naruszeń foreign keys.
W chwili próbki: 65 items, 552 jobs, 3393 attempts, 244 artifacts,
616 artifact_chunks, 58 runs, z czego 45 ACCEPTED. 45 archiwów ma VERIFIED.
Odczyty metadanych D1 nie zapisały żadnego wiersza.

Próbki rozmiaru: lista D1 27 787 264 B; późniejsze metadane SQL
29 962 240 B. Są to odczyty w różnych chwilach, nie zmierzony wzrost wywołany rollout.
Druga baza konta: 2 899 968 B, uwzględniona w account-wide metrykach.

| Brakująca migracja                 | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| 041_monitoring_cycles.sql          | `032f6625e722f593797c31b2fbc5974019c484db4253e5f24268a4f728c69d5d` |
| 042_caption_retry.sql              | `b4190d00351946c88d7c4a20a519a21651fe060cc092709c6e52d43a21f87a10` |
| 043_transcript_payload_archive.sql | `0f2dce9cefaef1cb1b0acde72d73fa22e09fa9620b767d14048079f73b090220` |

Migracje wykonano **wyłącznie na lokalnej kopii** starego schematu 40.
Po 43: integrity/FK PASS, liczby kanonicznych rekordów zachowane;
SHA-256 całych starych danych items/jobs/runs/artifacts/chunks/archives nie zmieniły się.
Nowe kolumny/receipts nie były przedstawiane jako część starego hash.
W kopii portable ledger odtworzono lokalnie z wcześniej zweryfikowanego manifestu;
nie podmieniano produkcyjnego ledger. Odrębny restore portable do aktualnego
schematu też odczytał i zweryfikował wszystkie 12 175 kanonicznych rekordów.

## 6. Oracle — rzeczywisty odczyt

VM RUNNING, `VM.Standard.A1.Flex`, 1 OCPU / 6 GB RAM,
region macierzysty Frankfurt. W widocznej liście root compartment jest jedna VM.
Dodatkowy odczyt konsoli o 02:08 Warsaw potwierdził łączne regionalne użycie A1:
1 OCPU i 6 GB RAM. Limity usługi podczas trial wynoszą 16 OCPU / 96 GB;
nie są bezpłatnym przydziałem. Aktualna dokumentacja podaje 1500 OCPU h i 9000
GB h miesięcznie, odpowiednik 2 OCPU / 12 GB. Istniejąca VM mieści się w tej
puli; przy 31 dniach jej stały przydział odpowiada 744 OCPU h / 4464 GB h.
To wyliczenie przydziału, a nie odczyt rozliczonego użycia miesięcznego.
[Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

Koszt widoczny w konsoli: 0,00 PLN, z opóźnieniem danych około 24 h.
Boot volume znaleziony przez globalne wyszukiwanie:
`ocid1.bootvolume.oc1.eu-frankfurt-1.abtheljrpjagic7y6oifz6f2jhbrrilycixhbzhtrmtnntwsq73urduncjyq`.
Rozmiar filesystemu z SSH nie zastępuje jego rozliczanego rozmiaru i klasy.
Pojemność/klasa mają PASS_OWNER_VERIFIED. Inventory w widocznym root/home region
potwierdza jeden boot volume i brak dodatkowych block volumes: 47/200 GB.
Nie powtarzano odczytu parametrów dysku; źródłem jest potwierdzenie właściciela.

Aktywne wydanie:
`7a6339c1dcafdd1d825c35b8daa609795ff1cb85ea8ca6d614844800f1a41505`.
Manifest 716 plików: wszystkie hashe zgodne. Lokalnie zachowano dokładną paczkę
tego wydania i porównano jej manifest z manifestem pracującej VM.
Obie usługi `bartosz-executor` i `bartosz-caption-broker` są active/running/enabled,
NRestarts=0. Executor PID 63718, broker PID 62168.

Próbka: executor MemoryCurrent 56 131 584 B, MemoryPeak 58 822 656 B;
broker 11 796 480 B, peak 27 893 760 B. VM MemAvailable ok. 5,40 GB;
wolny dysk 40 199 446 528 B. Jednosekundowa próbka CPU hosta 28,713% nie jest
średnią dobową ani kosztem zadania. Liczniki sieci są od bootu, nie dobowe.
Runtime Node 24.21.0 / Deno 2.9.7 ARM64 / Python 3.12.3.
Przeanalizowano 612 zredagowanych zdarzeń journald; ostatnie cykle były idle.

Sesja YouTube istnieje; katalog i cookies mają 0700/0600. Odczytano wyłącznie
obecność, rozmiar, mode, UID i mtime. Nie importowano ani nie zmieniano sesji.
Heartbeat Oracle jest aktualny. Jest to dowód aktywności starej wersji.
Ostatnie udane dwa materiały są z poprzedniego wdrożenia; późniejsze zadania
zakończyły się `LOCAL_YTDLP_UNAVAILABLE`. Canary po GO musi wyjaśnić rzeczywisty
wynik na minimalnej próbce; nie utożsamiamy aktywnej usługi z poprawnym pobieraniem.

## 7. Google Drive i ChatGPT

Połączenie D1: CONNECTED, PRODUCTION, root VERIFIED; scopes `drive.file` + `openid`,
bez ostatniego błędu. `last_refresh_at=2026-10-14T19:05:55.253Z`.
Świeżego grant nie pozyskano przed GO. Nie przenoszono OAuth na Oracle.

Panel tego samego właściciela: 15 GB limitu, 420,2 MB zajęte łącznie,
**14,59 GB wolne**; sam Drive 312,2 MB, Gmail 107,9 MB. To zaokrąglone dane UI,
nie dokładne wartości bytes. Wystarczają na kontrolowany canary i metadane 20 kanałów;
nie są gwarancją nieograniczonej retencji.

Folder archiwum `1bNqbMUjrU4HEBh45nHV-embobIPuhHtt` zawiera 45 Markdown,
w tym wcześniejsze canary. Dostępne są istniejące foldery Transkrypcje
`12dfjXGqDL7hFKsGvTxp_3CVi78V8YdSP` i Streszczenia
`1dpd-8GV-S675Jhv4zWdlldaIiJOy5XDt`. Transkrypcje Daily są obecnie puste,
`daily_workflow_settings` nie ma rekordu. Nie oznaczamy Daily workflow jako aktywnego.
Nie zmieniano dokumentów lub zadań ChatGPT i nie powtarzano podstawowego testu
odczytu Drive przez ChatGPT. Odbiór musi zweryfikować prywatność i świeży readback
obu plików nowego compact bez ingerowania w wcześniejsze foldery/dokumenty.

## 8. Rzeczywiste metryki Free

Próbka GraphQL obejmuje **14.10.2026 00:00–23:11:41 UTC**,
czyli 02:00 14.10–01:11:41 15.10 Warsaw. Jest prawie dobą, ale nie zamkniętą dobą.
Analytics może mieć opóźnienie. Nie wyznacza dokładnej pozostałej kwoty.

| Metryka                               | Rzeczywisty odczyt                        | Odniesienie                              |
| ------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| Workers — Bartosz                     | 12 353 requests, 1 error, 403 subrequests | 100 000 requests/dobę dla konta Free     |
| Workers — inne widoczne               | 1 request                                 | limit jest account-wide                  |
| D1 account-wide                       | 556 047 rows read, 19 772 rows written    | 5 mln / 100 tys. dziennie                |
| D1 query counts                       | 46 318 read, 9786 write queries           | nie jest liczbą SQL na Worker invocation |
| Queue account-wide, późniejsza próbka | 1645 billable operations                  | 10 000 dziennie                          |
| Queue delete outcomes                 | 218 success, 324 fail, 0 dlq              | retryCount w grupach fail=0              |
| Queue backlog                         | 0                                         | próbka punktowa                          |
| CPU panel                             | account P90=5 ms; Worker lista=4,4 ms     | brak pomiaru nowego kodu                 |
| Workers billable usage panel          | $0.00, okres 01.10–01.11                  | aktualny display, nie końcowa faktura    |

Zachowano również surowe kwantyle GraphQL, np. maksimum grupowego P99 `114266`;
nie użyto niepotwierdzonej jednostki do kwalifikacji CPU ani nie uśredniono kwantyli.
Nowego kodu nie wykonywano na Cloudflare. CPU/SQL/memory poszczególnego nowego
invocation, przyrost Drive i koszt rzeczywistego compact wymagają canary po GO.

Wskaźniki requests/rows/Queue nie wykazują wyczerpania w tej próbce.
Jednak **FREE VERIFIED całego pipeline pozostaje UNVERIFIED** z powodu braku
rzeczywistego canary i dobowych obserwacji nowej wersji. Odczyt OCI uzupełniono.
Model 100 długich filmów/dzień
z poprzedniego raportu przekracza 15 GB Drive w 30 dni; nie jest celem tego rollout.
DELETE OFF oznacza również konieczność obserwacji wzrostu bufora D1.

Źródła limitów: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/).
Same limity dokumentacji nie zastępują odczytów konta powyżej.

### Końcowa próbka 15.10.2026 UTC i zapas na canary

Odczyty połączonej wtyczki: [METRICS_REVIEW.json](METRICS_REVIEW.json).
Okna komponentów różnią się; są częściową dobą UTC. Nie są pełnym pomiarem
dobowym ani odbiorem nowej wersji.

| Licznik                        | Pomiar  | Koniec okna UTC | Limit Free / dobę   |
| ------------------------------ | ------- | --------------- | ------------------- |
| Workers requests / errors      | 738 / 0 | 00:37:48        | 100 000 requests    |
| D1 rows read                   | 35 824  | 00:56:45        | 5 000 000           |
| D1 rows written                | 3 952   | 00:56:45        | 100 000             |
| Queues operations              | 416     | 00:56:45        | 10 000              |
| Queue DeleteMessage fail / DLQ | 16 / 0  | 00:56:45        | klasyfikacja wyniku |

Limity zweryfikowano w aktualnych źródłach dostawcy:
[Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[Queues](https://developers.cloudflare.com/queues/platform/pricing/).
D1 ma 30 040 064 B. Queue GET o 00:46 UTC: backlog 0 / 0 B.

Między 00:36:13 a 00:56:45 przybyło 182 rows written i 15 operacji Queue.
Ekstrapolacja wyłącznie tego ostatniego tempa: około 12 757 writes/dobę
i 1051 Queue operations/dobę. To **estymacja**, opóźnienie analytics niezmierzone.
Początkowego wzrostu z początku doby nie traktujemy jako stałego tempa.
Nie wyjaśniono wszystkich Queue fail; canary i obserwacja mają potwierdzić
stan po wyłączeniu nowych i odzyskiwanych automatycznych ANALYZE.

Pierwsza odpowiedź narzędzia przycięła szczegóły Workers; nie sumowano
przyciętych danych. Powtórny odczyt agreguje cały wynik przed wysłaniem:
392 grupy, poniżej limitu 10 000, wszystkie 738 requestów success.
CPU pozostaje surową kwantylą grup (max P99 66378, jednostka niezweryfikowana);
nie przedstawiamy tego jako CPU nowej wersji ani maksimum invocation.

Zapas liczników pozwala rozpocząć ograniczony canary 1–2 materiałów;
brak gotowego FETCH backlogu pozwala uniknąć uruchomienia szerokiego retry.
Go nie oznacza potwierdzenia Free dla 30/100 filmów dziennie ani
nieograniczonej retencji przy DELETE OFF. Nowe CPU, wzrost D1/Drive
i rzeczywiste próby są warunkami odbioru przed rozszerzeniem monitoringu.

## 9. Backup i rollback

Backup `46e0d938-ef02-4d55-8e5c-beca1d043ca8`: cut z
14.10.2026 20:05:48 Warsaw. W momencie walidacji miał 5,48 h;
24 412 529 B, hash `c5619988a9b9594ab1aaf1b67e7acf9f1f083f7a2241682c0fa31686e6387b45`.
Hash obecnego prywatnego pliku odpowiada receipt. Powtórny izolowany restore:
12 175 rekordów / 24 105 670 kanonicznych bajtów, content readback/integrity/FK PASS,
bez odtworzenia aktywnych sesji i worker credentials. W Drive widoczna kopia tego UUID;
wcześniejszy hash-bound transfer receipt zachowany, nie relabelowany jako nowy readback.

**Świeży backup bezpośrednio przed migracją jest obowiązkowy po GO.**
Portable drill zakłada produkcyjną barierę i zapisuje receipts, więc nie uruchomiono
go w Etapie A. Dla obecnego schematu 40 wykorzystać istniejący SQL export fallback
`tools/deployment/pre-upgrade-backup.mjs`, który dynamicznie obejmuje obecne tabele,
odtwarza FTS i wykonuje lokalną próbę brakujących migracji. Nie uruchamiać obecnego
drillu formatu 43 przeciwko schematowi 40: lista tabel nie jest jeszcze zgodna.
Backup SQL jest prywatny; sprawdzić ACL katalogu i nie publikować dumpu ani credentials.
Po zgodnym wdrożeniu można wykonać canonical drill nowego schematu.

Zachowano aktywny Worker przez odczyt `content/v2`: 1 707 486 B,
SHA-256 `344e0c606b4241550d8efe950c2bc29afad60069cebea17a2037647eb7a3de04`.
Receipt obejmuje wersję, content type i entrypoint. Zachowano bieżącą paczkę Oracle.

Rollback przed pierwszym compact: poprzedni Worker i executor, bez cofania migracji.
Rollback po zapisaniu compact: pozostawić API obsługujące v1 i v2; wstrzymać nowego
executora, przełączyć nowe pozyskania na LEGACY, ewentualnie odtworzyć poprzedni
kompatybilny executor. Przed ponownym startem zweryfikować manifest i credential.
Nie cofać Workera do `39edd639...`, jeżeli są już accepted `transcript-source:2`.
Nie usuwać migracji, nie nadpisywać D1 backupem, nie usuwać nowych Drive files.
Przy awarii Workera po compact wstrzymać rollout i zachować kompatybilny czytnik;
pełna zamiana bazy i inne destrukcyjne działania wymagają odrębnej decyzji.

## 10. Lokalna weryfikacja gotowej delty

| Kontrola                                          | Wynik                                 |
| ------------------------------------------------- | ------------------------------------- |
| Pakowanie + jobs regression                       | 7/7 PASS                              |
| Pełne Workers/D1 po poprawce                      | 291/291 PASS                          |
| Unit schedulera                                   | 2/2 PASS                              |
| Końcowy test manual 20 / scheduled 30 i pakowania | 6/6 PASS, lokalne fixtures            |
| Typecheck wszystkich workspace/tools/testów       | PASS                                  |
| Lint zmienionej delty                             | 6 plików, 0 errors/warnings           |
| Root build + produkcyjny config `--dry-run`       | PASS                                  |
| Kontrola migracji fresh/restore/FK                | 43 PASS                               |
| Próba 40→43 na prawdziwym backupie                | PASS, stare content hashes identyczne |
| Konfiguracja / format / `git diff --check`        | PASS                                  |
| Piny runtime i secret scan paczki                 | PASS                                  |
| Testy nowego wydania na produkcji                 | NOT_RUN — przed GO                    |

7 testów zawiera powtórzenie 3 testów jobs z pełnego zestawu Workers;
końcowe 6 powtarza testy pakowania i zaplanowanego cyklu. Nie sumujemy tych
uruchomień jako liczby unikalnych testów. Końcowe typecheck tools/Workers PASS.
Wcześniejsze 917/917 z lokalnej implementacji pozostają osobnym aktualnym dowodem
dla niezmienionych części. Nie przedstawiamy ich jako nowego odbioru produkcyjnego.

## 11. Dokładna kolejność po uzupełnieniu readiness i GO

1. Ponownie odczytać budżet bieżącej doby UTC, ledger, wersje i aktywne leases.
   Porównać source/paczki/assets z finalnymi hashami; zmiana bajtów wymaga ponownej kwalifikacji.
2. Wykonać świeży istniejący SQL backup, kontrolę private-copy hash oraz odtworzenie
   w nowej izolowanej bazie. Zweryfikować wszystkie tabele i próby migracji.
   Zachować bieżący Worker, executor i wersje konfiguracji. Brak pełnego backupu zatrzymuje rollout.
3. W istniejącym narzędziu `prepare.mjs migrate` zastosować wyłącznie brakujące
   041→042→043 po ponownym sprawdzeniu checksums. Następnie ledger 43,
   schema/trigger/FK, liczby i integralność legacy. Nie wykonywać DELETE.
4. Wdrożyć przetestowany Worker z `MONITORING_SLOTS=15:00,23:00`,
   `AUTOMATIC_AI_ENABLED=false`, `RETENTION_DELETION_ENABLED=false`;
   Queue batch/concurrency=1. Zachować istniejące sekrety i ich uprawnienia,
   bez rotacji i płatnych opcji. Sprawdzić deployment/version, health, bindings,
   backlog i odczyt historycznego accepted source. Przed krokiem Oracle API musi obsługiwać compact.
5. Przekazać paczkę Oracle o hash `99585d92...9b89`; zweryfikować pełny manifest
   i zgodność istniejących zależności, wykorzystać obecny runtime/node_modules.
   Ustawić COMPACT, zachować concurrency=1 i credential, przełączyć immutable
   release symlink, zrestartować tylko executor. Broker i sesja pozostają zachowane.
6. **Canary istniejącego TED**: natychmiastowa ręczna kontrola i maks. 1–2 rzeczywiste
   materiały; preferować nowy nieskopiowany film z oryginalnymi napisami.
   Istniejące pomyślnie zarchiwizowane ID nie są automatycznie ponownie pobierane.
   Obserwować naturalny termin +10 min; nie zmieniać zegara ani polityki retry.
   Nie aktywować pozostałych kanałów, dopóki nie ma pełnego YouTube→Oracle→Drive PASS.
7. Zweryfikować RAW/cue count/tekst/start-end ms/language/manual-generated,
   3 compact artifacts i accepted hash. Następnie trwały archive intent, stable IDs,
   obydwa pliki, Drive GET readback/hash/version/parent/privacy i dokładne odtworzenie.
   Odczyt źródłowych bytes jest niezależny od hasha ponownie wygenerowanego dokumentu.
8. **Dopiero po canary PASS aktywować dokładnie 19 zatwierdzonych dodatkowych kanałów**,
   używając `addSource` + `backfillWindow(now,'only-new')`, stabilnych idempotency keys
   i rzeczywistego czasu aktywacji. Nie dodawać innych kanałów. Początkowe okno jest
   zerowe, co zapobiega pobraniu całej historii. Zastane TED/historia pozostają zachowane.
9. **Od razu kontrola ręczna 20 kanałów**, bez czekania do 15:00/23:00.
   Wykorzystać jednorazowy record `monitoring_cycles` ze slotem `MANUAL:<uuid>`
   i dokładnym snapshotem 20 źródeł oraz istniejące `enrollMonitoringBatch`/Queue
   continuation. Slot MANUAL jednoznacznie odróżnia test od cykli planowanych;
   nie zmienia automatycznych slotów ani zegara. Używać rzeczywistego now.
   Porcje 5, channel checks przez istniejący fenced controlTick i konsumera,
   żadnych nieograniczonych pętli w invocation. Deduplikacja cycle/source/job/accepted
   pozostaje aktywna; nie wyzwalać powtórnych skanów dla zdublowanego manual intentu.
10. Zapisać dla każdego z 20 kanałów job ID, scan ID, pages_committed,
    rzeczywisty completed/outcome/receipts, found count, due fetch i dedup.
    Cykl nie jest PASS na podstawie samego enqueue. Błędy/quota zachowują due/backoff.
    Sprawdzić backlog i przyrost metryk konta; znacząca regresja zatrzymuje aktywację.
11. Sprawdzić brak automatycznych ANALYZE/PROJECT i zbędnych manifestów/OFFSET_MAP,
    legacy access i dokumenty Drive. Retention DB + env pozostają OFF.
    Dopuszczalny tylko payload dry-run po fresh Drive readback. Bez canary eviction.
12. Zebrać timeline published/detected/fetch/provider/parse/transport/accepted/archive/verified,
    oddzielając +10 min, scheduler i retry od wykonania. Następnie obserwacja rzeczywistych
    15:00/23:00 oraz 24–72 h, z osobnymi statusami deployment/E2E/Free/soak.

Manual record wykorzystuje istniejący model i mechanizmy, bez nowej kolejki/usługi/API.
Dokładny zestaw i zgoda warunkowa są zapisane w [ACTIVATION_PLAN.json](ACTIVATION_PLAN.json).
Wsparcie 30 kanałów potwierdzają wcześniejsze lokalne rzeczywiście zakończone checks;
produkcyjny test 20 nie jest dowodem produkcyjnej konfiguracji 30.

## 12. Soak, ryzyka i następny krok

Soak: **NOT_STARTED**. Nie skonfigurowano nowego harmonogramu obserwacji i nie
obiecujemy pracy w tle. Istniejący collector/cadence na Windows może zbierać
odczyty, lecz nie dowodzi autonomii monitorowania przy wyłączonym Windows.
Po GO przygotować istniejący read-only collector na Oracle lub zbierać metryki
platformy w rzeczywistych oknach; zachować jego jawny receipt i czas startu.
Nie aktywować kolejnego płatnego monitora. Sam enabled systemd i idle heartbeat
nie dowodzi 24–72 h nowego pipeline.

Pozostałe ryzyka: skończona pojemność bezpłatnych zasobów;
opóźnienie odczytanego billing OCI około 24 h; ostatnie provider failures;
324 Queue fail; stare ANALYZE pending (zachowane, filtrowane nowym kodem);
wykonawcy Windows NORMALIZE/PROJECT mają jeszcze heartbeat, więc odbiór musi
rozróżnić ich używane funkcje od automatycznej analizy; Daily workflow nie jest
aktywowany; CPU nowej wersji na Free jest jeszcze niezmierzone; D1 payloady
rosną przy DELETE OFF; Drive ma skończoną pojemność i może odwołać grant.

GO, świeży backup, restore i wdrożenie zostały wykonane. Najbliższy krok:
rozwiązać konkretne błędy ujawnione przez rzeczywisty canary, zweryfikować
poprawki i uzyskać zgodę na ewentualne odstępstwo wykraczające poza dotychczasowy
zakres. Aktywacja 19 kanałów pozostaje warunkowa względem pełnego canary i limitów.
Płatności, DELETE/eviction, podmiana bazy, zmiana sesji YouTube, commit/push/merge
oraz inne kanały pozostają poza zatwierdzonym zakresem.

## 13. Dowody i czasy

Wszystkie pliki w tym katalogu są nowymi dowodami Etapu A; daty JSON są ISO UTC
lub zawierają jawny offset. Są odczytami i lokalnymi próbami, nie receipt deployment.

| Czas Warsaw 15.10.2026 | Operacja                                                                      | Dowód                                             |
| ---------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| 01:08                  | Pierwszy CF odczyt odrzucony: wygasłe lokalne OAuth, bez produkcyjnego zapisu | następny odczyt po lokalnym refresh               |
| 01:09                  | SSH read-only: usługi/manifest/RAM/dysk/session stat                          | ORACLE_PREFLIGHT.json                             |
| 01:10                  | CF version/settings/Cron/Queue/D1 metadata                                    | CLOUDFLARE_PREFLIGHT.json                         |
| 01:12                  | Usage UTC do chwili próbki                                                    | CLOUDFLARE_METRICS.json, METRICS_SUMMARY.json     |
| 01:14                  | Ledger i integrity/fk                                                         | D1_PREFLIGHT.json                                 |
| 01:17                  | Jobs, receipts, credentials scopes/hash-match, Daily state                    | JOBS_PREFLIGHT.json                               |
| 01:22                  | OCI costs/limits read denied                                                  | OCI_LIMITS_COST.json                              |
| 01:23                  | Lokalna próba 40→43                                                           | BACKUP_MIGRATION_REHEARSAL.json                   |
| 01:30                  | OCI actual home region i inventory                                            | OCI_RESOURCE_INVENTORY.json                       |
| 01:34                  | Final candidate/previous packages i engine comparison                         | RELEASE_MANIFEST.json                             |
| 01:35                  | Zestaw 20 + backup private hash/freshness                                     | ACTIVATION_PLAN.json, BACKUP_PREFLIGHT.json       |
| 01:36                  | Local test evidence i secret scan                                             | LOCAL_TEST_RESULTS.json, PACKAGE_SECRET_SCAN.json |
| 01:53                  | Końcowy manual/packaging regression, repack i byte verification               | LOCAL_TEST_RESULTS.json, RELEASE_MANIFEST.json    |
| 02:07                  | Konsola Oracle: Free Tier/trial, koszt 0 PLN; opóźnienie około 24 h           | ORACLE_CONSOLE_PREFLIGHT.json                     |
| 02:08                  | Konsola Oracle: regionalne użycie A1 1 OCPU / 6 GB                            | ORACLE_CONSOLE_PREFLIGHT.json                     |
| 02:16                  | Global search: właściwy boot volume; panel pusty, konflikt lokalnej IndexedDB | ORACLE_CONSOLE_PREFLIGHT.json                     |
| 02:17                  | Dokładny boot volume GET przez CLI: brak uprawnień, bez zmian                 | OCI_VOLUME_GET.json                               |

Queue realtime/operations: QUEUE_METRICS.json. Kopia starego Workera i health:
WORKER_ROLLBACK_COPY.json. Panel planu/Drive: BROWSER_READONLY_OBSERVATIONS.json.
Pełne ścieżki prywatnych danych nie są instrukcją ujawnienia ich treści.

## 14. Zamknięcie Etapu A

Ocena przy zamknięciu Etapu A: **GO w opisanym kontrolowanym zakresie**.
Osobne GO właściciela otrzymano następnie i zapisano w OWNER_GO.json.
Oracle/woluminy, połączenie narzędzi, prefiks migracji, pakiety i lokalne
dowody zostały sprawdzone. Suma udanych odczytów SQL Etapu A: 52 169 rows read,
0 rows written; obejmuje dwa dni UTC, nie jedną dobę billing.
Nie ponawiano niezmienionych testów ani podstawowego testu ChatGPT/Drive.
Świeży backup i grant Drive są obowiązkowymi krokami po GO, przed zależnymi
operacjami. Wdrażane bajty pozostają identyczne z RELEASE_MANIFEST.

Kolejność i rollback są w §11 oraz §9 powyżej. Po compact acceptance
pozostawić kompatybilny czytnik API v1/v2; w razie potrzeby LEGACY dla
nowych pobrań. Nie usuwać migracji i nie nadpisywać bazy starym snapshotem.
GO nie obejmuje DELETE/eviction, płatności, innych kanałów, zmian sesji YouTube
ani commit/push/merge.

## 15. Wykonane operacje Etapu B — stan 15.10.2026 03:36 Warsaw

| Czas UTC          | Operacja i rzeczywisty wynik                                                                                                | Dowód                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 01:13:30          | Zarejestrowano wyraźne GO właściciela; nie utożsamiamy oceny readiness ze zgodą                                             | OWNER_GO.json                                                |
| 01:14:12–01:16:02 | Świeży prywatny SQL backup, samodzielny restore, lokalne 40→43, integrity/FK PASS                                           | ../../deployment/2026-10-15T01-14-12.632Z-pre-upgrade.json   |
| 01:18:19          | Nowy grant Drive, prywatność właściwego archiwum, hash starego Markdown oraz quota PASS                                     | DRIVE_RELEASE_REVIEW.json                                    |
| 01:18:28–01:18:33 | Produkcyjne migracje 041–043; ledger 43 i wszystkie checksums zgodne; quick/FK PASS                                         | MIGRATION_RESULT.json                                        |
| 01:19:00–01:19:08 | Worker deployment 100%: version `600219c3-114c-4fc0-8dec-c886f229995e`, deployment `625030e9-a4e6-46e1-a938-2a85139a5bde`   | WORKER_DEPLOYMENT_REVIEW.json                                |
| 01:21:16          | Odczytany moduł Workera identyczny z dry-run bundle; health 200 i wszystkie bindings obecne                                 | WORKER_BYTE_REVIEW.json                                      |
| 01:22:26–01:22:28 | Oracle: immutable release 815 plików, hashe PASS, runtime check, tylko restart executora                                    | ORACLE_DEPLOYMENT.json                                       |
| 01:25:25          | Sesja testowa istniejącego allowlisted właściciela, 30 min, prywatny ACL, bez transferu sekretów na Oracle                  | OWNER_TEST_SESSION.json                                      |
| 01:26:08–01:26:19 | Manualny cykl jednego TED; Queue automatycznie zaplanowała i wykonała próbę; RSS upstream 404 → RETRY_WAIT, nie COMPLETE    | CANARY_DISCOVERY_DISPATCH.json, CANARY_DISCOVERY_RESULT.json |
| 01:29:26–01:29:50 | Jeden ograniczony manualny canary `9i1LVL3_xpU`; Oracle sam zarezerwował lease/fence 1; brak zaakceptowanego źródła         | CANARY_FETCH_DISPATCH.json, CANARY_FETCH_RESULT.json         |
| 01:31:21          | Read-only diagnoza: sesja AUTHENTICATED, mweb player 200, `UNKNOWN_SOURCE_AUTHORITY`; brak pobranego timedtext i artefaktów | ORACLE_CANARY_DIAGNOSTICS.json                               |

Backup ma 27 380 989 B i SHA-256
`47dc29a2503d8d35b1da846eeca6389cbd959adf13c9d61efeecceecfcc3b3da`.
SQL i izolowana SQLite pozostają w `.local/pre-deployment-backups` z prywatnym ACL.
Zachowano 65 items, 556 jobs, 58 runs, 244 artifacts i 616 chunks podczas lokalnej
próby upgrade. Produkcyjny pre/post check zachował dokładne metadane wszystkich
45 accepted runs, 244 artefaktów, 616 chunks i 45 zweryfikowanych Drive receipts,
oraz wszystkie wcześniejsze job IDs i item IDs. Migracje niczego nie usunęły.

Aktualny Worker ma `MONITORING_SLOTS=15:00,23:00`, `AUTOMATIC_AI_ENABLED=false`,
`RETENTION_DELETION_ENABLED=false`. D1 `deletion_enabled=0`. Queue batch/concurrency
pozostały 1, maintenance Cron `*/5` zachowany. Dokładny hash modułu:
`a6b8458d86021fcfa499bf0c95bf718fe3d3961172e643e33cadeb217e5ee00d`.
Health `LOCAL_READY` jest jedynie health check, nie dowodem E2E.

Oracle release:
`99585d9259044d4b72003a58861f077c94dcc2bb49207227cd3ffb1eb2309b89`;
poprzedni `7a6339c1dcafdd1d825c35b8daa609795ff1cb85ea8ca6d614844800f1a41505`
zachowano. Executor PID 63718→67811, broker PID 62168 bez zmiany.
Zależności, silnik, units i sesja pozostały bez zmian; dopisano tylko flagę COMPACT
do istniejącego env, z prywatną kopią konfiguracji do rollbacku. Restart count obu
usług 0. Po canary executor wrócił do prawidłowego idle polling około 30 s.
Nie cofamy addytywnych migracji ani bazy. Ponieważ błędy dotyczą źródła upstream
i wcześniejszej polityki metadanych, utrzymujemy kompatybilny API i zatrzymujemy
dalszą aktywację zamiast przywracać wersję nieznającą compact i przywracać stare AI.

Canary użył już wykrytego, publicznego materiału TED, który wcześniej miał wyłącznie
techniczny `LOCAL_YTDLP_UNAVAILABLE`; brak accepted/Drive archive. Utworzono jeden
idempotentny manualny job, zachowując stary rekord i historię. Nie ponawiano odmowy
dostępu ani completed job. To nie jest nowy historyczny backfill ani test nowego
`detected_at + 10 min` — pierwszy manualny recheck był celowo natychmiastowy.

Timeline rzeczywistego canary:

| Faza                                        | Czas / wynik                                                   |
| ------------------------------------------- | -------------------------------------------------------------- |
| published_at                                | 12.10.2026 15:00:34 UTC                                        |
| discovered_at                               | 12.10.2026 15:30:41.121 UTC, historyczny rzeczywisty detection |
| manual intent                               | 15.10.2026 01:29:26.283 UTC                                    |
| lease / fetch start                         | 01:29:33.266 / 01:29:33.540 UTC                                |
| track listing                               | 16 403 ms                                                      |
| provider runtime                            | 15 036 ms; peak process tree RSS 389 083 136 B; CPU 4 810 ms   |
| cały cykl Oracle                            | 17 292 ms, 7 RPC, 615 B request bodies                         |
| accepted / artifact upload / Drive verified | Nie nastąpiły; nie podajemy fikcyjnego czasu do Drive          |

Player i sesja były dostępne. yt-dlp nie zwrócił oryginalnego języka ani jednoznacznego
`-orig`; system poprawnie odmówił zgadywania i zakończył technicznym BLOCKED.
Oficjalne `videos.snippet.defaultAudioLanguage` tego samego video ID wynosi `en`,
ale obecny adapter nie przekazuje tej deklaracji do wyboru napisów. Nie należy
zastępować jej `defaultLanguage`, tytułem ani założeniem, że TED zawsze mówi po angielsku.

RSS TED otrzymał 404 także w niezależnym odczycie; wariant playlist i rewalidacja
nie pomogły. Oficjalne Data API poprawnie potwierdziło ten sam channel ID i uploads
playlist. Feed 404 nie dowodzi usunięcia kanału ani braku filmów/napisów.
Dosłowny warunek „RSS działa” nie ma PASS. Przygotowanie ewentualnego ograniczonego
fallbacku musi zachować oddzielny receipt transportu i wymaga jawnego zaakceptowania
odstępstwa przed uznaniem pełnego canary i aktywacją kolejnych kanałów.

Drive grant i stare archiwum zostały zweryfikowane; limit 16 106 127 360 B,
usage 440 571 840 B, wolne 15 665 555 520 B. Dwa foldery opcjonalnego, nieaktywnego
Daily są widoczne właścicielowi w UI, ale istniejący scope `drive.file` otrzymuje
dla nich NOT_FOUND. Nie zmieniono scope, folderów ani istniejących zadań ChatGPT.
Nie powtarzano podstawowego testu odczytu Drive przez ChatGPT. Nie twierdzimy,
że nowe pliki compact lub nowy raport AI zostały utworzone.

Wynik dotychczasowego odbioru: **DEPLOYED**, **CANARY NOT ACCEPTED**, **19 INACTIVE**,
**MANUAL 20 NOT RUN**, **FREE FULL PIPELINE UNVERIFIED**, **SOAK NOT_STARTED**.
Wszystkie poprawki diagnostyczne/harness pozostają lokalne; nie zmieniono produkcyjnego
silnika po nieudanym canary. Nie wykonano DELETE, payload eviction, backfillu ani
commit/push/merge. Dalszy rollout podlega warunkom wyraźnego GO właściciela.

## 16. Przygotowana naprawa po canary — stan 03:52 Warsaw

Przygotowano minimalną, kompletną lokalną deltę:
[plan i granica zgody](REPAIR_PLAN_PL.md), [dokładny patch względem wdrożonej paczki](REPAIR_DELTA.patch),
[pakiety i hashe](REPAIR_CANDIDATE.json), [testy](REPAIR_TEST_RESULTS.json).
Nie zmieniono produkcyjnego silnika ani nie wdrożono tej delty.

Poprawka dodaje do istniejącego kontraktu wyłącznie zweryfikowany
`videos.snippet.defaultAudioLanguage` i przekazuje go do obecnego wyboru ścieżki,
gdy provider nie podaje języka. Nigdy nie zgaduje z tytułu/defaultLanguage i nie
wyłącza blokady konfliktujących oryginałów ani translacji. Druga zmiana dopuszcza
przy RSS404/410 pojedynczy ograniczony uploads HEAD z osobnym receipt; inne błędy
zachowują backoff. NEW_ONLY nie importuje starych filmów ani nieznanej daty.
Wymaga to wąskiego rozszerzenia zgody: broker/CLI/parser adapter oraz jawne uznanie
fallbacku za rzeczywiste sprawdzenie kanału przy nadal niedostępnym RSS. Powodem
jest warunek właściciela „bez zmian silnika” i dosłowne kryterium RSS, nie reguła skill.

| Kontrola lokalnej naprawy                     | Wynik                                                             | Dowód                                                            |
| --------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Unit + contracts                              | 632 PASS, 1 platformowy SKIP, 0 FAIL                              | repair-unit-contracts-full.json, hash w REPAIR_TEST_RESULTS.json |
| Workers/D1                                    | 307/307 PASS                                                      | repair-workers-full.json, hash w REPAIR_TEST_RESULTS.json        |
| Python wybór/broker/parser/public assets      | 31/31 PASS                                                        | REPAIR_TEST_RESULTS.json                                         |
| Typecheck / lint / build i production dry-run | PASS                                                              | REPAIR_TEST_RESULTS.json                                         |
| Pakowanie                                     | 817 plików, dokładne bajty working tree, bez nowych deps/migracji | REPAIR_CANDIDATE.json                                            |
| Secret scan                                   | 12 rzeczywistych wartości, 823 pliki, 0 trafień                   | REPAIR_TEST_RESULTS.json                                         |

939 unikalnych testów Vitest PASS; 42 targeted są podzbiorem i nie są doliczane.
Jedyny SKIP to istniejący test odrzucenia Windows ACL helper na systemie innym
niż Windows; ten run wykonano na Windows. Kryteriów testów nie obniżano.
Początkowe błędy harnessu/typecheck zostały naprawione i opisane w JSON; lokalnych
PASS nie przedstawiamy jako nowego produkcyjnego odbioru.

Oracle kandydat:
`116f52d8aa18aceae2d9c5d8aea763ff022c2123c2167ac2d8bd9c9688f3210e`;
Worker kandydat:
`f4ead6c97e9a5ff125ad35a8b821174cff36179fe236cd2ac115f93b50231d41`.
Poprzednia wdrożona paczka Oracle 99585d9 i Worker 600219c3 pozostają zachowane
i kompatybilne z v1/v2 jako rollback dla tej naprawy. Cookie, mweb, PoT provider,
wersje yt-dlp/Deno, zależności, runtime i service units pozostają bez zmian.

Rzeczywiste metryki do 01:39 UTC: 1 598 Workers requests/0 runtime errors,
D1 140 977 rows read/4 828 rows written, DB 30 101 504 B, Queue 467 operations,
22 delete-fail samples, 0 DLQ. Dla nowego Workera 276 requests/0 runtime errors.
P99 CPU maksymalnej grupy 44,421 ms i pamięć 7 394 476 B; dataset nie rozróżnia
HTTP/Queue/Cron. Nie deklarujemy zgodności HTTP CPU 10 ms ani zdrowego pełnego
pipeline na podstawie tych agregatów. [Metryki](STAGE_B_METRICS_REVIEW.json).

Końcowy odczyt 01:51:52 UTC: active channels 1, accepted 45, technical payload
archives 0, deletion_enabled 0, nowych ANALYZE/PROJECT 0, Queue backlog 0.
Canary pozostaje BLOCKED po jednej próbie; cykl TED RUNNING, pages_committed 0,
czwarta próba RSS zachowała RETRY_WAIT do 02:03:22.962 UTC. Nie oznaczono go COMPLETE.
[Aktualny stan](STAGE_B_CURRENT_STATE.json). Sesję testową właściciela odwołano
istniejącą procedurą; prywatny plik auth usunięto lokalnie, bez DELETE w D1.
[Receipt](OWNER_TEST_SESSION_REVOKED.json).

**DEPLOYED: YES; E2E VERIFIED: NO; FREE pełnego pipeline: UNVERIFIED;
19 kanałów: INACTIVE; MANUAL20: NOT_RUN; SOAK: NOT_STARTED.**
Następny krok wymaga wyłącznie zatwierdzenia opisanej naprawy/odstępstwa, nie
ponownej zgody na wcześniejsze migracje. Po nim obowiązuje nadal dotychczasowa
bramka pełnego canary i limitów przed aktywacją 19 oraz natychmiastowym MANUAL20.

## 17. Wdrożone naprawy i rzeczywisty odbiór 15.10, stan 12:47 Warsaw

Wąskie GO na metadata-language i RSSfallback zapisano w OWNER_REPAIR_GO.json.
Wdrożono Worker622b952d i Oracle116f52d8. Świeży backup/restore43→43: 27 440 720B,
SHA10d95b4e…, bez ponawiania migracji. Oracle:31/31 offlineARM64 testów PASS,
concurrency1/COMPACT, obie usługi active/enabled,0restart; działający engine/sesja
zachowane przez installer. Zwykły capture zaktualizował sesję własnym istniejącym
mechanizmem; nie wykonywano ręcznego importu, eksportu ani rotacji sesji.
REPAIR_ORACLE_DEPLOYMENT.json, REPAIR_WORKER_POSTFLIGHT.json.

Rzeczywisty manualTEDcycle `manual:9560cbd1-0b76-4e51-afbd-120161967726`:
02:01:55.781–02:02:07.111UTC, COMPLETE1/1, actualpagecommit1, failed0.
RSS404 pozostaje UNAVAILABLE; osobne receipts potwierdzają uploads acquisition
oraz commit. HEADcoveragePARTIAL oznacza ograniczony odczyt, nie pełną historię.
REPAIR_CANARY_DISCOVERY_RESULT.json, REPAIR_FINAL_STATE.json.

Rzeczywisty film9i1LVL3_xpU, manualjob73c0c75f…: accepted02:02:28.462UTC;
3compact artefacts,226cue, manual/en, sourceis_original=null, authorityVIDEO_LANGUAGE
z oficjalnego defaultAudioLanguage. Nie sfabrykowano trackis_original=true.
RAWsha0245bf07…d323 jest identyczny z receipt rzeczywistego timedtextHTTP200.
Wszystkie226teksty i start/endms niezależnie porównano po dekodowaniu RAW.
D1source8614B/map20148B/raw30505B. Windowsverifyharness początkowo użyłcp1250;
ustawienie UTF-8 skorygowało wyłącznie test, bez zmiany danych produkcyjnych.

Markdown1YYZAtgyWmtL1p0Lx7v2bSg09ZQJoJUsD,23589B i technicznyJSON
1DqMErCBhjYlgm96gQfE07rAD7qzfOtbN,84465B zapisano i pierwotnie zweryfikowano
02:02:41.693/02:02:36.136UTC. Oba prywatne we właściwym folderze. Pełny readback
odtworzył3oryginalne headers i chunks, hashe oraz identyczny Markdown z cue.
Fetchstart→pierwotny Driveverified31,786s, accepted→Drive13,231s,
manualretryintent→Drive43,617s. To istniejący historyczny item; nie przedstawiamy
jego dawnego detected→manualretry jako zdrowej latencji schedulera.
REPAIR_CANARY_TIMINGS.json oddziela te okresy; download capture15316ms,
artifactupload1490ms,18RPC/86050B. Nie zebrano osobnego uploadfinished timestampu
Drive, więc nie wymyślamy splitu upload/verify. Następny Oraclepoll nastąpił około
236ms po successfulcycle; nie było dodatkowego30s sleep. Jedna para zdarzeń
nie jest produkcyjnym benchmarkiem10zadań.

Późniejszy metadata version advance1→2 przy niezmienionych hashach ujawnił błąd
technicznego czytnika. Pierwszy pełny canary zachował FAIL w REPAIR_CANARY_INTEGRITY.json;
19nieaktywowane. Właściciel polecił „napraw”, „kontynuuj aż będzie wszystko działać”;
zakres i plan OWNER_ARCHIVE_REPAIR_AUTHORIZATION.json / ARCHIVE_VERSION_REPAIR_PLAN_PL.md.
Poprawka zmienia wyłącznie remote_version po stabilnym prywatnym readbacku,
weryfikacji pakietu i CAS. Chroni authority, permission, aktywny permit, backup
barrier, concurrentreceipt i monotoniczną wersję; nie zmienia hashes/verified_at.

Lokalnie8nowychregresjiPASS; pełneWorkers315/315PASS po ponowieniu serialnym.
Pierwszyfullrun314/315 miał jednorazowy STACK_TRACE_ERROR w starej próbiebackup,
izolowanyrerun4/4PASS i kolejnyfull315/315PASS. Nie zmieniono progów testów.
Typecheck/lint/build/proddryrunPASS. NiezależnyreviewPASS. Bez ponownegoOracledeployu.
Nowybackup43→43 z10:36UTC,27 541 770B,SHAd83f835f…ab26, isolatedrestore/FK/integrityPASS.

Worker74232ebc, deployment1f54e62f-2435-4e63-9ae4-1f9ddc0970a4,100%,
10:38:56UTC; moduł1758018B,sha6f3c59aa…ae92 odczytany z produkcji dokładniezgodny.
10:40UTC rzeczywistyPOST /api/v1/system/retention/payload-dry-run200DRY_RUN,
technicalreceipt1→2,verified_at/hash zachowane,619chunks przed i po,DELETE0.
Późniejszy pełny readbackPASS; API rzeczywiście odczytało stary v1 oraz source/mapv2
z poprawnymi hashami. Dowody ARCHIVE_VERSION_WORKER_POSTFLIGHT.json,
ARCHIVE_VERSION_LIVE_WORKER_DRY_RUN.json, ARCHIVE_VERSION_CANARY_INTEGRITY.json,
ACTUAL_LEGACY_COMPACT_API_READS.json. Bez duplikowania capture lub uploadu.

Zachowano45wcześniejszychaccepted,244artifacts,616chunks,45archives dokładnie
co do IDs/hashów względembackup. Obecnie46accepted/247artifacts/619chunks/46MD/1JSON,
items65 bez nowych historycznych importów, bez duplicateitems/sources.

Aktualny odczyt10:35UTC:5402Workersrequests,958959D1read/6792write,
DB30232576B,809Queueoperations,backlog0. Dane częściowejdoby i całego konta,
nie stały dobowy throughput tego wydania. WolneDrive15665447466B/limit16106127360B.
OracleAlwaysFree1OCPU/6GB/47GB zachowany. Nie potwierdzamy100filmów/dobę ani
nieograniczonegoDrive; retentionOFF oznacza trwały wzrost zajętości.

Osobny officialWranglertail pokazał rzeczywisteCPUms: HTTPdryrun34,
heartbeatpierwszy11,późniejsze1–4; Cron21; Queue9, wszystkieoutcomeok.
FreeHTTP/Cron10ms nie jest dowiedzione samymHTTP200. Queue dokumentacjaobejmuje
Free i podaje30sdefault. Trwa ograniczony eksperyment z ciepłymi próbkami i natywnym
SHA256 bez zmianychecks. Aktywacja19/MANUAL20 nadalzamknięta do odbioru tej bramki.
Soak24–72hNOT_STARTED; brak twierdzenia o zakończonej obserwacji.

## 18. Natywny SHA — wdrożony po osobnym GO; CPU nadal HOLD

Właściciel zatwierdził wyłącznie natywny SHA-256 w `OWNER_NATIVE_CPU_GO.json`.
Worker `6b6a7844-e1f9-48a3-b70e-299b6d98cd90` został wdrożony 10:55 UTC,
deployment `a8b270f3-917c-4bf5-a1b6-6623c8c9a630`. Dokładne bajty, bindingi,
AI/DELETE OFF, Queue concurrency/batch1 oraz health: PASS.
`NATIVE_HASH_WORKER_DEPLOYMENT.json`, `NATIVE_HASH_WORKER_POSTFLIGHT.json`.

Ponowny rzeczywisty odczyt tego samego canary (bez nowych pobrań YouTube ani uploadów
Drive) potwierdził 226 cue, oryginalny tekst/start/end ms, trzy compact artefakty,
prywatność i pełne hashe technicznego JSON oraz Markdown: PASS.
`NATIVE_HASH_CANARY_INTEGRITY.json`, `NATIVE_HASH_LIVE_WORKER_DRY_RUN.json`.
Historia i wszystkie 619 chunków pozostają w D1; produkcyjny eviction nie został uruchomiony.

Rzeczywiste próbki na tej wersji: naturalny Cron 11:00 UTC **22 ms CPU**, 11:05
**11 ms**, Queue odpowiednio 7/3 ms. Administracyjny read-only payload dry-run
**36 ms**. Wszystkie outcome=ok, bez wyjątków; nie wykazano redukcji względem
wcześniejszych próbek. Nie przypisujemy HTTP200 znaczenia Free PASS.
`NATIVE_HASH_FIRST_CPU.json`, `NATIVE_HASH_1100_CRON_CPU.json`, `NATIVE_HASH_1105_CRON_CPU.json`.

Odczyt 11:04 UTC obejmuje część doby: 5798 Workers requests, zero runtime errors,
1 031 874 rows read / 6965 written w D1 konta i projektu, baza 30 232 576 B,
827 Queue operations, backlog0. To wyniki z dnia wdrożenia zawierające również
backupy i testy; nie są pomiarem pełnej doby ani stałego obciążenia 20/100 filmów.
`POST_NATIVE_METRICS_REVIEW.json`. Oracle active/enabled, restart count0,
bez nowych błędów providera; `POST_NATIVE_ORACLE_HEALTH.json`. Sesję testowego
właściciela odwołano: `NATIVE_CPU_OWNER_SESSION_REVOKED.json`.

Tylko TED jest aktywny. Pozostałe19, MANUAL20 i soak pozostają nieuruchomione.
Kolejny kandydat lokalny przenosi istniejący maintenance Cron do tej samej Queue
(osobny, wyższy budżet CPU, bez nowych usług) i usuwa zbędną próbę budowy routera,
wybierając równoważny TrieRouter. Nie został wdrożony i nie mieści się w natywnym
SHA-only GO. Dokładny pakiet i testy zostaną zapisane przed kolejnym checkpointem.

## 19. Cron w istniejącej Queue i równoważny router — 13:28 Warsaw

Po osobnym GO „tak” (`OWNER_FREE_CPU_GO.json`) wdrożono Worker
`901e9506-5924-4e96-9735-19f43ee9a1d3` na100%, deployment
`822eb3ad-4ba0-4da3-96b3-35245251c478`, 11:25 UTC. Pakiet
1 759 078 B, SHA256 `0057d2cd14b00e693cac5cf379de01ac1064940d8bd6d73c70a102ce5d5ffaff`.
Dokładny readback pakietu, bindings, AI/DELETE OFF, Queue1/1 i health: PASS.
`FREE_CPU_WORKER_DEPLOYMENT.json`, `FREE_CPU_WORKER_POSTFLIGHT.json`.

Zmiana obejmuje tylko index.ts/queue.ts/scheduled.ts: Cron nie wykonujeSQL,
zleca tę samą ograniczoną maintenance przez istniejącą Queue; czas wystąpienia
Cron wybiera sloty Warsaw, aktualny czas obsługuje recovery i ukończenie cyklu.
Explicit TrieRouter zachowuje handler order/parametry w3689 przypadkach.
Nie zmieniano Oracle, schematu ani silnika/session. Dokładne pliki/hashes:
`FREE_CPU_CANDIDATE.json`, pełna lista209 wejść w `FREE_CPU_SOURCE_INVENTORY.json`.

Lokalnie331/331Workers przed ostatnią poprawką zegarów +25/25focused po niej,
24nakładające się przypadki, łącznie332 test instances. Warsaw/DST7PASS;
pełny typecheck/build i finalny dry-run, lint/format4plików PASS. Niezależny
review znalazł i potwierdził naprawę błędu dwóch zegarów: `FREE_CPU_INDEPENDENT_REVIEW.json`.
Nie deklarujemy pojedynczego finalnego run332 ani produkcyjnego CPU z mikrobenchmarku.

Rzeczywisty readback tego samego canary11:26 UTC ponowniePASS:226cue,tekst/ms,
trzy artefakty, JSON i Markdown hashes/private permissions, wersje2→2. Liczba
chunków619 bez zmian; DELETE0, zero nowych pobrańYouTube/uploadówDrive.
`FREE_CPU_CANARY_INTEGRITY.json`, `FREE_CPU_LIVE_WORKER_DRY_RUN.json`.

Pierwszy boundedtail po deployu:8 zwykłych HTTP1–5ms; ręczny admin dry-run26ms,
wszystkie outcomeok. To obiecująca mała próbka, nie pełny odbiórCPU.
`FREE_CPU_FIRST_HTTP.json`. Przed aktywacją19 wymagane są dwa naturalne Crony,
potwierdzenie maintenance wQueue i aktualnego zapasu konta. Brak FreePASS,
MANUAL20 nadalnieuruchomiony. Szczegółowe kryteria i rollback:
`FREE_CPU_REPAIR_PLAN_PL.md`. Dotychczasowy kompatybilny Worker6b6a7844 zachowano;
nie cofać schematu ani produkcyjnych danych.

## 20. Końcowy odbiór zatwierdzonego wdrożenia

Stan: 15.10.2026, 13:50 Europe/Warsaw. **DEPLOYED, E2E VERIFIED, MANUAL20 PASS.**
Kontrolowany odbiór Free zakończono z zapasem zasobów. Pełna doba wykorzystania,
obciążenie 100 filmów dziennie i obserwacja 24–72 h pozostają niepotwierdzone.

### Wersje i wykonane operacje

Gałąź: `codex/remote-daily-reports`, HEAD: `ea15d283fe9097edb7deae152170f0fd86d4d527`.
Wdrożenie obejmuje zachowane lokalne zmiany. Nie wykonano commit, push ani merge.

Aktualny Worker: `901e9506-5924-4e96-9735-19f43ee9a1d3`, 100% ruchu; deployment
`822eb3ad-4ba0-4da3-96b3-35245251c478`. Pakiet ma 1 759 078 B, SHA-256:
`0057d2cd14b00e693cac5cf379de01ac1064940d8bd6d73c70a102ce5d5ffaff`.
Odczyt z produkcji potwierdził dokładne bajty, bindingi i health.
Oracle używa pakietu `116f52d8aa18aceae2d9c5d8aea763ff022c2123c2167ac2d8bd9c9688f3210e`:
COMPACT, concurrency=1, obie usługi systemd active/running, restart count=0.
Wtyczka Cloudflare potwierdziła połączenie i odczyty deployment/Queue/D1 o 11:24 UTC.

| Czas UTC, 15.10 | Operacja i wynik                                                                | Dowód                                                                        |
| --------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 10:55           | Natywny SHA wdrożony po osobnym GO; poprawy CPU nie wykazano                    | [Receipt](NATIVE_HASH_WORKER_DEPLOYMENT.json)                                |
| 11:25           | Cron → istniejąca Queue i równoważny TrieRouter; osobne GO, dokładne bajty PASS | [GO](OWNER_FREE_CPU_GO.json), [postflight](FREE_CPU_WORKER_POSTFLIGHT.json)  |
| 11:26           | Ponowny pełny readback tego samego canary TED: PASS                             | [Integralność](FREE_CPU_CANARY_INTEGRITY.json)                               |
| 11:29           | Świeży backup i izolowane odtworzenie 43→43: PASS                               | [Backup/restore](../../deployment/2026-10-15T11-27-41.135Z-pre-upgrade.json) |
| 11:30 / 11:35   | Dwa naturalne Crony i normalne RPC; kontrolowany odbiór CPU                     | [Odbiór Free](RELEASE_FREE_ACCEPTANCE.json)                                  |
| 11:37:18.964    | Aktywacja dokładnie 19 zatwierdzonych kanałów NEW_ONLY                          | [Aktywacja](APPROVED19_ACTIVATION_RECEIPT.json)                              |
| 11:38:36.749    | Jednorazowy MANUAL20 wysłany przez istniejącą Queue                             | [Dispatch](MANUAL20_DISPATCH.json)                                           |
| 11:39:58.824    | Faktyczne zakończenie 20 kontroli: COMPLETE, 20/20, failed=0                    | [Receipts](MANUAL20_RESULT.json)                                             |
| 11:40:56        | Historia, hashe, deduplikacja i FK: PASS                                        | [Stan danych](FINAL20_STATE.json)                                            |
| 11:40:58        | Bieżące wykorzystanie konta z zapasem; backlog=0                                | [Metryki](POST_MANUAL20_FREE_METRICS.json)                                   |
| Po odbiorze     | Odwołano sesję testową właściciela i usunięto prywatny plik auth                | [Odwołanie](FREE_CPU_OWNER_SESSION_REVOKED.json)                             |

Migracje 041–043 zastosowano jednokrotnie. Ledger ma 43 wpisy; pełne checksums,
FK i integrity checks zawiera [MIGRATION_RESULT.json](MIGRATION_RESULT.json).
Poprawki CPU nie wymagały migracji, zmian Oracle, instalowania zależności ani
zmian sesji YouTube. Nie aktywowano płatnych zasobów.

### Monitoring, scheduler i kolejka

Aktywne są dokładnie TED oraz zatwierdzone 19 kanałów. Ich identyfikatory porównano
z listą o SHA-256 `2938fcda090cd743c375922e6ea4bcb9fc9143dd788ef4a1aa0a63bc962dac62`.
Każde nowe źródło ma NEW_ONLY i granicę importu równą rzeczywistemu czasowi
aktywacji, 11:37:18.964 UTC. Operator nie utworzył początkowych zadań backfill.

Cykl `manual:approved20:281cc826-7024-48c6-9f4a-71762c520bbf` ma osobny slot MANUAL.
Nie zmieniano zegara ani harmonogramu i nie oznaczono go jako cyklu zaplanowanego.
Od trwałego utworzenia cyklu do zakończenia minęło **86,773 s**. Wszystkie 20 zadań
ma SUCCEEDED, attempt=1, fencing=1, odebraną stronę RSS i zapisany wynik.
Przerwy między kolejnymi kontrolami wyniosły **1,346–1,935 s**, bez pięciominutowych
pauz. [Wynik każdego kanału](CHANNEL_MONITORING_RESULTS.md),
[dokładne receipts i czasy](MANUAL20_PRODUCTION_VERIFICATION.json).

W tym cyklu RSS odpowiedział poprawnie dla wszystkich 20 kanałów, także TED.
Wcześniejsze 404 i jawne użycie ograniczonego uploads fallback pozostają w historii
dowodów. Coverage=PARTIAL prawidłowo oznacza zakres kontroli RSS, a nie enumerację
całej historii playlisty. Początkowy dodatkowy harness błędnie wymagał znacznika
ukończenia historycznego okna; skorygowano go na właściwy kontrakt: SUCCEEDED,
zakończony job_attempt i zapisana strona. Produkcji ani kryterium rzeczywistego
wykonania kontroli nie zmieniono.

Normalne cykle pozostają o **15:00 i 23:00 Europe/Warsaw**, z DST. Cron co pięć minut
wysyła maintenance do tej samej trwałej Queue. Oryginalny czas Cron wybiera slot;
aktualny czas wykonania służy recovery i receipts. D1 deduplikuje cykle i zapisuje
postęp. Consumer zachowuje świeżą kontrolę uprawnień DISCOVER/RECONCILE, ograniczone
porcje i batch/concurrency=1. Nie powstał drugi system kolejkowy.
Odzyskanie zgubionego hintu nadal zapewnia maintenance; istniejące max_retries=0
oznacza, że retry(60 s) nie gwarantuje ponownej dostawy platformy.

### Transkrypcja, Drive i historia

Rzeczywisty canary TED `9i1LVL3_xpU` zachowuje wszystkie **226 odebranych cue**,
oryginalny tekst oraz start/end w milisekundach. Wybrano manualną ścieżkę en,
bez tłumaczenia. Provider nie podał is_original; pozostawiono NULL. Zgodność
oryginalnego języka potwierdza zweryfikowane videos.snippet.defaultAudioLanguage=en,
z zachowaniem rzeczywistej proweniencji ścieżki. Nie przypisujemy providerowi
is_original=true ani nie gwarantujemy napisów dla każdej sekundy filmu.

Nowe materiały mają trzy artefakty: RAW do dokładnego odtworzenia transportu,
SOURCE_ORIGINAL dla aktywnych odczytów tekstu oraz SEGMENT_MAP dla wszystkich cue,
ich kolejności, czasów i pochodzenia. Nie powstają manifesty NORMALIZED/OFFSET_MAP
dla nieużywanej analizy. D1 zachowuje te payloady, metadane, jobs, accepted outcomes,
hashe, historię, deduplikację oraz identyfikatory i receipts Drive.

Prywatne pliki Drive mają stałe IDs: Markdown 23 589 B i techniczny JSON 84 465 B.
Odczyt zwrotny potwierdził pełne hashe, wersje 2→2, folder, MIME, appProperties,
prywatność i dokładne odtworzenie trzech artefaktów wraz z chunkami. Ponowne odbiory
nie pobierały filmu i nie tworzyły nowych uploadów.
[Pełna integralność](FREE_CPU_CANARY_INTEGRITY.json),
[rzeczywisty dry-run Workera](FREE_CPU_LIVE_WORKER_DRY_RUN.json).

Pierwotny rzeczywisty pomiar: fetch start → Markdown verified **31,786 s**,
accepted → Markdown **13,231 s**, manual intent → Markdown **43,617 s**.
18 RPC, upload artefaktów 1490 ms. Film wykryto wcześniej i ręcznie ponowiono,
więc starego detected→fetch nie traktujemy jako opóźnienia zdrowego schedulera.
Nie zebrano osobnego timestampu końca uploadu Drive; nie wymyślamy podziału upload/verify.
[Rzeczywiste czasy i ograniczenia](REPAIR_CANARY_TIMINGS.json).

Wszystkie wcześniejsze 45 accepted, 244 artefakty, 616 chunków i 45 archiwów mają
missing=0, changed=0. Aktualnie: 65 items, 580 jobs, 46 accepted, 247 artefaktów,
619 chunków. Duplikatów items/sources i naruszeń FK: 0; importów sprzed aktywacji: 0.
Legacy v1 oraz compact v2 pozostają czytelne. Nie utworzono ani nie wykonano nowych
automatycznych ANALYZE/PROJECT. Dokumenty i zadania ChatGPT zachowano; nie powtarzano
bazowego testu odczytu Drive przez ChatGPT ani nie deklarujemy nowego raportu AI.

### CPU i wykorzystanie Free

Natywny SHA sam nie rozwiązał CPU. Po przeniesieniu maintenance do Queue naturalne
Crony zużyły **0 i 1 ms**. W 47 zwykłych RPC mediana wyniosła 3 ms, 46 próbek mieściło
się w 10 ms, jedna miała 11 ms. Wszystkie wykonania zakończyły się poprawnie.
Cloudflare dokumentuje tolerowanie sporadycznych przekroczeń CPU, bez gwarancji ich
wielkości lub częstotliwości. To uzasadnia kontrolowany odbiór przy braku powtarzalnego
przekroczenia; nie gwarantuje przyszłej pojemności burstów.
[Oficjalne limity CPU](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

Ręczny admin payload-dry-run zużył 26 ms i pozostaje osobnym ryzykiem tego endpointu.
Nie jest cykliczną zależnością archiwizacji. Podczas MANUAL20 zebrano dodatkowo:
29 HTTP po 1–9 ms, 16 Queue po 3–18 ms i Cron 0 ms, wszystkie bez wyjątków.
Queue ma domyślny budżet CPU 30 s również na Free; limitów nie podniesiono.
[Oficjalne limity Queue](https://developers.cloudflare.com/queues/platform/limits/).

| Zasób, częściowa doba do 11:40 UTC | Rzeczywisty pomiar                                | Limit / stan                              |
| ---------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| Workers requests konta             | 6398; errors=0                                    | 100 000/dzień                             |
| D1 rows read konta i projektu      | 1 230 122                                         | 5 000 000/dzień                           |
| D1 rows written konta i projektu   | 8697                                              | 100 000/dzień                             |
| Baza D1                            | 30 359 552 B                                      | 500 MB/baza                               |
| Queue operations konta             | 915                                               | 10 000/dzień                              |
| Queue backlog                      | 0                                                 | bez zaległości                            |
| Aktualna wersja Workera            | 314 requests; errors=0                            | dokładny filtr version                    |
| RAM Workera                        | maksymalny grupowy P99 około 9,50 MB              | 128 MiB; nie maksimum invocation          |
| Oracle                             | executor około 60,6 MB, broker 9,7 MB; restarts=0 | Always Free A1, 1 OCPU / 6 GB; boot 47 GB |
| Drive                              | 15 665 447 466 B wolne                            | limit 16 106 127 360 B                    |

Próbki przed/po aktywacji i cyklu wykazały +243 requests, +133 045 D1 reads,
+1590 writes, +70 Queue operations i +126 976 B bazy. Te delty obejmują też normalny
ruch, maintenance, odczyty operatora i lag analytics; nie są dokładnym kosztem skanu.
Dodatkowe 864 Queue operations/dobę to model 288 wiadomości × send/read/delete,
bez retry. Lokalne modele 3/9/30/100 filmów, krótkich i długich, pozostają estymacjami
z raportu performance. Nie przedstawiamy ich jako produkcyjnego dowodu Free dla
100 filmów dziennie. Billing Oracle pokazywał 0 PLN z opóźnieniem około 24 h;
nie jest to bieżąca faktura ani gwarancja przyszłego kosztu.

### Backup, retencja i rollback

Świeży backup ma 27 542 491 B, SHA-256:
`16554040f956a3ea9542a2cc645f46b0890533d16374c7b0201631f4cd19104f`.
Izolowane odtworzenie 43→43, integrity/FK i zachowanie liczby rekordów: PASS.
Zachowano poprzedni pakiet Workera i działający pakiet Oracle. Backup nie był
zastąpiony deklaracją addytywności migracji.

`RETENTION_DELETION_ENABLED=false`, `retention_settings.deletion_enabled=0`,
evicted_at/permit_token=NULL. Wszystkie 619 chunków pozostały w D1. Produkcyjnego
PayloadEviction.delete ani szerokiego cleanupu nie wykonano. Dry-run wskazał tylko
trzy dozwolone payloady canary. Odczyt po eviction i przywrócenie payloadów mają
dowody lokalne; nie są dowodem produkcyjnego kasowania.

Bezpieczny rollback przywraca zgodny Worker `6b6a7844-e1f9-48a3-b70e-299b6d98cd90`
przez wersje Cloudflare. Obsługuje compact v2 i metadata CAS. Zachowuje migracje,
wszystkie nowe accepted oraz D1; nie nadpisuje bazy starym snapshotem. Ta wersja
ma wcześniejsze ryzyko CPU Cron, więc rollback służy istotnej regresji obecnego
wdrożenia. Nie przywracać Workera sprzed obsługi v2. Oracle nie wymagał rollbacku.

### Dalsza obserwacja i odrębne zgody

Okno obserwacji rozpoczęło się po MANUAL20: **15.10.2026, 13:39:58.824 Warsaw**.
Najwcześniejszy odbiór 24 h: **16.10 o 13:39:58.824**, a 72 h: **18.10 o tej samej godzinie**.
Nie utworzono osobnego aktywnego obserwatora ani obietnicy pracy Codex w tle.
Produkcja Cron/Queue/D1, systemd Oracle oraz istniejące metryki i receipts działają
autonomicznie bez Windows. Dalszy odbiór: [status](SOAK_STATUS.json)
i [runbook](SOAK_RUNBOOK_PL.md).

Pozostałe ograniczenia: brak pełnej doby i soak; długie materiały oraz 30/100 filmów
dziennie nie zostały sprawdzone na produkcji; bufor D1 rośnie przy DELETE OFF;
sporadyczny RPC 11 ms i ręczny admin 26 ms; możliwość kolejnego RSS404; opcjonalne
nieaktywne foldery Daily zachowują wcześniejsze drive.file404. Nie zmieniano ich
w tym wdrożeniu. Osobnej zgody wymagają eviction, operacje destrukcyjne, płatne
zasoby, zmiany silnika/sesji oraz commit/push/merge. Normalne działanie zatwierdzonych
20 kanałów w slotach 15:00/23:00 nie wymaga kolejnego GO.

## Godzinowe wznowienie odbioru w Codex — 15.10.2026, 13:55 Warsaw

Utworzono aktywne wznowienie w tym czacie: `bartosz-odbi-r-produkcji-24-72-h`.
Co godzinę zbiera wyłącznie metadane i metryki, bez zmian produkcyjnych, dodatkowych
skanów, pobrań, uploadów, nowych sesji lub DELETE. Zapisano limit 73 wystąpień
oraz zakończenie po odbiorze 72 h. Informuje o istotnym problemie, potrzebnej
czynności właściciela lub udokumentowanym odbiorze 24/72 h; bez rutynowych statusów.
Pierwszego zaplanowanego uruchomienia jeszcze nie potwierdzono.

To aktualizacja wcześniejszej informacji o braku automatyzacji. Pomocniczy monitor
wymaga działającego komputera i lokalnej aplikacji Codex; produkcyjny pipeline
Cloudflare/Oracle nadal pracuje autonomicznie bez Windows. Zgodnie z
[oficjalną dokumentacją OpenAI](https://learn.chatgpt.com/docs/automations?surface=app)
lokalne zadania potrzebują dostępnego projektu i uruchomionej aplikacji.
Dowód: [SOAK_AUTOMATION_RECEIPT.json](SOAK_AUTOMATION_RECEIPT.json).

## Pierwszy odczytowy heartbeat — 15.10.2026, 14:54 Warsaw

Zebrano nowe dowody bez produkcyjnych zapisów, dodatkowych skanów/pobrań/uploadów
lub nowych sesji użytkownika. Worker901e9506 na100%, Oracle116f52d8 active/running,
restart count0, ledger43,20aktywnychkanałów, AI OFF i DELETE OFF. Backlog0,
errors0. StanDriveCONNECTED/VERIFIED odczytano wyłącznie zD1; nie odświeżano tokenów
ani nie wykonywano nowego readbacku. Accepted46, artefacts247, chunks619 bez zmian.

Jednorazowy manualny cykl14:40, który zdążyłruszyć przed skutecznym zatrzymaniem,
zakończył20/20kontroli o14:41:47.430Warsaw, failed0. TED:1materiał dopuszczony
w istniejącymoknieRSS,1jużznany,0nowych,0nowychFETCH_TRANSCRIPT. To liczba
materiałów w okniekontroli, nie wszystkichhistorycznychfilmów lub nieutrwalonych
wpisów całegoRSS. Nie uruchomiono kolejnego cyklu. Slot15:00 nadal ma się odbyć;
przy tej obserwacji nie byłjeszcze wymagalny. Harmonogram15/23Warsaw bez zmian.

Częściowa doba do12:53UTC:7386Workersrequests/errors0,1507532D1reads,
10149D1writes,1094Queueoperations, baza30445568B, backlog0. Wszystkie wartości
mają zapas. GroupedCPU P99max26,612ms na obecnejwersji nie rozdzielaHTTP/Cron/Queue;
nie jest dowodem nowejawarii ani globalnegoFreePASS. Estymacje zcollectora
pozostająestymacjami. Brak nowegoaccepted w tymoknie oznacza brak nowejpróbyE2E,
nie dodatkowyPASS. SOAK pozostajeIN_PROGRESS_NOT_PASSED;24h/72h jeszcze nieupłynęły.

Dowody: [stan](SOAK_20261015_1253_STATE.json),
[metryki](SOAK_20261015_1253_METRICS.json), [Oracle](SOAK_20261015_1253_ORACLE.json).
Pierwszy rzeczywisty odczytowy run automatyzacji potwierdzony; brak problemu
wymagającego powiadomienia właściciela w tym oknie.

## Rzeczywisty slot 15:00 — odczyt 15:15 Warsaw

Automatyczny cykl15:00: start15:00:22.048,koniec15:01:46.984Warsaw,
20SUCCEEDED/20committedRSSpages,failed0. TED PpEUTpzWt2M z13.10(17:00:17Warsaw),
znany od13.10(17:35:40.990),nowych0,FETCHutworzonych0. IstniejącyFETCHSUCCEEDED
13.10 o17:36:27.818,DriveVERIFIED13.10 o17:40:35.208. Brak nowychaccepted/archiwów
od14:40. D1potwierdza równieżmanualny14:40COMPLETE20/20 o14:41:47.430;
odwołanie zlecenia nie cofnęło wcześniej wysłanego wywołania. Queue0,Oracleactive,
restarts0,idle;zerozapisówprodukcji. RaportUSER_MONITORING_RESULTS_1515_PL.md.
