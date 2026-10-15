> Stan 15.10.2026 11:15 UTC: zakres zatwierdzony i wdrożony. Integralność PASS; poprawy CPU nie wykazano. Aktualny stan: §18 raportu produkcyjnego. Poniżej zachowany plan sprzed zgody.

# Wąska optymalizacja CPU — konkretny zakres do zatwierdzenia

Obecna produkcja74232ebc pozostaje wdrożona i przeszła pełny odbiór danych TED.
Dwa pliki Drive,226cue,tekst/ms/hash i bezpieczne uzgodnienie wersji: PASS.
19dodatkowychkanałów nadalnieaktywne,MANUAL20nieuruchomiony.

Zmiana: wyłącznie packages/core/src/transcript/payload-archive.ts, dwa wywołania
SHA256 pakietu/chunków z JavaScript @noble na crypto.subtle.digest SHA-256.
Zachowane wszystkie hashe, checks, CAS, prawa, chunkboundaries i znaczniki czasu.
Nie zmieniamy checkpointowego hashowania, schedulera, Oracle, schema ani sesji.

Dowód lokalny:16/16Workers/D1 (w tym serie10/30/100 i10800cue),core/APItypecheck,
lint/format i produkcyjny dry-runPASS. Kandydat i dokładneSHA w NATIVE_HASH_CANDIDATE.json.
Nie jest to dowód poprawyCPU w produkcji; Node mikrobenchmark wskazuje mały zysk,
który nie musi wyjaśniać pełnegoCPU33–34ms. Nie obniżamy kryteriumFree.

Po jednoznacznymGO: sprawdzić aktualne wersje, świeżość backupu/rollbacku i hashe;
wdrożyć tylko Worker; potwierdzić dokładne bajty/bindingsAI iDELETEOFF.
Następnie jeden read-only dry-run tego samego canary i nowe rzeczywiste próbkiCPU
HTTP oraz naturalnegoCron, bez nowych pobrańYouTube/uploadówDrive.
Dopiero pełnyPASS danych i bezpiecznegoFree otwiera wcześniejsze GO na19NEW_ONLY
oraz natychmiastowyMANUAL20. Jeżeli CPU nadal wymaga zmiany kodu, przedstawić
konkretną przyczynę i najmniejszą poprawkę; nie deklarowaćFreePASSzHTTP200.

Rollback: zgodnyWorker74232ebc, zachować wszystkie v1/v2accepted i nowe receipts.
Bez DBrollback,DELETE,retencji,płatnych zasobów,nowych zależności,commit/push.

System automatycznej kontroli odrzucił poprzednią próbę deployu jako wyjście poza
wąski zakres dwóch wcześniejszych poprawek. Deploy NIE został wykonany.
