# Source probe — izolowana diagnostyka publicznego ID YouTube

Narzędzie działa poza executorem. Nie importuje D1/RPC, nie odczytuje konfiguracji aplikacji i nie zapisuje artefaktów do archiwum produkcyjnego. Wynik JSON na stdout zawiera wyłącznie wybrane pola diagnostyczne; nie zawiera tekstu odpowiedzi sieciowej, cookies, tokenów, podpisanych URL ani nagłówków. `caption_accepted` i `INDEPENDENTLY_CONFIRMED_COMPLETE` pozostają false: to diagnostyka, nie kwalifikator źródła.

Pliki: `source-probe.ts` — logika; `run-source-probe.ts` — CLI; `source-probe-check.ts` — kontrola przenośna; `source-probe-formats.py` — istniejący parser Python; `build-source-probe.mjs` — bundle; `run-source-probe-oracle.py` — izolowany odbiór; `verify-source-probe-evidence.py` — hashe i porównanie receipts. [Raport bieżącego odbioru](../../docs/verification/oracle/2026-10-13/public-source-breakthrough/REPORT_PL.md).

## Windows — istniejące zależności

Uruchamiać z `C:\Projekty\Aplikacje\Bartosz Intelligence`. Nie trzeba instalować pakietów ani używać pnpm przed testami.

```powershell
& .tools/node-v24.21.0-win-x64/node.exe tools/probes/build-source-probe.mjs .local/source-probe-20261013
& .tools/node-v24.21.0-win-x64/node.exe .local/source-probe-20261013/source-probe.mjs offline tests/fixtures/source-probe/offline.json
& .tools/node-v24.21.0-win-x64/node.exe .local/source-probe-20261013/source-probe-check.mjs
& .local/oracle-python/Scripts/python.exe -B tools/probes/source-probe-formats.py
```

Alternatywa bez bundla: `node --import tsx tools/probes/run-source-probe.ts offline tests/fixtures/source-probe/offline.json`, z istniejącym tsx. Build korzysta z esbuild zależności tsx i zapisuje manifest input/output SHA-256. Wyklucza import executora, workerów lub DB; nie jest paczką wydania.

Testy: `node node_modules/vitest/vitest.mjs run --configLoader runner --no-cache --project unit tests/unit/source-probe.spec.ts`. W sandboxie Windows może wystąpić `spawn EPERM` narzędzia testowego; nie klasyfikować tego jako odmowy YouTube. Poprawny odbiór wykonano poza tym ograniczeniem.

## Tryby i wejście

CLI przyjmuje dokładnie: `source-probe.mjs TRYB MANIFEST_JSON`. Manifest ma tablicę `cases`, najwyżej 12 wpisów offline, dokładnie jeden live. Każdy wpis ma `video` — ID lub obsługiwany HTTPS URL YouTube. Input normalizuje się do samego ID; dowolne hosty, credentials, nietypowy port i wielokrotne `v` są odrzucane.

- `offline`: `format`, `path` oraz opcjonalne `reference: {format, path}`. Ścieżki są względem manifestu. Formaty: `recorded-en`, `recorded-dom`, `json3`, `srt`, `panel-segments`, `supadata-native`. JSON3/SRT używają parserów core; dalsza kontrola używa `normalizeTranscript`. Golden VTT/SRV3 sprawdza osobny skrypt istniejącym adapterem Python.
- `oembed`: jeden GET do publicznego endpointu oEmbed, wynik metadanych bez napisów. [Specyfikacja](https://oembed.com/#section5.1). Manifest `oembed.json` dotyczy wyłącznie reprezentacji embed, nie praw do transkrypcji. Bieżąca próba już się odbyła na obu hostach; nie powtarzać bez nowej hipotezy.
- `supadata-native`: jeden GET `mode=native&text=false`, bez tłumaczenia, zmiany języka, polling lub retry. Wymaga rzeczywiście ustalonego `access.confirmed`, opisów `method` i `content`, `free_plan_confirmed=true` oraz **osobnego diagnostycznego** klucza w `BARTOSZ_PROBE_SUPADATA_KEY`. Nie korzysta z kluczy aplikacji. Brak dostępu → `NO_AUTHORIZED_ACCESS`; po potwierdzeniu dostępu brak klucza/planu → `BLOCKED_INPUT`, zero żądań. [API](https://docs.supadata.ai/get-transcript), [warunki usługi](https://supadata.ai/legal/terms). Deklaracja w JSON nie jest automatycznym potwierdzeniem praw.

`native-blocked.json` celowo nie deklaruje uprawnień. Można uruchomić go offline z punktu widzenia sieci: `source-probe.mjs supadata-native tests/fixtures/source-probe/native-blocked.json`. Nie zmieniać tego fixture na pozorną zgodę. Rzeczywisty manifest live wymaga odpowiednich danych. Klucza nie wpisywać w argumenty komendy, plik evidence ani czat.

Timeout: 15 s obejmujący transport/body; limit odpowiedzi 4 MiB. Redirect jest manualny, credentials omit. Wszystkie kategorie błędów są stałe; wyjątki CLI zwracają tylko `SOURCE_PROBE_FAILED`, exit 2. HTTP 403 oznacza odmowę, bez przypisywania przyczyny IP. `NO_CAPTIONS` jest uznawane dla udokumentowanego kodu `206/transcript-unavailable`, nie dla dowolnego 206 lub pustego 200. HTTP 202 jest niepełnym wynikiem; narzędzie nie rozpoczyna polling.

`STRUCTURALLY_VALID` sprawdza czasy, indeksy, kolejność i tekst. `MATCHES_AVAILABLE_REFERENCE` porównuje wszystkie cue dokładnie. Źródło może być poprawnym prefiksem; dopiero referencja pozwala wykazać brak końca. `INDEPENDENTLY_CONFIRMED_COMPLETE=false` pozostaje nawet przy identycznych eksportach tego samego DOM. Brak `end_ms` zostaje null. Pauzy raportuje się jako nieustalone przerwy, nie utracone wypowiedzi. `native` usługi nie jest dowodem MANUAL, oryginalnego języka lub pełności; flags pozostają UNKNOWN.

## Oracle — wyłącznie diagnostyka tymczasowa

```powershell
python -B tools/probes/run-source-probe-oracle.py --key C:/Users/Skarabeusz/.ssh/bartosz-intelligence.key --output .local/source-probe-20261013/oracle-offline.json
```

Runner wysyła bundle, jawne fixture i zapisane diagnostyczne referencje do nowego `/tmp/bartosz-source-probe-*`, używa istniejących Node/Python, usuwa katalog po zakończeniu. Nie dotyka `/opt/.../releases`, nie instaluje bibliotek, nie startuje usługi, nie przekazuje środowiska produkcji ani klucza API. Nie jest drugim executorem. Opcjonalne `--live-oembed` dodaje dokładnie jeden odczyt metadanych; nie używać go do ponowienia wykonanej próby.

Odbiór rzeczywisty: Ubuntu ARM64, Node 24.21.0, Python 3.12.3, siedem identycznych rekordów offline względem Windows. Sześć kontroli przenośnych w każdym środowisku obejmuje powtarzalność, prefix, tożsamość filmu referencji, odmowę bez retry/log leak, anulowanie i brak żądania bez dostępu. Nie przeprowadzono kwalifikacji live napisów. [Dowody](../../docs/verification/oracle/2026-10-13/public-source-breakthrough/oracle-final-offline.json).

Weryfikacja zapisanych dowodów, bez sieci: `python -B tools/probes/verify-source-probe-evidence.py`. Nowe narzędzia nie zostały dopisane do zatwierdzonego archiwum release; bundle diagnostyczny pozostaje lokalnym artefaktem.
