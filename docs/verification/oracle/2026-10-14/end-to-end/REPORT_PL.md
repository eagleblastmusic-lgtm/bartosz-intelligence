# Bartosz Intelligence — rzeczywisty end-to-end na Oracle

**Stan: READY_FOR_FINAL_APPROVAL. Produkcja: NOT_READY — końcowe wdrożenie wymaga zgody zgodnie z punktem 9 zlecenia.**

| Właściwość                  | Wynik                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------- |
| PERSISTENT_AUTH             | PASS                                                                                    |
| YOUTUBE_TRANSCRIPT          | PASS                                                                                    |
| SECOND_RUN_WITHOUT_REIMPORT | PASS                                                                                    |
| SECOND_CREATOR              | PASS                                                                                    |
| SESSION_EXPIRY_HANDLING     | PASS: rzeczywisty wcześniejszy REAUTH_REQUIRED oraz zintegrowana kontrolowana symulacja |
| PRODUCTION_24_7             | NOT_READY: wymaga zatwierdzonego uruchomienia produkcyjnego                             |

## Co zostało połączone

Dodano przyjęcie URL/ID przez `POST /api/v1/jobs/transcript` i odczyt przyjętej transkrypcji przez `GET /api/v1/items/:id/transcript`. Wykorzystano istniejące sesje aplikacji, CSRF, `JobStore`, dzierżawy, `LocalTranscriptWorker`, provider, selekcję języka, normalizator, akceptację i artefakty D1.

Istniejący executor łączy się przez lokalne gniazdo z ograniczonym brokerem procesu, który uruchamia działającą metodę `mweb + Subs PO + trwała sesja` we wcześniej zweryfikowanej granicy Oracle. Broker akceptuje tylko stały UID wykonawcy i operacje napisów, bez dowolnych poleceń. Nie powstał drugi executor, kolejka ani backend. Token powstaje dla bieżącego filmu; konto pozostaje poza repozytorium i logami.

Napisy ręczne zachowują pierwszeństwo; istniejąca polityka dopuszcza oryginalne automatyczne i oznacza ich typ. Poprawiono zgodność remisu wyboru ścieżki z core oraz odfiltrowano reklamowane przez yt-dlp tłumaczenia, których broker źródeł nie obsługuje. Klient `mweb`, parser i stockowy provider nie zostały zastąpione.

Zgłoszenia są idempotentne. Po normalnym ponownym uwierzytelnieniu właściciel może wznowić to samo zadanie `LOCAL_YTDLP_AUTH_REQUIRED` przez istniejący endpoint replay. Pozostałe blokady nie są znoszone. Zachowano istniejące ograniczone ponowienia transportu i odzyskiwanie dzierżaw.

## Rzeczywiste wyniki

Cały test pracował autonomicznie na Oracle po zamknięciu inicjującego SSH. Używał bieżącego Workera i lokalnego trwałego emulatora D1 na Oracle, rzeczywistego YouTube i istniejącej sesji. Nie był testem produkcyjnej D1 Cloudflare ani offline fixture źródła.

| Film / twórca               | Oryginalne napisy  | HTTP źródła   | Czas źródła | Zapis i odczyt              |
| --------------------------- | ------------------ | ------------- | ----------- | --------------------------- |
| `aircAruvnKk` / 3Blue1Brown | EN MANUAL, 286 cue | 200, 46 010 B | 17,499 s    | SUCCEEDED, pełny odczyt API |
| `uEztHu4NHrs` / TED         | EN MANUAL, 241 cue | 200, 33 217 B | 18,005 s    | SUCCEEDED, pełny odczyt API |

Między filmami zakończono i ponownie uruchomiono executor. **Importów sesji: 0.** Obie próby rozpoznały zachowane uwierzytelnienie i bezpiecznie zaktualizowały sesję.

Sprawdzono hashe i kolejność wszystkich fragmentów odczytanych przez API. Niezależny odczyt RAW z D1 i dekodowanie istniejącym parserem potwierdziły dla **każdego z 527 cue** tekst, język, typ, początek i koniec względem zapisanego tekstu oraz mapy. Zakres czasów: 4220–1105640 ms i 3833–790870 ms. Jest to zachowanie całej otrzymanej odpowiedzi, bez deklaracji niezależnego pokrycia całego filmu.

Kontrolowana symulacja `AUTH_REQUIRED` przeszła przez prawdziwy executor i API/D1: zadanie `BLOCKED`, `LOCAL_YTDLP_AUTH_REQUIRED`, jedna próba, zero żądań YouTube w tej symulacji. Nie zmieniano prawdziwej sesji. Regresja HTTP potwierdza replay bez duplikacji oraz odmowę dla innego właściciela i innych blokad.

Podczas integracji naprawiono błędy harnessu (katalog roboczy emulatora, izolowana tożsamość fixture, gotowość API bez UI, osobny limit emulatora) oraz rzeczywiste błędy mostu (umask zasłaniający publiczne pliki, reklamowane tłumaczenia). Jedno wcześniejsze pobranie 286 cue zostało odrzucone przez błąd projekcji listy; nie zaliczono go jako sukces end-to-end.

## Zabezpieczenia, testy i wdrożenie

Zadanie źródłowe: 768 MiB, CPU 50%, swap 0, concurrency 1. Sesja: katalog 0700, plik 0600, UID30000. Wszystkie potomki źródła zakończone; kopie cookies, stan tokena i nadmiarowe kopie transkrypcji brokera usunięte. Tymczasowe usługi testowe i gniazdo zakończone, syntetyczne poświadczenia testu usunięte. Chromium/Snap/sandbox pozostawiono bez zmian.

Celowane regresje i wymagane typecheck/lint przeszły: broker Python 9/9, wybór źródła 4/4, regresja umask 1/1, testy HTTP/jobs 6/6 oraz recovery; wcześniejsze testy transportu, runtime i kontraktów pozostają aktualne. `systemd-analyze verify` przygotowanych jednostek na Oracle: exit 0. Nie deklarujemy wykonania całej macierzy testów repozytorium.

Nie dodano płatnych usług lub zasobów. Obecna D1 ma około 27,8 MB; zweryfikowane limity darmowe i sposób wywołania opisano w [runbooku](../../../../operations/YOUTUBE_TRANSCRIPT_RUNBOOK_PL.md). Żywotność sesji po 24–72 godzinach pozostaje niezmierzona i nie blokowała implementacji. Hasła Google nie odczytywano ani nie przesyłano.

Produkcja ma potwierdzone 39/40 migracji. Brakuje wyłącznie `040_daily_tasks_workflow.sql`; niczego nie zastosowano produkcyjnie. Przygotowano jednostki, konfigurację i pakiet Oracle `e089c6874d6bb420b3123930f0d68418543672551c17053d12b0df9af725300b` (SHA-256). Nie wykonano commit/push/merge.

[EVIDENCE.json](EVIDENCE.json) zawiera identyfikatory zadań, hashe, wyniki odczytu, limity i rollback. [FINAL_APPROVAL_PL.md](FINAL_APPROVAL_PL.md) określa jeden wspólny zakres końcowego zatwierdzenia. Kolejny krok to zatwierdzone wdrożenie istniejącej D1/API i stałego wykonawcy, a następnie jeden odbiór przez produkcyjne API.
