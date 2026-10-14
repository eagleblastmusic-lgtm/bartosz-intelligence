# Bartosz Intelligence — zakończone wdrożenie produkcyjne

14 października 2026. **PRODUCTION_READY**: działa przepływ URL/ID → produkcyjne API → stały executor Oracle ARM64 → rzeczywiste napisy YouTube → D1 → odczyt API. Usługi pozostają uruchomione po zakończeniu testów.

| Właściwość            | Wynik                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| PRODUCTION_DEPLOYMENT | PASS — nowy Worker aktywny w 100%, Oracle uruchomiony                                                 |
| D1_MIGRATION          | PASS — zabezpieczony i odtworzony backup; 040 wdrożona, 40/40 zgodnych migracji, integralność/FK PASS |
| EXECUTOR_24_7         | ACTIVE — executor i broker active/enabled, concurrency 1, uruchamianie przez systemd                  |
| END_TO_END_LIVE       | PASS — dwa różne kanały, produkcyjne API i D1, oba zadania wykonał Oracle                             |
| SESSION_STATUS        | AUTHENTICATED / REUSED — oba pobrania bez importu, świeży Subs PO dla każdego zadania                 |
| COST_STATUS           | NO_NEW_PAID_RESOURCES — istniejące Oracle/Cloudflare, bez zmiany planów i rozmiaru VM                 |

## Faktyczny odbiór produkcji

| Film / twórca               | Napisy                   | Źródło                       | Zadanie / odczyt                                                   |
| --------------------------- | ------------------------ | ---------------------------- | ------------------------------------------------------------------ |
| `uEztHu4NHrs` / TED         | EN MANUAL, 241 segmentów | HTTP 200, 33 217 B, 17,087 s | SUCCEEDED, tekst i mapa odczytane przez API                        |
| `IHZwWFHWa-w` / 3Blue1Brown | EN MANUAL, 306 segmentów | HTTP 200, 49 690 B           | SUCCEEDED po restarcie executora, tekst i mapa odczytane przez API |

Testy przyjmowały pełne URL przez normalną produkcyjną trasę właściciela. Sterownik testu działał na Oracle po zamknięciu inicjującego SSH; żaden proces Windows nie sterował przyjęciem, pobraniem, zapisem ani odczytem tych zadań. D1 potwierdziła dla obu prób `executor_id=oracle-frankfurt-transcript-1`, fence 1, bez błędów i tylko jedną aktywną tożsamość `FETCH_TRANSCRIPT`. Poprzedniego wykonawcę Windows wyłączono wyłącznie dla tego scope.

Kontrola wszystkich **547 segmentów** porównała tekst i początek/koniec z oryginalnymi odpowiedziami RAW zapisanymi w D1. Sprawdzono SHA-256, rozmiary, kolejność wszystkich fragmentów, język i pochodzenie. Zakresy otrzymanych czasów: TED 3833–790870 ms, 3Blue1Brown 4180–1212780 ms. Jest to zachowanie całej otrzymanej odpowiedzi; nie deklarujemy niezależnego pokrycia całego filmu. Szczegóły i identyfikatory zawierają [FINAL_EVIDENCE.json](FINAL_EVIDENCE.json) i [d1-live-verification.json](d1-live-verification.json).

## Zmiany i naprawy

Połączono istniejące API/jobs, dzierżawy i akceptację z istniejącym `LocalTranscriptWorker`, lokalnym brokerem, działającym `mweb`, stockowym bgutil 2.0.2 oraz artefaktami D1. Zgłoszenie URL/ID jest idempotentne. Ręczne napisy mają pierwszeństwo; dostępne oryginalne automatyczne mają typ `GENERATED`. Sesja i tokeny nie trafiają do D1. Nie dodano drugiego executora, bazy ani usługi chmurowej.

W trakcie odbioru wykryto pojedynczy HTTP 503 przy zapisie fragmentu. Dodano maksymalnie trzy idempotentne próby zapisu dla wskazanych błędów przejściowych, z zachowaniem osobnej obsługi autoryzacji, dzierżawy i limitów D1. Regresja 9/9, regresja pętli 6/6, wymagane typecheck/lint/format PASS. Po wdrożeniu poprawki rzeczywisty test 3Blue1Brown zakończył się sukcesem; przyczyny historycznej odpowiedzi 503 nie ustalono. Wcześniejszy kontrolowany test `AUTH_REQUIRED` zakończył zadanie jako `BLOCKED / LOCAL_YTDLP_AUTH_REQUIRED`; nie zmieniał prawdziwej sesji. Odpowiedni replay wznawia ten sam rekord po normalnym ponownym uwierzytelnieniu.

Nie zaliczono do odbioru Oracle wcześniejszego `aircAruvnKk` wykonanego przez stary proces Windows ani omyłkowego filmu `zfR_Jj4grZE`. Ten drugi test zakończono jako `BLOCKED / INVALID_INPUT`, zachowując dane. Końcowe dowody dotyczą wyłącznie dwóch właściwych filmów powyżej. Lokalny weryfikator D1 wymagał jawnego UTF-8 dla Pythona na Windows; po poprawce potwierdził wszystkie cue, bez nowych żądań YouTube.

## Utrzymanie i ograniczenia

Worker: `39edd639-eba3-40bb-93c7-022f1aec31d6`. Wydanie executora: `7a6339c1dcafdd1d825c35b8daa609795ff1cb85ea8ca6d614844800f1a41505`, 716 plików, wszystkie hashe zgodne. Broker pozostał działającym procesem z poprzedniego niezmiennego wydania `e089c687…`; jego pliki i jednostki są identyczne z nowym wydaniem. Restart executora 63618 → 63718 potwierdzony przed drugim testem. Rozruch całej VM nie był wymuszany.

Źródło: 768 MiB, CPU 50%, swap 0, concurrency 1. Sesja: katalog 0700, plik 0600, UID30000; zachowana i zaktualizowana po obu pobraniach. Kopie robocze sesji, stan tokenów, tymczasowe sterowniki oraz sesję aplikacji testowej usunięto/unieważniono. Nie pozostały procesy potomne źródła. Hasła Google i `Login.txt` nie odczytywano. Brak potrzeby każdorazowego eksportu lub uruchomionego Windows.

Aktywne usługi potwierdzają uruchomienie do pracy 24/7; nie oznaczają pomiaru 24–72 godzin ani wiecznej ważności sesji YouTube. Jej unieważnienie wymaga normalnego ponownego uwierzytelnienia i jest czytelnie sygnalizowane. Nie uruchomiono dodatkowego ciągłego monitora. Nie dodano płatnych zasobów; limity darmowe i ich ograniczenia opisuje [część Cloudflare](REPORT_PL.md). Rachunku całego konta nie mierzono.

Wywołanie: [instrukcja API](../../../../operations/YOUTUBE_TRANSCRIPT_API_PL.md) oraz [runbook](../../../../operations/YOUTUBE_TRANSCRIPT_RUNBOOK_PL.md). Origin: `https://bartosz-intelligence.eagleblastmusic.workers.dev`. Właściciel korzysta ze zwykłej sesji aplikacji i CSRF:

```text
POST /api/v1/jobs/transcript              {"locator":"URL lub ID YouTube"}
GET  /api/v1/jobs/JOB_ID
GET  /api/v1/items/ITEM_ID/transcript?kind=source&start=0
GET  /api/v1/items/ITEM_ID/transcript?kind=segments&start=0
```

Odczyt jest stronicowany (`next_index`) i zawiera porcje base64url oraz deskryptor z językiem/typem/pochodzeniem. Rollback aplikacji: poprzedni Worker `224ba7ff-a4ab-47ff-8cc1-70aadb2d91b1`, zatrzymanie nowych usług i przywrócenie poprzedniego wydania; zachować D1 i addytywną migrację 040. Backup i próba odtworzenia pozostają zabezpieczone lokalnie. Nie wykonano commit, push ani merge. Nie pozostaje blokada końcowego uruchomienia.
