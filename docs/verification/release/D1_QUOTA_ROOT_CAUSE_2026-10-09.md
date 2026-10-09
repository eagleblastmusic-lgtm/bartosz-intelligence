# D1 quota — przyczyna i optymalizacja, 2026-10-09

Status: przyczyna odczytów potwierdzona; poprawki i pomiary lokalne zakończone.
Migracja 036 i nowy runtime oczekują na kontrolowane wdrożenie po rzeczywistym
resecie. `paid_services_enabled=false`. Gate C NOT_YET_MATURE;
IMPLEMENTATION COMPLETE NO; PRODUCTION ACCEPTED NO.

## Wniosek

Wyczerpania **nie można przypisać wyłącznie jednorazowym testom**. Normalna
kontrola admission transkrypcji skanowała historię prób co około 30 sekund.
Cloudflare przypisuje temu SQL **3 526 290 rowsRead / 1998 wykonań**. Kolektor
Gate C wykonywał skan historii prób osobno dla każdego Item: **1 720 240 / 8
stron**. Kontrola metadata-refresh i paginacja backupu miały dalsze potwierdzone
nieefektywności. Testy i obserwacja zwiększyły obciążenie, ale istniejący
nieefektywny mechanizm normalnej pracy sam stwarzał ryzyko dziennego limitu.

Nie wyznaczamy dokładnych udziałów procentowych: dataset top SQL i godzinowa
agregacja nie uzgadniają się liczbowo. Nie przypisujemy każdego odczytu do
konkretnego testu. Brakuje per-request trace łączącego SQL z case ID.

## Rzeczywiste wykorzystanie i granice dowodu

Odczyt GraphQL Analytics o 18:11:08.199 UTC, zakres 00:00–18:11 UTC:

| Wartość                         |            Wynik | Rodzaj dowodu                                                        |
| ------------------------------- | ---------------: | -------------------------------------------------------------------- |
| Account rows_read               |        5 507 234 | wartość zwrócona przez Analytics; opóźniona agregacja                |
| Account rows_written            |           11 178 | ta sama agregacja                                                    |
| BARTOSZ_CORE storage            | 22 482 944 bytes | bieżące metadata bazy, bez SELECT                                    |
| Inna baza storage               |  2 899 968 bytes | inventory konta                                                      |
| Total storage                   | 25 382 912 bytes | suma inventory; daleko od limitu storage                             |
| Faktycznie osiągnięty limit     |       DAILY READ | rzeczywisty błąd providera; nie wniosek z liczby zwróconych rekordów |
| Pierwszy zachowany błąd backupu |     17:11:50 UTC | HTTP 400 / 7500, CHUNKS                                              |
| Dokładny moment przekroczenia   |         NIEZNANY | agregacja godzinna nie ustala sekundy ani granicy dużego zapytania   |

Hourly dataset obejmuje wszystkie bazy konta, bez filtra databaseId. Zwrócił
wyłącznie BARTOSZ_CORE w tym oknie. Inna baza istnieje, ale dataset nie przypisuje
jej aktywności w badanym oknie. Nie jest to twierdzenie o jej całej historii.

| Godziny UTC                | Rows read | Interpretacja                                                                                  |
| -------------------------- | --------: | ---------------------------------------------------------------------------------------------- |
| 00–13, 14 pełnych bucketów | 3 323 404 | stabilne 227 767–249 680/h; nie jest to eksperymentalnie wydzielona „czysta produkcja”         |
| 14                         |   827 036 | wyraźny skok; obserwacja/integracja są wiarygodnymi współczynnikami, dokładny podział nieznany |
| 15                         |   531 029 | podwyższone obciążenie                                                                         |
| 16                         |   533 446 | skumulowana agregacja przekracza 5 mln w tym buckecie                                          |
| 17                         |   292 279 | agregacja może zawierać opóźnione wyniki; nie potwierdza dalszej dostępności                   |
| 18, częściowy              |        40 | nie ekstrapolować na pełną godzinę                                                             |

Średnia z 00–13 to 237 386/h; **ekstrapolacja**, a nie wynik produkcyjny za dobę:
5 697 264 odczyty/24h. Brak testów w całym tym oknie nie został udowodniony.
Niezależnie od tego EXPLAIN, częstotliwość i actual local D1 meta potwierdzają
nieefektywność zwykłej ścieżki transkrypcji.

Oficjalny [cennik D1](https://developers.cloudflare.com/d1/platform/pricing/)
podaje Free 5 mln odczytów/dzień, 100 tys. zapisów/dzień, 5 GB storage łącznie,
reset 00:00 UTC. [Limity](https://developers.cloudflare.com/d1/platform/limits/)
obejmują także maks. 500 MB jednej bazy Free. Limity dzienne dotyczą konta,
nie osobnych przydziałów dla baz. Dnia 10 października reset wypada o 02:00
Europe/Warsaw. [Metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
opisuje Analytics i query metadata. Rows read to odczytane/skanowane wiersze;
liczba wyników lub rozmiar body nie zastępuje tego pomiaru. Dokładny remaining
quota nie jest dostępny z zachowanych danych.

Evidence: `d1-analytics-2026-10-09-2e8ece67-9486-4602-ad0a-537efff2c700.json`,
`d1-top-2026-10-09.json`, `d1-attribution-summary-2026-10-09.json`, wcześniejszy
`d1-daily-limit-2026-10-09.json`. Dataset top SQL ma sumę 5 892 480 odczytów,
inną niż hourly 5 507 234: osobne adaptacyjne agregacje/czas odczytu i możliwy
lag. Nie sumujemy ich razem. SQL templates są zredagowane, bez bound params,
payloadów, caption bytes lub sekretów. Diagnostyka Analytics: zero D1 SQL.

## Dziesięć ścieżek i potwierdzone koszty

| Ścieżka                                     | Dowód / częstotliwość / ocena                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery / scheduler                       | Cron co 5 min; bounded source/reconcile/sweep/outbox. Metadata selector 182 razy / 297 721 odczytów był kosztowny nawet bez należnych rewizji; poprawiono plan i indeksy. RSS/API nie są D1 odczytami.                                                                                                                                                              |
| Transcript / backfill                       | Admission 1998 / 3 526 290, dominujący regularny koszt. Historia prób skanowana przez owner index, później join/sort. Dodano selektywny partial index oraz jawny predicate. Backfill nadal durable i kontrolowany; nie usuwa się historii prób.                                                                                                                     |
| AI jobs / leasing / fencing / retry         | Ordinary pull 3993 / 28 635, backfill pull 3827 / 27 394, worker access 15 966 / 31 802. SELECT * jest tu bounded indeksowanym pobraniem kompletnego jobu. Heartbeat 5023, 9986 reads / 4993 writes. Brak dowodu, że same te ścieżki wyczerpały limit. Usunięto powtarzanie polling po potwierdzonym daily quota do resetu.                                         |
| Evidence / Observation / Knowledge / Ledger | W badanym actual snapshot brak accepted AI Observations. Nie można zmierzyć kosztu pełnej normalnej AI produkcji z pustego zbioru. Trwałe candidate/provenance/acceptance i Ledger nie były redukowane; lokalne integrity/acceptance regresje zachowane.                                                                                                            |
| Search FTS / GUI                            | Retained rzeczywiste 5 FTS prób: po 447 reads, 0 writes, 1.76–3.86 ms SQL na 53 Items. Lokalne 10k dowody retained. Daily keyset bounded, GUI visible-only i busy guard; ograniczenie body SELECT * nie zmniejsza samo liczby scanned rows. N+1 source summaries wymagają pomiaru większego aktywnego zbioru; brak potwierdzenia, że były główną przyczyną dzisiaj. |
| System / health                             | System jest odczytem na żądanie, ma agregacje stanu/metryk i LIMIT list. Health /healthz nie skanuje canonical content. Nie dodano D1 zapisu przy każdym health/Analytics odczycie. Agregacje historii rosną z corpus; dalszy production pomiar wymagany dla wieloletniej historii, bez nieuzasadnionego cache ukrywającego aktualność.                             |
| Daily / Drive                               | Seal/readback są hashowane i stronicowane; actual auto-export jest DISABLED. Zachowane 6/13 D-export PASS. Nie ma dowodu na dzisiejszy ciągły koszt automatycznych eksportów. Pełny aktualny AI Daily nie jest zmierzony.                                                                                                                                           |
| Backup / restore / cadence                  | Job-attempt chunk 46 / 140 679 w top SQL. Owner composite index i temp sort powtarzały scan dla rowid page. Wymuszono rowid seek (NOT INDEXED) z zachowaniem owner filter. Cadence sprawdza istniejący zweryfikowany capture przed nową kopią; nie wykonuje nowego dla samego PASS. Restore tylko izolowany lokalnie.                                               |
| Gate C / monitoring                         | Page 8 / 1 720 240. Correlated MIN wybierał attempts przed item jobs; accepted runs skanowane po owner/state dla każdego Item. Poprawiono join order i accepted-item index. Hourly/logon cadence teraz odracza przy stale/UNKNOWN Analytics i >=80% odczytów lub zapisów. Gap nadal nie kwalifikuje mature window.                                                  |
| Gate D/R / integration                      | Lokalne workerd/SQLite testy nie zużywają produkcyjnego D1. Live próby mają rzeczywisty koszt, lecz brak pełnego trace/case mapping. Przygotowano dokładnie 2 pozostałe R i 7 D-export w runbooku, exclusivity intent, 50k reads/5k writes/250 admin request budget. Bez odtwarzania 8+6 historycznych PASS bez konkretnej regresji.                                |

Główne EXPLAIN przed: admission `sqlite_autoindex_job_attempts_2(owner_id=?)`
i temp sort; Capacity item subquery skanowało wszystkie owner attempts;
metadata zaczynała od enabled sources/items i szerokiego jobs_due;
backup wybierał owner PK plus temp sort zamiast rowid range. Po: partial
admission covering index, bounded item jobs→attempts, accepted-item index,
metadata due range + active-job partial index, `INTEGER PRIMARY KEY (rowid>?)`.
Nie utożsamiamy tekstu EXPLAIN z pomiarem kosztu — oba są w benchmark receipt.

## Wykonane zmiany i benchmark przed/po

Najmniejsza zmiana schema: pięć indeksów w **036_d1_read_indexes.sql**.
Canonical tabele, payloady, constraints i projekcje backupu zachowane.
Legacy backup z dokładnym 35-migration prefixem można odtworzyć do 36 wyłącznie
dla jawnie kwalifikowanego index-only suffixu; inny/mutowany ledger jest nadal
odrzucany. Test obejmuje autentyczny hash manifestu, negatywny zmieniony prefix
oraz rzeczywisty restore starego backupu do aktualnego schema.

Benchmark: actual izolowany workerd/D1, ten sam restored corpus 4678 wierszy,
53 Items, 217 jobs, 1507 attempts, 22 runs. Przed usunięte nowe indeksy i dokładne
stare SQL; po bieżące SQL i migracja. Koszt jest z `meta.rows_read/written`,
nie z liczby zwróconych wierszy. Zero provider/prod requests. To reprezentatywna
kopia obecnego małego corpus, nie rzeczywisty pomiar 20 kanałów.

| Operacja                            | Reads przed | Reads po | Spadek | Writes przed/po |
| ----------------------------------- | ----------: | -------: | -----: | --------------: |
| Jedno transcript admission          |        1508 |        4 | 99.73% |           0 / 0 |
| Capacity page, 50 Items + lookahead |      232713 |     1328 | 99.43% |           0 / 0 |
| Metadata refresh, nic należnego     |        2545 |        2 | 99.92% |           0 / 0 |
| Backup chunk job_attempts           |        3021 |       32 | 98.94% |           3 / 3 |
| Cały canonical backup lokalnie      |      269699 |    31184 | 88.44% |     1098 / 1098 |

Wyniki hash-identical; pełny backup porównuje counts/chunk hashes każdej tabeli,
z pominięciem tożsamości nowej sesji i czasu. Konstrukcja indeksów: 1877 reads,
75 writes lokalnie. Indeksy zwiększają późniejsze zapisy odpowiednich kolumn,
co uwzględnia budżet; nie twierdzimy, że koszt write spadł.
Receipt: `d1-cost-comparison-2026-10-09T19-28-12.759Z.json`.
Wcześniejsze dwa pomiary zachowują swój zakres wersji (metadata 160 reads przed
ostatnim due-range indeksem); nie są przepisywane na nowe wyniki.

API zwraca bezpieczny 503 D1_DAILY_READ_LIMIT/WRITE_LIMIT i Retry-After do UTC
resetu. Executor przerywa zwykły exponential polling do resetu+5s, reaguje na
abort, pozostawia durable jobs. To zapobiega zbędnym requestom; nie odblokowuje
zapisu, którego Cloudflare już odmawia. Znany kod 7500 bez jawnego daily limit
nie jest automatycznie klasyfikowany jako quota. Generic/transient retry i
fencing pozostają zachowane.

## Testy kontra normalna praca i budżet 20 kanałów

Poniższe wartości to **model planowania** oparty na powyższych pomiarach, a nie
nowy actual production benchmark. Koszt zależy od Items/attempts/accepted data,
nie wyłącznie liczby źródeł. Założenia: executor 24h, admission raz/30s, cron
288/dzień, hourly Gate C, 53 aktywne Items/kanał (1060 dla 20), snapshot jednej
dziennej kopii. Dla 20 przyjmujemy konserwatywnie liniowe ×20 na kolektorze/
backupie; nie gwarantuje to liniowości po zmianie rozkładu danych.

| Scenariusz              | Przed / po lub oszacowanie                                                                                                            | Niewiadome                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalne tło, 1 kanał   | Admission 4 343 040→11 520/d; idle metadata 732 960→576/d. To dwa składniki, nie cała aplikacja.                                      | Actual corpus ewoluuje; live post-change pomiar oczekuje.                                                                                                                 |
| Backfill jednego kanału | Chodzi o rzeczywiste nowe Items, SOURCE artifacts, retry i ewentualne AI, a nie sam 1-bit source flag.                                | Brak izolowanego produkcyjnego kosztu/item. Przydział budżetu i etapowanie, bez nieograniczonej aktywacji pełnej historii.                                                |
| Normalne 20 kanałów     | Admission około 11 520/d przy braku cooldown errors; hourly collector około 0.701 mln/d = 1328 × 22 strony × 24 dla 1060 Items.       | Index entries błędów, wiele accepted runs/item, długość historii i stale metadata mogą zwiększyć koszt.                                                                   |
| Jednorazowy backup      | 31 184 reads /1098 writes zmierzone na kopii 1 kanału; ×20 daje około 0.624 mln reads /21 960 writes.                                 | To oszacowanie z całego corpus, nie zmierzone 20.                                                                                                                         |
| Automatyczny backup     | Due po 22h dla rezerwy RPO <=24h; hourly check nie oznacza hourly capture. Możliwe dwie kopie w jednym dniu UTC.                      | RPO nie może zostać porzucone przez budżet testowy. Większy corpus zwiększy koszt kopii.                                                                                  |
| Intensywne Gate D/R     | Lokalny D1: 0 prod rows. Pozostałe live admin próby: 50k reads/5k writes, koniec nowych prób po nieznanym meta/błędzie/przekroczeniu. | Jedno zapytanie może przekroczyć miękki budżet; cleanup/recovery są poza nim.                                                                                             |
| Gate C obserwacja       | Zwykły model godzinowy powyżej; przy >=80% lub UNKNOWN odroczone, gap retained.                                                       | Nie ma 7+28 dni, 20 aktywnych sources ani accepted real AI.                                                                                                               |
| Recovery po awarii      | Istniejąca niezależna kopia + lokalny pusty restore: zero production rows. Odtworzenie prod zapisuje canonical corpus i indeksy.      | Bulk restore corpus 20 kanałów może przekroczyć 100k writes. Nie udajemy możliwości ukończenia takiego importu w 1 dzień Free; cloud recovery RTO nadal niekwalifikowane. |

Budżet odczytów typowego dnia 20 kanałów: 0.4 mln na pozostałe control/job
queries (konserwatywny przydział; nie trace), 0.012 mln admission/metadata,
0.701 mln kolektor, 0.624 mln jeden backup, 0.1 mln GUI, 0.1 mln Daily,
0.5 mln nowe materiały/retry, 0.5 mln etapowany backfill, 0.05 mln live testy:
**2.987 mln +1 mln rezerwy =3.987 mln <5 mln**. Przydziały ingestion/Daily/GUI
muszą zostać skalibrowane z aktualnych `meta` po reset; nie przedstawiają
zmierzonej przepustowości ani obietnicy przyjęcia 20 kanałów.

Write envelope: 15k tło (zaokrąglona ekstrapolacja dzisiejszych 11 178),
22k jedna liniowo skalowana kopia, 20k ingestion/AI/Daily, 10k backfill,
5k live testy, 1k nowe index entries, 20k retry/recovery reserve:
**93k <100k**, z niewielkim zapasem. 20k ingestion to przydział, nie zmierzony
koszt zaakceptowanych generacji. Nieznana liczba evidence/observations/chunks
uniemożliwia dzisiaj wiarygodne potwierdzenie tego modelu. Writes wymagają
szczególnej kontroli; duplicate full captures szybko wyczerpują ten envelope.

Wysoki dzień: same nowe materiały 2 mln reads zamiast 0.5 mln, backfill 1 mln
i dodatkowa kopia 0.624 mln/22k writes zwiększają model do **5.611 mln reads
bez 1 mln rezerwy oraz co najmniej 115k writes**. Nie mieści się w Free.
Rekomendacja: jedna zweryfikowana kopia zgodnie z RPO, odroczenie backfill/testów
i Gate C przy progu, źródła wdrażane etapami po zgodzie. Durable intake/recovery
zachowuje intencje; nie obniżamy correctness ani nie włączamy paid fallbacku.
Jeśli actual normalne ingestion przekracza zapisowy envelope, wymagane będzie
ustalenie realnego wolumenu materiałów/okna backfill; nie da się usunąć kosztu
zapisu wymaganych canonical danych samym indeksem.

**Ocena 0 PLN:** dominujący koszt odczytów usunięty w lokalnym dowodzie;
20-source D1 wygląda warunkowo wykonalnie przy ograniczonym wolumenie i jednej
kopii/dzień. Pełna zdolność 20 kanałów, real AI throughput, duży restore i
peak write budget są NIEKWALIFIKOWANE. Brak zgody na Gemini pozostaje niezależny
od D1; ten raport nie potwierdza capacity Gemini.

## Ochrona i kontrolowana kontynuacja

`d1-usage.ts` odczytuje all-account hourly Analytics, bez SQL. Fresh UTC sample
<=15 min; invalid/empty/truncated/stale =UNKNOWN. Policy 80% obu dziennych
limitów rezerwuje capacity krytyczną. Receipt/log publikuje stan EXHAUSTED /
RESERVE_CRITICAL_CAPACITY; nie zapisuje fikcyjnego exact_remaining. Hourly
capacity task korzysta z tej policy. Dzisiejsza rzeczywista kontrola zwróciła
EXHAUSTED i CAPACITY_DEFERRED_D1_RESERVE, zero collector SQL.
Alert jest lokalnym receipt/task logiem; aplikacja nie ma potwierdzonego
dashboardowego account usage alert ani nowego systemu mail/push.

`d1-resume.ts` nie wykonuje provider request przed 2026-10-10 00:00 UTC;
exclusive daily intent oraz jedna indexed table probe zapobiegają ponownym
próbom. Heartbeat 02:05 Europe/Warsaw ma sprawdzić realną dostępność, zastosować
36 + build, zachować rzeczywiste meta i wykonać tylko pozostałe przypadki.
Nie zakładamy dostępności na podstawie zegara. Szczegóły i minimalne 2 R /7
D-export: [D1_CONTROLLED_RESUME](../../runbooks/D1_CONTROLLED_RESUME.md).

Kopia 5a30668c z 8 października 18:33:32.355 UTC nadal kompletna, integralna i
niezależnie odtworzona. Wystarcza na lokalne fixture/recovery i migrację indeksów.
O resecie ma 29h26min, a cut wzrósł 1593→2255: jedna świeża kopia będzie
uzasadniona RPO i późniejszymi zdarzeniami, jeżeli cadence jeszcze jej nie ma.
Nie wykonano nowego produkcyjnego capture dla powtórzenia PASS.

## Weryfikacja i aktualne gates

Dodatkowa kontrola reset/cadence wykazała ryzyko wyścigu: kod narzędzia backupu
z ledger 36 mógł wystartować przy jeszcze applied 35 i wystawić nieprawdziwy
migration set. Naprawiono: bounded applied name/hash readback przed owner session
i capture. Niezgodność zostawia kopię DUE i czeka na migrację; recovery/cleanup
istniejącej kopii nie są blokowane. Regression real SQLite prefix35→exact36→
changed checksum oraz restore: 9 targeted PASS. Pełna wcześniejsza regresja
689 PASS pozostaje dowodem dla runtime optymalizacji; nowy guard jest dodatkowy.

Cadence zachowuje due 22h dla dwugodzinnej rezerwy RPO. Dwie kopie w dniu UTC
są możliwym **normalnym szczytem**, nie tylko dodatkowym testem. W modelu write
93k +22k =115k z rezerwą; odroczenie 10k backfill i5k testów zostawia około
80k rzeczywistych wydatków oraz 20k rezerwy. To przydziały do kalibracji,
nie zmierzone 20-channel writes. Nie obniżono RPO dla sztucznego dopasowania
budżetu. Największym pozostałym ryzykiem Free po optymalizacji są writes,
długa historia i rozmiar pełnego restore, a nie pierwotny admission scan.

Po commicie diagnozy kontynuowano niezależny Master Plan: actual yt-dlp
process-failure/restart/SOURCE acceptance PASS (15.556s recovery, 1071 cues,
jedno accepted effect, poprawny fencing), actual Google invalid_grant i local
owner API visibility PASS oraz 19/19 zatwierdzonych canonical source identities
rozwiązanych (19 YouTube requests). Zero produkcyjnego D1/Gemini/Drive file writes.
Szczegóły i zakresy są w aktualnym RELEASE_READINESS_REPORT.md. Formalne gates
nadal wymagają odpowiednich configuration/baseline pins; nie zaliczono nimi
pełnego Gate R/D-export. Nie wykonano nowej produkcyjnej kopii.

Actual lokalny benchmark wszystkich pięciu operacji PASS, identyczne wyniki i
write counts, EXPLAIN zachowany. Pełne Workers **234 PASS /0 FAIL** oraz targeted
po ostatnim metadata index/SQL **8 PASS**. Typecheck całego repo i lint PASS.
Public secret scan PASS, 4 files/409769 bytes, zero findings. Migracje 36:
fresh install/empty restore/FK/integrity PASS. Pełny unit/contract sekwencyjnie:
**455 PASS /0 FAIL /1 świadomy platformowy skip**; razem z Workers **689 PASS**.
Pierwszy współbieżny run miał timeout istniejącego 1 MiB encryption testu;
powtórzenie bez równoległego ciężkiego benchmarku przeszło bez zmiany testu.
Evidence: `d1-final-verification-2026-10-09.json`.

Production measurements/deploy i brakujące rzeczywiste D1 integracje oczekują
wyłącznie na reset; nie zablokowano nimi niezależnych prac. Gate R historyczne
8/10 PASS zachowuje historyczne pins, D-export 6/13, Bridge 9 NOT_RUN, Gate C
NOT_YET_MATURE. Nowego pełnego PASS ani PRODUCTION ACCEPTED nie zadeklarowano.

## Dalsze checkpointy i nowa decyzja właściciela

Regresja scheduler: 4 PASS. Po skutecznym REFRESH niezmienione metadane
pozostawały przy starej immutable fetched_at; cutoff zmieniany co cron powodował
nowe zadania co 5 minut po 30 dniach. Potwierdzony kodem błąd naprawiono przez
indeksowane membership rzeczywiście zakończonego scan/job. Nie zmieniono czasu
rewizji ani PARTIAL coverage REFRESH. Test wykonuje rzeczywisty fenced commit,
sprawdza 30 dni i brak zagłodzenia innego źródła. Aktualny index creation cost
to 2852 reads /550 writes; cały lokalny backup 269698→31185 reads (szczegóły
w nowym receipt, wcześniejszych nie przepisano). Typecheck PASS.

Obserwacja publicznych playlist 20 zatwierdzonych kanałów: 137 publikacji
w odczytanych stronach okna 28 dni, 4.892857/dzień, 20 requests; zero D1/AI.
To bounded observation z założeniem recency order, nie pełny historyczny crawl.
17 lokalnych SOURCE Items: 11 150 457 logical artifact bytes, 655 909/item;
base64 około 874 546/item, całe lokalne DB 17 231 872 bytes. Próbka TED nie
kwalifikuje rozkładu pozostałych kanałów ani realnych AI outputs.

Inventory storage dodano do monitoringu: total 5 GB i pojedyncza baza 500 MB,
próg 80%, brak inventory = UNKNOWN. Nowy targeted zestaw 26 PASS. Alert/log
nie deklaruje dokładnego remaining quota. Zero SQL diagnostycznego na produkcji.

Właściciel zatwierdził Drive-only: ciężkie dane mogą być usuwane dopiero 7 dni
po zweryfikowanym końcowym eksporcie, z holds i minimalnym trwałym stanem.
Zastępuje to wcześniejsze założenie wieloletniej historii D1; implementacja
i kwalifikacja tej zmiany są osobnym kolejnym checkpointem. Pierwsze realne
usunięcie produkcyjne i nowe żądania Gemini wymagają osobnych zgód.
