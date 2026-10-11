# Wynik jednej zatwierdzonej próby radiowej — 2026-10-11

**Gemini zwrócił HTTP 503 / UNAVAILABLE. Nowe streszczenie nie powstało.**
Wykonano dokładnie jeden POST QUALITY_TEST dla `rUhllpnYWR8` po wymaganym
preflighcie. `raw_output=null`; pełny wygenerowany akapit nie istnieje.
Nie wykonano ręcznej redakcji, kolejnego POST, retry, fallbacku, dodatkowej
syntezy ani publikacji na Drive. Nie ma wyniku do odbioru semantycznego.

## Oryginalna odpowiedź providera

Pełne body HTTP: 198 bytes, SHA-256
`01f5c7d4e4d8ec06c8098777e731b3d552ba518feb02b681f6c569edcd9c6f6d`.
Prywatny plik `.local/radio-quality-test-2026-10-11-private/provider-http-body.bin`
został zapisany bez zmian i odczytany ponownie z identycznym SHA.
Poniżej wierna treść JSON; zachowany plik jest źródłem dokładnych bytes:

```json
{
  "error": {
    "code": 503,
    "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
    "status": "UNAVAILABLE"
  }
}
```

Jest to odmowa dostępności zgłoszona przez provider. Nie jest to wynik walidatora
treści ani dowód jakości modelu. Nie ma podstaw do semantycznego PASS/FAIL.
Provider nie zwrócił liczników tokenów; `input_tokens`, `output_tokens` i
`total_tokens` zachowano jako `null`, a rezerwację jako `UNKNOWN`.

## Preflight i zgodność wykonania

- Właściciel jawnie zatwierdził dokładnie jedną próbę zgodną z
  [propozycją v2](radio-quality-test-proposal-2026-10-11.json).
  [Zapis zgody](radio-quality-test-authorization-2026-10-11.json) ma osobną
  tożsamość; poprzednich zgód nie wykorzystano ponownie.
- Sześć wykonywanych plików porównano z HEAD
  `62212e2636426196e013c99d4e8b337e138496b1`. Aktualny lokalny Core importuje
  `radio-narrative:2` i cache prefix
  `analysis-validation-quality3-radio-narrative:2-`. Starszy Worker nie był
  użyty do finalnej kwalifikacji treści; treści nie otrzymano.
- Rzeczywisty Published Registry: `ECONOMY_ANALYSIS_V1 v2`, generation1,
  base SHA `636174228b5b4588c36bb42e7562a483627cb666690620a8b8813cf435b20c80`;
  `analysis-quality:3`, SHA
  `1cf3fd9471e1859efbe1d67f8125cbfba69da8b3def441ae7b4fea9c7d1bd1d5`.
- Pełny compiled prompt SHA
  `e42c1aa8dba97b0216f3cb024569a77d3d6d636d1cc3d5c6662009fc246435bf`
  odpowiada propozycji. Zachowano1071 cues oraz source/manifest/schema/quality
  scope. Bez ponownego pobierania transkryptu z YouTube i bez skracania źródła.
- Po reload AI Studio potwierdzono Free dla wybranego projektu. Jeden
  zatwierdzony model GET o20:06:39.688UTC potwierdził `generateContent`,
  context1048576/output65536. Świeży profil10 ma billing OFF i brak quality
  approvals. Żądanie zachowało output4096/input estimate83800; estimate jest
  konserwatywną granicą UTF-8 bytes, nie rzeczywistą liczbą użytych tokenów.
- Po reload Cloud quota o20:10:30.186UTC: **RPM0/5, RPD2/20,
  INPUT_TPM0/250000**. W momencie dispatch o20:10:55.370UTC wiek odczytu
  wynosił25184ms. To bieżące liczniki Cloud; peak usage AI Studio nie zastąpiło
  bieżących liczników. Odczyt UI pozostaje obserwacją providera, nie gwarancją
  natychmiastowej aktualizacji telemetrii.
- Trwała rezerwacja i submit poprzedziły HTTP. Exclusive consumed marker
  odmawia powtórzenia zgody. Transport przyjmuje tylko jeden POST na dokładny
  endpoint i dokładny payload SHA. Zgoda jest zużyta.

## Trwałość i odbiory

Job `81d1908b-1ef1-4394-8e8c-66756ca53fab`, run
`analysis_ea046dfc08dd178e0557def07b2a7897a902e69a8dd02cde0a73a2d4f1be187b`.
Odczyt kontrolny po indeksach potwierdził jedną próbę, `RETRY_WAIT/TRANSIENT`,
zwolniony lease, run `CANDIDATE`, bez acceptance. Verified immutable artifact
`d78c511a-2d45-451f-b70a-7a2ba3ce8568` zachowuje metadata błędu oraz
`raw_output_present=false`; nie jest pustym, poprawnym streszczeniem.

Automatyczny `LocalAnalysisWorker.cycle()` wybiera tylko `PRODUCTION`.
`QUALITY_TEST` wymaga jawnego job ID; nie uruchomiono executor loop ani
ponowienia. Zachowane zadanie może zostać bezpiecznie wznowione dopiero w
zakresie nowej zgody. Stan `RETRY_WAIT` nie stanowi zgody na kolejny POST.

Sześć SHA wcześniejszego provider output, canonical, transkryptu i editorial4
pozostało identycznych. Istniejąca publikacja Daily jest bez zmian. Treści
archiwalne nie zastępują brakującego wyniku obecnego promptu.

| Kontrola                                             | Wynik                                      |
| ---------------------------------------------------- | ------------------------------------------ |
| Zgodność kodu/cache, promptu, źródła i preflightu    | PASS techniczny                            |
| Liczba generacji / retry / fallback / syntezy        | 1 /0 /0 /0                                 |
| Trwałe zachowanie błędu i bezpiecznego stanu zadania | PASS techniczny                            |
| Walidacja techniczna treści i renderera              | NOT_RUN_NO_PROVIDER_OUTPUT                 |
| Pełne wygenerowane streszczenie i odbiór semantyczny | NOT_RUN_NO_PROVIDER_OUTPUT                 |
| Gęstość informacji, jakość i kwalifikacja modelu     | NOT_ASSERTED / NOT_QUALIFIED               |
| P0 / CP-3.13 / PRODUCTION ACCEPTED                   | NOT_QUALIFIED / AWAITING_HUMAN_REVIEW / NO |

Koszt bezpośredniego admin bridge: prepare48 reads/21 writes,
execute80 reads/22 writes, weryfikacja9 reads/0 writes; razem **137 rows_read,
43 rows_written**. To zmierzone metadata D1 dla60 admin REST requests
(ostatni to sześć selektywnych statementów w jednym batchu). Dodatkowe Worker
RPC rows nie są zmierzone; nie przedstawiamy tej sumy jako pełnego kosztu próby.

## Dalszy stan

Kolejna pojedyncza próba po ustąpieniu przeciążenia wymaga nowej zgody i świeżego
Free/quota/profile/Registry. Nie zmieniono modelu ani providera. Nie ma podstaw
do kolejnego POST w ramach obecnej zgody ani do zaliczenia P0 lub CP-3.13.
`paid_services_enabled=false`; retencja nadal observation/dry-run,
`deletion_enabled=0`, `approval_reference=NULL`.

Dowody:
[preflight](radio-quality-test-preflight-2026-10-11.json),
[immutable live receipt](radio-quality-test-live-2026-10-11.json),
[odczyt kontrolny, usage i piny](radio-quality-test-verification-2026-10-11.json),
[release readiness](../../../RELEASE_READINESS_REPORT.md).
W polu `owner_semantic_review` ogólny live harness pozostawił `AWAITING_OWNER`;
brak treści rozstrzyga wynik tej kontroli jako **NOT_RUN_NO_PROVIDER_OUTPUT**,
co jawnie zapisano w oddzielnym verification receipt. Live receipt zachowano.
