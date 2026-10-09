# V1 — zatwierdzona rewizja Drive-only i retencja 7 dni

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
