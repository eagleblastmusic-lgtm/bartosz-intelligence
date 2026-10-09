# V1 — zatwierdzona rewizja Drive-only i retencja 7 dni

## Aktualna rewizja właściciela: pełne transkrypcje, V1.1.3

2026-10-10, OWNER_APPROVED. Rozszerza poprzednią decyzję: Drive przechowuje
zarówno polskie streszczenia w Daily, jak i pełny pozyskany tekst oryginalnych
napisów w osobnych plikach `Transkrypcje/<video_id>.md`. Daily i Backups zachowują
ID i zawartość. Nowy podfolder powstaje w istniejącym Bartosz Intelligence
`1aFYzO7kMVebvP-Y-V6oIWAAkf21MR7mN`; jego rzeczywisty ID wymaga zapisu live receipt.

P0 pozostaje: film ukończony dopiero po verified summary → Daily. Eksport
transkrypcji ma własny stan/retry i działa także przed AI lub przy błędzie Gemini.
Jego awaria nie blokuje streszczenia. Daily dodaje link po verified transcript
receipt; wcześniejszy raport jest wtedy aktualizowany pod tym samym ID.

Pełny tekst oznacza wszystkie rzeczywiście pozyskane cue, także puste i
powtarzające się, z oryginalnym językiem/markup i dostępnymi timestampami.
Nie normalizujemy, nie tłumaczymy, nie skracamy i nie dopisujemy braków.
Tożsamość niezmiennych artefaktów uwzględnia SHA surowego payloadu i status
źródła, ale nie zmienną datę pobrania. Retry tych samych napisów zachowuje
dedup; przejście PARTIAL → AVAILABLE_FULL lub zmiana timestampów tworzy nową
wersję źródła i aktualizuje ten sam plik archiwum. Kwalifikowany yt-dlp i jego
wersja pozostają bez zmian; nowe deskryptory mają jawny suffix tożsamości.
MANUAL/GENERATED, PARTIAL/AVAILABLE_FULL/UNKNOWN i niepotwierdzony język źródła
są jawne. Pełny dostępny payload napisów nie dowodzi każdej wypowiedzi w filmie.
Pozyskany niepełny tekst jest zachowany i archiwizowany; nadal nie kwalifikuje
kompletnej analizy AI.

Zmodyfikowane wymagania: §7/10 źródła, §19/23 archiwizacja, §25.3 recovery,
§26.2 D-export oraz Stage 03/05/07/08. Cleanup wymaga teraz verified Daily
**i** verified transkrypcji odpowiadającej źródłu zaakceptowanej analizy, bez
pending archiwizacji lub hold. Zegar jest konserwatywny: siedem dni od
późniejszego potwierdzenia obu archiwów. Ponowienie tych samych bytes nie
przesuwa zegara. Przed pierwszym DELETE sprawdzane są oba prywatne pliki,
SHA-256, parent i stabilna wersja; restart ponownie sprawdza wersje.

Bez zmian: jakość polskiego streszczenia, Evidence/provenance bieżącej analizy,
dedup, fencing, recovery, minimalne metadane D1, istniejące moduły oraz realne
kryteria 20 kanałów i 0 PLN. Wycofany jest wcześniejszy zakres „wyłącznie
streszczenia są wymaganym trwałym archiwum”. Wieloletni magazyn Knowledge nadal
nie jest wymagany. Nie dodano bazy ani providera i nie zwiększono liczby generacji.

Implementacja używa dotychczasowych SOURCE_ORIGINAL i SEGMENT_MAP; nowe tabele
039 przechowują tylko mapowanie folderu i operacyjny receipt/retry pliku.
Backup inventory rośnie z 55 do 57 tabel, bez nowej kopii transkrypcji w D1.
Backupy schema 35/36/37/38 zachowują swój format i odtwarzają się do 39.
Restore unieważnia leases i wymaga reauth/private-folder verification.
Nie da się odtworzyć nieposiadanego tekstu po historycznym purge; niczego nie
generujemy w jego zastępstwie. Starsze checkpointy poniżej zachowują historię.

DoD: source fidelity; private reserved ID przed create; independent retry;
readback/version/SHA; CAS zmiany źródła pod tym samym ID; link Daily; hold
cleanup przy braku transkrypcji; restart i restore po purge; rzeczywisty
podfolder i przynajmniej jeden live transcript receipt. Local PASS nie spełnia
ostatnich dwóch warunków. Pierwsze produkcyjne DELETE nadal wymaga osobnej zgody.

## Historyczna rewizja V1.1.2-retention

Status: OWNER_APPROVED, 2026-10-09. Rewizja wymagań: **V1.1.2-retention**,
uzupełnienie Master v1.1.1 i Implementation Pack v1.0.1. Decyzja właściciela
zastępuje sprzeczne wcześniejsze wymagania; historyczne evidence zachowują zakres
i nie stają się FAIL. Produkcyjne usuwanie wymaga osobnej zgody na pierwszy
konkretny dry-run. `paid_services_enabled=false`; nowe Gemini nadal wymagają zgody.

Google Drive Daily jest trwałym archiwum czytelnych polskich raportów Markdown.
D1 jest authority bieżącej walidacji i minimalnego stanu operacyjnego. Ciężkie
dane robocze kwalifikują się do usunięcia po co najmniej 7 pełnych dniach od
skutecznego, zweryfikowanego końcowego eksportu, nigdy od daty publikacji.
Niezakończona analiza/eksport, niedostępny Drive, konflikt, aktywna zależność,
korekta, recovery lub ręczny hold odraczają cleanup. Nie gwarantujemy trwałości
nieistniejącego raportu ani nie usuwamy niezanalizowanych materiałów dla budżetu.

Foldery pozostają: Bartosz Intelligence `1aFYzO7kMVebvP-Y-V6oIWAAkf21MR7mN`,
Daily `1rn_5auxY_8HAeADc1RgGKQ6h9JimD7WM`, Backups
`1qulQNJMmEcFy_9o3908CNgU6Kdj7aB84`. Istniejących plików i ID nie przenosimy.

| Wymaganie / Master                                                                                  | Nowy status i minimalna delta                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1, §17, §18: trwały pełny Core/Ledger/Evidence                                                     | ZMIENIONE: kompletne podczas pracy i retencji; po eksporcie pozostają receipt, canonical video ID, konfiguracja, dedup i stan zakończenia. Pełna wieloletnia historia D1 WYCOFANA.                                                                                                                          |
| §7–§14, §19, §24: discovery, source authority, trwałe jobs, walidacja, enrichment, prompt snapshots | BEZ ZMIAN dla bieżącej analizy. Profile Economy/Full/Custom, Registry/Studio/Lab pozostają. Przyszłe reprocess po cleanup wymaga jawnego odzyskania źródła i świadomego run; nigdy automatycznego retry.                                                                                                    |
| §20, §25: Dziennik i detail                                                                         | ZMIENIONE: po archiwizacji tytuł/film/status i link do Drive, bez udawania dostępności usuniętej analizy.                                                                                                                                                                                                   |
| §18, §23: Knowledge/Ledger/FTS/history/translation                                                  | ZMIENIONE: działają na dostępnym aktywnym zbiorze. Wieloletnie wyszukiwanie szczegółów D1 i dowolne cross-history po cleanup WYCOFANE z obowiązkowego V1. Nie usuwamy implementacji. Właścicielskie notatki/korekty są hold; wspólny słownik encji/aliasów pozostaje konfiguracją używaną przez enrichment. |
| §21: COMPACT default                                                                                | ZMIENIONE: nowe automatyczne archiwa FULL, kompletne i bez pominiętych jednostek. COMPACT pozostaje opcją Bridge i historycznych plików; sam nie uprawnia do cleanup. Nie zmieniamy istniejących Daily.                                                                                                     |
| §22: System                                                                                         | ZMIENIONE: pokazuje tryb, termin retencji, holds i ilości logicznie usunięte.                                                                                                                                                                                                                               |
| §23: backup/restore                                                                                 | BEZ ZMIAN dla integralności, dostępu, wykluczania sekretów i RPO/RTO; ZMIENIONE inventory o minimalny retention/dedup/Drive mapping. Restore wyłącza deletion i wymaga odnowienia Drive/reverification. Bez nowego wymogu szyfrowania aplikacyjnego.                                                        |
| §26.4.1: D-export / D-bridge                                                                        | D-export dodatkowo dowodzi dokładnego accepted membership i verified file/version/hash. D-bridge nadal niezależny, nie kwalifikowany przez Codex/local reader.                                                                                                                                              |
| §26.4, Stage 08: Gate R                                                                             | Dodatkowe regresje interrupted cleanup/restart/restore after purge/no duplicate. Historyczne cases zachowują pins; nowe schema wymaga zgodnego bieżącego baseline.                                                                                                                                          |
| §26.5, Stage 05: Gate C                                                                             | Te same realne 20 kanałów, windows/λ/μ/precision/headroom/zero paid. Dodatkowo aktywny working set, holds/backlog cleanup, reads/writes i physical high-water. Model forecast nie zastępuje actual mature PASS.                                                                                             |

Nowe DoD Stage 07/08: exact report membership, siedmiodniowy zegar, świeży
Drive readback przed pierwszą porcją, wersja pliku przy wznowieniu, atomic <=25
rows batch, durable phase/step/cursor, rollback/restart/idempotency, brak
ponownego intake, czytelny archived state, kompatybilny backup/restore,
zmierzone local D1 meta i bezpieczny production dry-run. Destructive production
DoD pozostaje NOT_RUN do osobnej zgody i faktycznego dowodu.

Nowe snapshoty zawierają tylko aktualnie istniejące canonical rows, więc po
cleanup nie odtwarzają usuniętych ciężkich danych. Stare pełne kopie zachowujemy.
Rekomendowana późniejsza polityka Backups: rolling 7 zweryfikowanych kopii
operacyjnych + jedna najnowsza miesięczna (łącznie maksymalnie 8, bez rosnącej
kolekcji miesięcznej), bez ręcznego resetowania RPO. Automatyczne usuwanie
historycznych backupów pozostaje WYŁĄCZONE i wymaga oddzielnej zgody; do czasu
niej mierzyć wzrost Drive i unikać duplikatów, bez twierdzenia o bounded archiwum.

Implementation Master Plan trwa dalej. Gate AI/human odbiory, pozostałe Gate R,
7 D-export i realne Gate C zachowują niezaliczone kryteria. Ta decyzja nie jest
zgodą na nowe generacje, płatne usługi ani pierwsze produkcyjne DELETE.

# Doprecyzowanie właściciela: nadrzędny wynik P0

2026-10-09: właściciel potwierdził, że celem V1 jest automatyczne dostarczenie
poprawnego polskiego streszczenia **każdego wykrytego filmu** na Google Drive.
Etap AI może zakończyć się przyjęciem wyniku, ale film jest ukończony dopiero
po potwierdzonym zapisie końcowego streszczenia: file ID, stabilna wersja,
pełny readback i zgodny SHA-256. D1 pozostaje bazą operacyjną.

Minimalna rewizja odbioru:

- P0 obejmuje durable discovery/transcript, walidowane polskie streszczenie,
  zweryfikowany Drive, bezpieczne retry/dedup, restore stanu operacyjnego,
  retencję oraz rzeczywistą obserwację 20 zatwierdzonych źródeł.
- Historyczne wyszukiwanie Knowledge, rozbudowana historia Ledger i Bridge
  nie blokują odbioru samego dostarczania streszczeń. Ich istniejące implementacje
  pozostają; nie dokładamy historycznego magazynu.
- Testy integralności, jakości treści, uprawnień i recovery pozostają wymagane.
  Przeglądu człowieka ani live E2E nie zastępuje fixture. Istniejące formalne
  Gate R/D/C zachowują wynik i pins; zmiana priorytetu nie nadaje im PASS.
- Gotowe streszczenie w FULL może być dostarczone, gdy inne filmy lub discovery
  dnia są jeszcze nieukończone. Taki raport nadal jawnie oznacza częściowy dzień.
- Dla filmu bez daty publikacji dzień eksportu wynika z daty wykrycia; dokument
  jawnie zachowuje nieznaną datę publikacji. Po pierwszym verified eksporcie
  mapowanie dnia raportu pozostaje stabilne przy korekcie metadanych.
- Późny materiał aktualizuje istniejący plik Daily, zachowując odczytane i
  zweryfikowane wcześniejsze streszczenia po cleanup. Zmiana/zaginięcie Drive,
  konflikt hash/version lub trwający cleanup odraczają zapis.
- Niepuste streszczenie jest konieczne do potwierdzenia dostarczenia P0.
  Custom bez modułu summary i pusty wynik nie oznaczają ukończenia filmu.

Nowa generacja Gemini, zmiana modelu i pierwsze produkcyjne usunięcie nadal
wymagają odrębnych upoważnień wskazanych przez właściciela. Bieżący checkpoint
nie zawiera takich operacji. `paid_services_enabled=false`.
