# Poprawka po rzeczywistym canary — do osobnego zatwierdzenia

Stan: lokalny kandydat; **nie wdrożono tej poprawki**. Dotychczasowe GO pozostaje
ważne dla wdrożenia głównego i warunkowej aktywacji dokładnie 19 kanałów. Ten plan
dotyczy wyłącznie dwóch ujawnionych problemów; nie zmienia transportu danych,
harmonogramu, scope Drive ani wyboru mweb + persistent session + Subs PoT + yt-dlp.

## Przyczyna i konkretna delta

1. TED RSS zwraca 404. Oficjalne Data API potwierdza ten sam prawidłowy channel ID.
   `pollRss` odróżnia teraz wyłącznie 404/410 od quota, auth, błędów sieci i parsera.
   Przy 404/410 istniejący executor pobiera jedną stronę uploads: maksymalnie 50
   identyfikatorów i jeden metadata batch. Nie idzie za nextPageToken. Dotychczasowy
   commit stosuje okno aktywacji, deduplikację i małe porcje; nieznana data przy
   NEW_ONLY blokuje import. Lease/fence chroni receipts i commit. `change_log`
   zapisuje `RSS_UNAVAILABLE_404/410`, acquisition i rzeczywisty committed fallback.
   Żaden immutable job input, hash historyczny ani trigger nie jest przepisywany.
   Nie aktualizujemy `last_rss_at` po 404. Sprawdzony kanał można uznać za wykonany
   na podstawie uploads fallback; **sam RSS nadal ma FAIL/UNAVAILABLE**, a nie PASS.

2. Canary `9i1LVL3_xpU` ma poprawną sesję i dostępnego playera, ale yt-dlp nie
   zwrócił języka oryginału. Oficjalny `videos.snippet.defaultAudioLanguage=en`
   istnieje dla tego samego video ID. Worker sprawdza dokładny ID i format tagu,
   a potem przekazuje opcjonalny scalar istniejącym kontraktem transcript/input.
   Broker/list i dwa istniejące CLI przekazują pole do obecnego wyboru. Używamy
   go wyłącznie przy braku `info.language`; jednoznaczne `-orig` nadal ma pierwszeństwo,
   konflikty i translacje nadal blokują wybór. `defaultLanguage`, tytuł oraz
   założenie o języku kanału nigdy nie są authority. Receipt zapisuje pochodzenie
   `youtube.videos.snippet.defaultAudioLanguage`. Parser zachowuje dokładne cue/ms/tekst.

   Koszt: jeden dodatkowy official videos GET na transcript/input (1 quota unit);
   bez nowego rekordu payload w D1. Przy błędzie metadata API otrzymujemy techniczny
   błąd, bez zwiększenia liczby NO_CAPTIONS. Bez nowych zależności i migracji.

Dokładna delta względem **rzeczywiście wdrożonej** paczki znajduje się w
[REPAIR_DELTA.patch](REPAIR_DELTA.patch); jej hashe i kandydaci w
[REPAIR_CANDIDATE.json](REPAIR_CANDIDATE.json). Nie należy używać `git diff HEAD`
jako delty tego hotfixu, bo HEAD nadal poprzedza całą lokalną implementację.

## Dlaczego potrzebne jest wąskie rozszerzenie zgody

Poprzednie GO wprost zatwierdziło executor „bez zmian działającego silnika YouTube”
i utrzymało wymaganie pełnego canary. Ta poprawka zmienia przekazanie metadanych
w istniejącym brokerze/CLI/parser adapterze, a kryterium RSS wymaga jawnego
zaakceptowania prawidłowo udokumentowanego fallbacku. Jest to interpretacja granicy
zakresu właściciela (§2 i odpowiedź GO), **nie nowa bramka narzucona przez skill**.
Nie żądamy ponownego GO na migracje ani na uprzednio zatwierdzone drobne operacje.

## Kolejność po zatwierdzeniu tej delty

1. Potwierdzić brak zmiany kandydatów i aktualny ledger 43, AI/DELETE OFF oraz quota.
   Zachować działający Worker 600219c3 i Oracle 99585d9 jako kompatybilny rollback.
   Nie uruchamiać migracji ponownie; brak nowych migracji.
2. Wdrożyć nowy kompatybilny Worker/API; sprawdzić wersję, hash modułu, health,
   stare source v1 i flags. Nadal tylko jeden aktywny kanał.
3. Przenieść osobny immutable pakiet Oracle, sprawdzić manifest i identyczne
   zależności, unit files, wersje yt-dlp/mweb/POT. Bez install/update dependencies.
4. Gdy brak aktywnego FETCH i procesów pobierania, zatrzymać wyłącznie executor
   oraz broker na czas podmiany. Zachować ich publiczne pliki i public-install
   manifest do rollbacku. Nie odczytywać ani nie zmieniać cookies/profilu sesji.
5. Podmienić atomowo tylko zatwierdzone publiczne kopie:
   `tools/transcript-engine/login-diagnostic.py`, `login-diagnostic-oracle.py`
   oraz `apps/executor/python/transcript_ytdlp.py` pod istniejącym
   `/opt/bartosz-intelligence/browser-runtime/youtube-mweb`. Weryfikować stare
   i nowe SHA-256, root ownership, brak symlinków i tryb 0644; aktualizować tylko
   te pozycje istniejącego `public-install.json`. Broker czyta swój kod z immutable
   release; nie kopiować innych plików. Nie dotykać provider/server ani PoT trace.
6. Runtime check i lokalne offline ARM64 fixtures, następnie atomowy `current`
   i start brokera/executora w istniejącym systemd; COMPACT, concurrency=1.
   Sprawdzić procesy, heartbeat i restart count, bez zmiany uprawnień czy limitów.
7. Ponowić kontrolę dokładnie tego TED oraz jeden ograniczony canary tego samego,
   dotąd niezaakceptowanego filmu. Stary failed/BLOCKED job i attempts zostają.
   Użyć istniejącego owner JobStore i jawnego manual nonce; nie odblokowywać
   innych zaległych zadań i nie zmieniać zegara/standardowej polityki +10m/+1h/+10h.
8. Wymagać 3 compact artifacts, zgodności raw/cue/tekst/ms, trwałych intentów,
   stabilnych Drive IDs, prywatności, obu plików i dokładnego GET readback/hash.
   Ponownie odczytać metryki Free; nie utożsamiać zdrowych procesów z E2E PASS.
9. Wyłącznie po pełnym pozytywnym odbiorze: wcześniej zatwierdzone 19 NEW_ONLY,
   realny natychmiastowy MANUAL20 i po jednym rzeczywistym completed receipt
   każdego kanału. W raporcie rozróżnić RSS i uploads fallback. Normalny harmonogram
   15:00/23:00 Warsaw pozostaje. Zero historycznego backfillu i DELETE.

## Rollback

Nie cofać 041–043, nie nadpisywać D1 snapshotem i nie usuwać Drive plików.
Poprzedni obecnie wdrożony Worker 600219c3 umie czytać v1/v2; można go przywrócić
razem z Oracle 99585d9 oraz zachowanymi trzema publicznymi kopiami i manifestem.
Zatrzymać nowe pobrania przed podmianą; zachować wszystkie nowe accepted/receipts.
W razie problemu nie aktywować 19 kanałów. Gdyby potrzebny był LEGACY, użyć
kompatybilnego API/konfiguracji, bez destrukcyjnego rollbacku danych.

## Obserwacje i niepotwierdzone wyniki

Po nieudanym canary nie ma nowego accepted source ani Drive plików. D1 i historia
są zachowane, broker/sesja nie były modyfikowane. Sesję testową właściciela odwołano;
po zatwierdzeniu potrzebna będzie nowa krótkotrwała sesja istniejącą procedurą.
Pełny E2E, rzeczywisty MANUAL20 oraz soak 24–72 h nadal nie mają PASS.

Metryki do 01:39 UTC: 1 598 requests, 140 977 D1 rows read, 4 828 rows written,
467 Queue operations, backlog 0. Nowy Worker: 276 requests/0 runtime errors.
P99 CPU 44,421 ms to maksimum grupy bez rozróżnienia HTTP/Queue/Cron; nie jest
dowodem spełnienia HTTP 10 ms ani naruszenia tego limitu. 22 Queue delete failures
obejmują poprzednie i nowe wydanie; nie można z nich wywnioskować sukcesu zadań.
Wolne Drive 15 665 555 520 B. To zapas na mały canary, nie odbiór 100 filmów/dobę.
[Rzeczywiste metryki](STAGE_B_METRICS_REVIEW.json).
