# Drive-only V1.1.2-retention — implementacja i granice kwalifikacji

2026-10-09. **LOCAL IMPLEMENTED; PRODUCTION NOT_DEPLOYED; DELETION NOT_APPROVED.**
Decyzja: [zatwierdzona rewizja](../../decisions/DRIVE_ONLY_RETENTION_V1_2026-10-09.md).
Produkcja nadal 35 migrations; lokalny ledger ma 37. Nie wykonano produkcyjnego
DELETE, nowego canonical capture na produkcji, nowego Gemini ani płatnej operacji.

## Zrealizowana delta

Nowy automatyczny raport FULL zachowuje polską treść, wszystkie wybrane moduły,
Evidence refs i potrzebne źródłowe URL/timestamps. Tylko kompletny wynik OK bez
pominięć otrzymuje exact membership item/run/canonical hash. Dopiero atomic
zakończenie eksportu po sprawdzeniu odczytanych bytes i stabilnej wersji zapisuje
minimalny receipt i termin verified_at + 7 dni. Replay identycznego wyniku nie
przesuwa zegara. Regresja z 90-sekundowym odczytem potwierdza, że zegar
nie startuje przed zakończeniem HTTP/readback. COMPACT, partial i niezweryfikowany zapis nie kwalifikują purge.

Cleanup ponownie sprawdza Drive przed pierwszym usunięciem; każda kolejna porcja
sprawdza wersję i lokalne zależności. 16 allowlisted stages, <=25 wierszy na atomic
batch, do czterech stron na cron co 5 minut. Permit istnieje tylko wewnątrz
transakcji. Phase/step/cursor i counters są trwałe; wyjątek SQL cofa całą porcję.
Owner approval default=0; nie istnieje endpoint samoczynnie aktywujący usuwanie.
Ręczny hold, korekta, niezakończony job, aktywna notatka, dirty/paused export,
odłączony Drive, niewłaściwy hash/version i backup barrier odraczają cleanup.

Redagowane są ciężkie run snapshots/outcomes i terminal job payloads; usuwane
source/AI chunks, mapy, representation flags, Evidence/Observations i ich relacje,
FTS bodies, starsze metadata revisions oraz niepotrzebne lokalne Daily bytes.
Pozostają źródła, IDs, aktualne metadata, dedup, states/origin, registry/config,
minimalne run/job/export headers i mapowanie Drive. Wspólny słownik encji nie
staje się ukrytym archiwum transkryptów. Notatki właściciela nie są usuwane.

Przed pierwszą porcją zamrażany jest rekord operacyjny <=8192 bytes: daty,
identyfikatory, source size/language/authority i hashe potrzebne do Gate C.
Nie zawiera streszczenia, transkryptu ani promptów. Regresja porównuje cały
CapacityCollection case przed i po cleanup; wynik pozostaje identyczny.
Automatyczny analysis scan, discovery intent repair i metadata refresh pomijają
zarchiwizowany Item. Bezpośredni reprocess zwraca jawny błąd wymagający recovery.

GUI pokazuje trwały link Drive i nie pobiera skasowanego canonical body.
Knowledge/Ledger/FTS zachowują bieżącą implementację dla aktywnego zbioru.
Historyczne cross-analysis i reprocessing po purge wymagają odzyskania źródła.
Zarchiwizowany dzień jest chroniony przed nadpisaniem niepełnym renderem D1;
spóźniony materiał/korekta takiego dnia wymaga jawnego recovery raportu. To
widoczne ograniczenie V1, a nie udawany sukces automatycznego eksportu.

Backup inventory obejmuje trzy małe retention tables. Zweryfikowane backupy
35/36 są przyjmowane tylko dla dokładnego historycznego prefix ledger i inventory.
Restore zarchiwizowanego raportu bez lokalnych byte chunks jest dozwolone tylko
z odpowiednim archived receipt; credentials są odwołane, Drive wymaga auth,
deletion_enabled=0 i approval=NULL. Wznowienie PRUNING wymaga pełnego readback.
Nie usunięto starych kopii ani nie dodano wymogu szyfrowania aplikacyjnego.

## Pomiary local workerd, nie wyniki produkcyjne

Korpus: prawdziwe source bytes z istniejącego zweryfikowanego backupu, 17 Items.
Accepted analysis/export oraz Drive są jawnie syntetyczne. Koszty to rzeczywiste
D1 meta.rows_read/written; nie liczba zwróconych rekordów. Fixture i backup są
związane hashami w receipt. Nie kwalifikuje to AI quality, live Drive ani Gate C.

| Przypadek                              | Source bytes / chunks | Cleanup reads / writes | Dry-run reads / writes | Strony |
| -------------------------------------- | --------------------: | ---------------------: | ---------------------: | -----: |
| Mediana, przed indeksem item chunks    |            68 768 / 6 |               858 / 95 |                 16 / 0 |     16 |
| Mediana, indeks chunks                 |            68 768 / 6 |               846 / 95 |                 15 / 0 |     16 |
| Największy, przed indeksem item chunks |       7 542 395 / 239 |           10 387 / 369 |                249 / 0 |     26 |
| Największy, indeks chunks              |       7 542 395 / 239 |            3 493 / 369 |                248 / 0 |     26 |

Końcowa redukcja redundantnych indeksów i partial due index:

| Finalne schema 37 | Cleanup reads / writes | Dry-run reads / writes | Strony |
| ----------------- | ---------------------: | ---------------------: | -----: |
| Mediana           |               863 / 94 |                 15 / 0 |     16 |
| Największy        |             3510 / 368 |                248 / 0 |     26 |

Ostatnia delta usuwa zbędne indeksy export chunks/observation oraz nieużywany
member index. Due index obejmuje wyłącznie phase != COMPLETE; EXPLAIN
potwierdza jego użycie, status pomija ukończoną historię. To zwiększyło koszt
małej fixture o 17 reads, zmniejszyło writes o jeden i ogranicza przyszłe
skanowanie trwałych receiptów. Finalne receipts:
`local-cost-31d6bfc3-855f-4a2e-b892-0874cc7c037b.json`,
`local-cost-7c9cbb20-03d4-4920-86a1-c9f94e3b05ba.json`.

Przed/po używa tego samego corpus i 16 stages; finalny wariant dodatkowo
zachowuje operacyjne metadane Gate C. Wyniki funkcjonalne/FK są zgodne. Różnica
nie jest izolowanym benchmarkiem jednej instrukcji migracji. Dodatkowo identyczne
aggregate queries na końcowym corpus wymuszają stary owner-prefix index i nowy
owner/item index, zachowują te same SUM/COUNT i zapisują EXPLAIN. Usunięto
redundantny nowy indeks Evidence identyczny z istniejącym. Indeks chunks dodaje
koszt utrzymania przy intake/delete; przedstawione cleanup writes już go obejmują.

Evidence: `local-cost-274a180c-9524-43a1-b91b-130ea213cf0c.json`,
`local-cost-f082d19a-2c2c-4874-9318-447996f9a95c.json`,
`local-cost-e4f10a89-bdca-4ebe-9a0d-5508e631452f.json`,
`local-cost-4dbf6557-b7f0-457d-9a23-c21cef09dc84.json`.
Zmierzony local size_after: finalna mediana 1 200 128→1 101 824 bytes; największy
11 513 856→1 101 824. Lokalny D1 odzyskał przestrzeń; nie gwarantuje to takiego
samego produkcyjnego file_size. page_count/freelist/auto_vacuum były niedostępne.
Nie wykonano VACUUM/optimize. Potrzebny jest rzeczywisty production high-water
po zatwierdzonym cleanup, wraz z FTS/index overhead i kolejnymi cyklami reuse.

Pełny lokalny restore oryginalnej kopii 35→37 i ponowny canonical capture:
269 725→31 212 reads dla przed/po optymalizacji 036, identyczne wyniki/writes.
Trzy puste retention tables są uwzględnione w nowym inventory. Evidence:
`../release/d1-cost-comparison-2026-10-09T20-13-42.252Z.json`.
To izolowany test nowego inventory, nie nowy produkcyjny backup dla daty PASS.

## Pojemność 20 kanałów przy 0 PLN

Zmierzona obserwacja playlist: 137 publikacji / 28 dni = 4.892857/dzień,
20 bounded requests, bez gwarancji kompletności wszystkich historycznych stron.
Źródło: `../capacity/approved-upload-rate-2026-10-09.json`.
Średnia source artifact bytes w zweryfikowanej kopii: 604 668.882/film,
mediana 68 765, maksimum 7 542 392. To próbka TED, bez rzeczywistych accepted
AI danych wszystkich kanałów. Rozkład jest silnie skośny.

| Scenariusz / założenie                                | Aktywne filmy | Source logical bytes |                            Cleanup reads/day / writes/day |
| ----------------------------------------------------- | ------------: | -------------------: | --------------------------------------------------------: |
| Obserwowane 4.892857/d, eksport bez opóźnienia, 7 dni |         34.25 |             20.71 MB |                                 4 224 / 460 przy medianie |
| Budżet typowy 5/d, dodatkowe 2 dni do eksportu        |            45 |             27.21 MB |                                 4 315 / 470 przy medianie |
| Budżet wysoki 20/d, dodatkowe 2 dni do eksportu       |           180 |            108.84 MB |        70 200 / 7 360 gdy każdy cleanup jak zmierzony max |
| Skrajny 20/d, 9 dni, każdy source jak zmierzone max   |           180 |          1 357.63 MB | Ten storage przekracza Free; nie jest prognozą publikacji |

MB oznacza milion bytes. To model, nie osiągnięte produkcyjne zużycie.
Przy założeniu dodatkowych 0.5 MB AI/film i współczynniku fizycznym 1.6,
typowe 45 Items to około 79.54 MB, wysokie 180 to 318.14 MB przed bazowym
stanem operacyjnym. AI allowance i physical factor są jawnie niezmierzone;
nie stanowią dowodu PASS względem 500 MB/bazę. Minimalny stan też rośnie z
liczbą filmów, wolniej i bez wieloletnich ciężkich artefaktów.

Budżet operacyjny do kwalifikacji, nie pomiar: typowy 0.25M reads/20k writes,
wysoki 1M/60k, GUI+obserwacja 0.1M/2k i 0.5M/5k, retry/recovery reserve
1M/20k i 1.5M/20k; dwa backup captures/dzień po lokalnym punkcie odniesienia
31 212 reads/1098 writes, cleanup jak wyżej. Suma typowa około 1.42M reads/
44.7k writes, wysoka około 3.13M/94.6k. **Wysokie writes nie mieszczą się
w progu 80% (80k), choć mieszczą się poniżej twardego 100k.** Budżet nie daje
zgody na high load; trzeba zmierzyć rzeczywisty intake/AI/export/backup przy
aktywnym working set i odraczać backfill/diagnostykę. Lokalny backup z 17 SOURCE
nie jest stałym kosztem dla 180 pełnych analiz. Backfill nie ma rezerwy high:
lokalnie oszacować wybrany batch, wznawiać tylko przy świeżym headroom.

Przepustowość cleanup: max 1152 stron/dzień przy czterech na cron; około 72
medianowych lub 44 największych zmierzonych filmów/dzień, poza holds/awariami.
Wystarcza dla przyjętego 20/d modelu samego cleanup. Nie potwierdza λ/μ AI.
Przed aktywacją należy mierzyć `verified→eligible→complete`, rozmiar i wiek holds,
account reads/writes oraz storage high-water. Opóźnienie analizy/eksportu i holds
mogą być nieograniczone; siedem dni nie jest limitem od discovery. Bez działającego
AI/Drive lub przy długim hold backlog nadal rośnie. Nie wolno go usuwać kosztem
integralności. Konkretny długotrwały overflow wymaga świadomej decyzji o intake,
zakresie lub bezpiecznym odzyskaniu przestrzeni; płatny fallback pozostaje OFF.

## Odbiór i dalsze kroki

Końcowe wyniki testów i ich byte hashes zapisuje `verification-summary.json`.
Testy obejmują granicę siedmiu dni, incomplete/partial, Drive failure/hash/version,
concurrent hold, aktywne jobs/korekty, atomic crash rollback, persisted database
restart, retry, obce Item, dedup, brak redownload, Gate C i restore po purge.
E2E sprawdza archived Drive link bez canonical/AI oraz istniejące aktywne moduły.
Lokalny benchmark nie zastępuje produkcyjnego quota/exact membership/readback.

Po resecie: jedna indexed probe; analytics/inventory; migracje 036+037 i runtime;
produkcyjne observation/dry-run; minimalne D/R pomiary; staged new-only z zachowanych
19 IDs. Najpierw przedstawić rzeczywisty pierwszy scope usuwania do osobnej zgody.
Brak Gate C mature, live AI zgody, human reviews i formalnych D/R pins nadal
wyklucza pełny PASS i PRODUCTION ACCEPTED. Nie ponawiać zakończonych provider drills.

## Ograniczenie wzrostu Backups

Istniejący zweryfikowany canonical JSON ma 15 799 265 bytes. Samo zachowywanie
kopii takiego rozmiaru co 22h daje około 6.29 GB/rok, nawet bez wzrostu working
set i bez Daily. To arytmetyczny model, nie rzeczywiste roczne wykorzystanie.
Nowa retencja D1 nie ogranicza automatycznie historycznych plików Drive.
Rekomendacja do osobnego zatwierdzenia: 7 ostatnich zweryfikowanych kopii
operacyjnych + jedna najnowsza miesięczna (max 8; nie jedna na każdy miesiąc
bez końca), z zachowaniem ostatniej niezależnie restore-verified kopii do czasu
kwalifikacji następcy. Po spełnieniu tej polityki modele 8×15.8 MB i 8×318 MB
to około 126 MB i 2.55 GB, lecz rozmiar SQL DB nie jest rozmiarem JSON backupu.
Wysoki wariant jest jedynie ilustracją, nie zmierzonym footprintem archiwum.
Automatyczne kasowanie backupów jest nadal wyłączone. Istniejących plików nie
usunięto; bez osobnej zgody rotacja nie może udawać wdrożonej ochrony pojemności.
