# Zakres końcowej zgody produkcyjnej

Ten dokument opisuje przygotowane zmiany; nie stanowi potwierdzenia ich wykonania. Zgoda jest wymagana przez punkt 9 zlecenia użytkownika, dla migracji D1, przełączenia usług i aktywacji stałego wykonawcy.

1. **Zmiana:** kopia bezpieczeństwa istniejącej D1 i zastosowanie wyłącznie brakującej migracji `040_daily_tasks_workflow.sql`; wdrożenie przygotowanego Workera z przyjmowaniem transkrypcji i odczytem wyników; rejestracja/użycie tożsamości Oracle ze scope tylko `FETCH_TRANSCRIPT`; instalacja wydania oraz włączenie przygotowanych jednostek istniejącego executora i brokera procesu. Obecny cron Workera i baza zostają wykorzystane. Nie włączamy dodatkowego workflow analizy ani nowego schedulera.
2. **Powód:** produkcja ma potwierdzone migracje 001–039, repozytorium 001–040. Bieżąca ścieżka akceptacji źródła korzysta również ze struktur 040. Nowe trasy API i automatyczny wykonawca muszą zostać udostępnione w docelowym środowisku, żeby zastąpić test lokalnego Workera/D1 na Oracle.
3. **Ryzyko:** migracja jest addytywna i nie usuwa tabel ani danych; standardowy deploy może na krótko wpłynąć na obsługę żądań. Brak nowych płatnych zasobów, subskrypcji lub zmiany planów. Obowiązują limity darmowych usług i istniejącego konta; nie gwarantujemy nieograniczonej liczby filmów. Zadanie źródłowe pozostaje ograniczone do 768 MiB, CPU 50%, swap 0 i concurrency 1. Google/YouTube może unieważnić sesję niezależnie od programu.
4. **Weryfikacja i rollback:** przed migracją użyć istniejącego mechanizmu prywatnej kopii i sprawdzić zgodność ledger/hash. Po wdrożeniu potwierdzić jeden pełny przepływ przez produkcyjne API, odczyt segmentów i restart executora. W razie regresji zatrzymać i wyłączyć nowe jednostki Oracle, cofnąć Workera do poprzedniej wersji, a nową tożsamość wykonawcy unieważnić. Pozostawić kompatybilną, addytywną migrację; odtwarzanie kopii bazy stosować tylko przy rzeczywistym uszkodzeniu i świadomej zgodzie ze względu na nowe zapisy.

Potwierdzona wersja Workera przed zmianą: `224ba7ff-a4ab-47ff-8cc1-70aadb2d91b1` (100% ruchu, deployment `bd3cbb53-e8e0-438f-9d32-8bc45b3f8d23`). Bezpośrednio przed wdrożeniem ponownie sprawdzić, czy nie pojawiła się nowsza wersja użytkownika.

Nie wykonano commit, push, merge, migracji produkcyjnej ani aktywacji stałych usług w ramach przygotowania.
