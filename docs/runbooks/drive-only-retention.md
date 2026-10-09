# Drive-only retention, cleanup i recovery

Autorytatywna decyzja: [V1.1.2-retention](../decisions/DRIVE_ONLY_RETENTION_V1_2026-10-09.md).
Migracja 037 jest addytywna; 036 optymalizuje odczyty, a 038 kwalifikuje bezpieczną aktualizację raportu po retencji. Przed wdrożeniem wymagane
lokalne regresje, migracje/FK/integrity i aktualny backup preflight. Nie edytować
zastosowanych migracji 001–035. Istniejące backupy 35/36/37 odtwarzają się do 38;
nowy inventory zawiera `retention_settings`, `daily_export_members`,
`retention_items`. Stare nie są nadpisywane.

## Obserwacja i pierwszy dry-run

Domyślne `deletion_enabled=0`, `approval_reference=NULL`. Cron co 6 h zapisuje
obserwację liczebności; każda produkcyjna invokacja cleanup przy takim ustawieniu
kończy się bez Drive request i bez DELETE. System odczytuje `/system/retention`.
Owner API `POST /system/retention/dry-run` z pustym JSON i istniejącym CSRF
wykonuje bounded odczyt maks. 5 Items i ilości bytes; nic nie usuwa. Kolejne
strony pierwszego review można odczytać administracyjnie po kluczu Item, bez
pełnego skanu ciężkich bodies. Nie przedstawiać database eligibility jako
potwierdzenia świeżego stanu zdalnego pliku.

Przed pierwszą aktywacją przedstawić właścicielowi: dokładne Item/video IDs,
file ID/version/hash, accepted run, verified_at/purge_after, holds/dependencies,
liczbę wierszy i bytes do usunięcia, aktualną niezależną kopię, dry-run receipt
i plan pierwszego batcha. Dopiero osobna zgoda upoważnia zapis approval_reference
i włączenie deletion. Brak endpointu, który włącza to przypadkowym kliknięciem.
Obecnie zgody na pierwsze produkcyjne usunięcie NIE MA.

## Wykonanie po przyszłej zgodzie

Cleanup kwalifikuje tylko dokładny zaakceptowany, kompletny wynik filmu z
niepustym polskim streszczeniem w FULL oraz verified Drive attempt. Inne pending
filmy lub incomplete discovery dnia nie unieważniają tego wyniku. COMPACT,
częściowy wynik samego filmu, puste summary i pliki bez membership pozostają hold.
Nowy accepted run/canonical hash lub zmiana docelowego pliku rozpoczyna nowy
zegar; aktualizacja tego samego pliku zachowująca ten sam wynik filmu nie przesuwa
jego pierwszego verified_at/purge_after. Aktualny hash/version całego pliku nadal
musi zgadzać się przed cleanup.

## Późny film po cleanup

Runtime odczytuje istniejący FULL z Drive: metadata → bytes → metadata, sprawdza
identity/root/trashed, stabilną wersję, zapisany SHA-256 i protokół raportu.
Bloki ukończonych filmów zachowuje w całości. Executor porównuje je ponownie
przed CAS i odmówi usunięcia lub zmiany któregokolwiek. Zweryfikowana nowa wersja
aktualizuje receipts i export state atomowo, pod tym samym file ID. Migracja 038
odmawia zmiany pliku lub advancement bez zgodnych archived receipts.

Trwający PRUNING odracza aktualizację; cleanup nie rozpoczyna się przy aktywnej
export lease. Brak Drive, manual edit, utracony plik lub niezgodny readback
zachowują pracę i wymagają retry/recovery, bez renderowania pustego archiwum.
Nie odtwarzamy transkryptów/Knowledge w D1. Sam globalny polling źródeł/discovery
nie przelicza zarchiwizowanych dni; rzeczywisty nowy film/wynik nadal oznacza
swój dzień jako dirty. Dzień istniejącego dostarczenia pozostaje stabilny przy
korekcie daty publikacji; nie tworzymy drugiego streszczenia w nowym dniu.

Pierwszy batch ponownie pobiera metadata → całe bytes/hash → metadata ze stabilną
wersją. Każde wznowienie sprawdza wersję/file/parent/trashed i wszystkie lokalne
warunki. Do czterech porcji na cron; każda <=25 wierszy jednego allowlisted stage; atomic
permit, mutate, counters i checkpoint w jednym D1 batch. Permit nie pozostaje
między requestami. Błąd powoduje rollback; nowy proces wraca do persisted step.
Nie używać OFFSET ani pętli do wyczerpania całego corpus.

Usuwane są chunks RAW/SOURCE/NORMALIZED/map/AI, representations, repair i optional
results, powiązania i szczegółowe observations/evidence, FTS bodies oraz nieaktualne
metadata revisions. Run snapshots/outcomes i terminal job payload są redagowane
do małych stubs; IDs, dedup keys, origin, zakończenie i mapowanie Drive pozostają.
Daily byte chunks są usuwane tylko gdy żaden członek finalnego raportu nie czeka
na rozpoczęcie retencji. Nagłówki i historyczne export attempts pozostają małe.
Notatki właściciela/korekty lub niezakończone zależności powodują hold.

Nie omijać hold przez zmianę daty, sfałszowanie readback albo usunięcie failed job.
`POST /system/retention/hold` może jawnie założyć/zdjąć owner hold; nie zwalnia
automatycznych warunków integralności. `last_block_reason` i counters służą
operacyjnej diagnozie. Proces nie usuwa plików Drive ani historycznych backupów.

## Recovery

Przy quota przerwać nową porcję; committed checkpoint pozostaje, nie replayować
ambiguous mutations ręcznie. Przy konflikcie Drive najpierw zabezpieczyć ręczne
edycje i rozwiązać tożsamość raportu. Zarchiwizowanego dnia nie wolno renderować
ponownie z usuniętych analiz; consumer zwraca ARCHIVED_REPORT_REQUIRES_RECOVERY
i nie nadpisuje pliku. Reprocessing archived Item wymaga jawnej operacji
odzyskania/refetch i ponownej zgody AI; automatic discovery/repair go nie wznawia.

Restore zawsze do pustej izolowanej bazy, canonical readback/FK/integrity, revoked
worker credentials, Drive REAUTH_REQUIRED/VERIFY_REQUIRED, deletion disabled.
Interrupted retention checkpoint pozostaje, ale wymaga świeżego pełnego remote
readback przed dalszym usuwaniem. COMPLETE mapping pozostaje czytelny w GUI.
Wznawiać aktywny backlog dopiero po auth i kontroli aktualnego raportu na Drive.

## Storage i backup budget

`deleted_bytes` oznacza logiczne bytes usuniętych pól/chunks, nie obietnicę
natychmiastowego zmniejszenia Cloudflare file_size. D1 nie udostępnia wszystkich
SQLite PRAGMA; nie uruchamiać VACUUM/optimize na produkcji jako rytuału cleanup.
Obserwować rzeczywisty high-water metadata i wzrost przy kolejnych cyklach.
Indeksy i FTS dodają write cost. Przyszły storage reclaim/compact należy osobno
kwalifikować na kopii, jeśli reuse wolnych stron nie zatrzyma wzrostu.

Cadence nadal due po 22h dla RPO <=24h; backup obejmuje working set podczas
retencji/holds oraz minimalny stan po purge. Nie odraczać integrity/recovery
przez budżet testowy. Nie tworzyć capture tylko dla odświeżenia daty PASS.

Przed pierwszą porcją zachowujemy <=8192 bytes operacyjnych faktów Gate C
(daty, IDs, authority, size, hashes), bez transcript/summary/prompt. Capture
jest atomowo powiązany z pierwszym checkpointem; porównanie przed/po stanowi
regresję. Zmierzone koszty, model 20 kanałów i ograniczenia są w
[raporcie retencji](../verification/retention/DRIVE_ONLY_RETENTION_VERIFICATION_2026-10-09.md).
