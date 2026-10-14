# Original Transcript Engine — uruchamianie

Samodzielny prototyp R&D. Wejście to publiczny ID/HTTPS URL i plik konfiguracji
źródła. Nie importuje executora, RPC ani D1. Nie instalować go jako usługi.
Stały przypadek diagnostyczny: `aircAruvnKk` (3Blue1Brown).

`accepted=true` wymaga rzeczywistej akwizycji, potwierdzonej tożsamości
oryginalnej ścieżki, pełnych czasów oraz dokładnej zgodności z pełną niezależną
referencją. Odtworzenie offline nigdy nie uzyskuje accepted. Exit 0 oznacza poprawne
zapisanie wyniku eksperymentu; rozstrzygnięcie transkrypcji jest w polach
`status/category/accepted`. W przypadku zabicia procesu nadrzędny jest receipt
supervisora, nie ewentualne pliki niedokończonego procesu.

## Windows — istniejące środowisko repo

W katalogu `C:\Projekty\Aplikacje\Bartosz Intelligence`, bez instalowania pakietów:

```powershell
& .tools/node-v24.21.0-win-x64/node.exe tools/transcript-engine/build.mjs
& C:/Python314/python.exe -B tools/transcript-engine/prepare-replay.py --output .local/ote-demo-config
& C:/Python314/python.exe -B tools/transcript-engine/supervise.py --output .local/ote-demo-resources.json --timeout 30 -- .tools/node-v24.21.0-win-x64/node.exe --max-old-space-size=192 .local/transcript-engine/transcript-engine.mjs replay aircAruvnKk .local/ote-demo-config/aircAruvnKk.source.json .local/ote-demo-en
& C:/Python314/python.exe -B tools/transcript-engine/supervise.py --output .local/ote-demo-pl-resources.json --timeout 30 -- .tools/node-v24.21.0-win-x64/node.exe --max-old-space-size=192 .local/transcript-engine/transcript-engine.mjs replay aircAruvnKk .local/ote-demo-config/aircAruvnKk.pl-dom.source.json .local/ote-demo-pl
```

Katalog wynikowy CLI musi być nowy; ponowne użycie ścieżki jest błędem. Przy
powtarzaniu eksperymentu zmienić nazwę katalogu, zachowując poprzednie dowody.
Wyniki EN/PL to odpowiednio UNVERIFIED/ORIGINAL_UNCONFIRMED i PARTIAL/PARTIAL_RESPONSE.
PL ma `end_ms=null`, zgodnie z rzeczywistym materiałem.

```powershell
& C:/Python314/python.exe -B tools/transcript-engine/supervise.py --output .local/ote-check-resources.json --timeout 30 -- .tools/node-v24.21.0-win-x64/node.exe --max-old-space-size=192 .local/transcript-engine/engine-check.mjs . .local/ote-check
& C:/Python314/python.exe -B tools/transcript-engine/supervise.py --output .local/ote-browser-resources.json --timeout 90 -- .tools/node-v24.21.0-win-x64/node.exe --max-old-space-size=192 .local/transcript-engine/browser-check.mjs . .local/playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe .local/ote-browser
& C:/Python314/python.exe -B tools/transcript-engine/resource-check.py --node .tools/node-v24.21.0-win-x64/node.exe --output .local/ote-resource-controls
```

24 testy adaptera, 12 testów prawdziwej przeglądarki na loopback oraz 3 rzeczywiste
testy supervisora. Koperty odpowiedzi panelu i metadane playera w teście przeglądarki
są zrekonstruowane; teksty i czasy pochodzą z istniejących rzeczywistych zapisów.
Te testy nie łączą się z YouTube. `--first` ogranicza browser-check do jednego
przypadku; `--no-sandbox` jest dopuszczone wyłącznie dla tego loopback harnessu.

## Oracle — historyczny odbiór przenośnego Shell (2026-10-13)

Aktualny wariant to zainstalowany Chromium Snap 155.0.8059.39, wspólna cgroup
768 MiB i istniejący CDP. Wynik wdrożenia oraz próby live:
[raport](../../docs/verification/oracle/2026-10-14/chromium-deployment-live/REPORT_PL.md).
Poniższe komendy odtwarzają wcześniejsze badanie Shell, nie aktualny runtime.

```powershell
& C:/Python314/python.exe -B tools/transcript-engine/oracle.py --key C:/Users/Skarabeusz/.ssh/bartosz-intelligence.key --output .local/ote-oracle-repro --with-browser --browser-sha256 d433c45172c7836e38124fe545f767b02210bfb43a6262f08a297473a8e91c99 --detached
```

SSH używa istniejącego klucza i sprawdzonego host key. Runner przesyła wyłącznie
bundle, jawne materiały diagnostyczne i stdlib supervisor do `/tmp`. Pobiera
przenośny Chromium Headless Shell **153.0.8010.12 ARM64**, sprawdza SHA-256,
uruchamia testy, odbiera JSON i usuwa środowisko. Nie wykonuje apt/pip/pnpm,
instalacji usług, migracji, D1 ani uruchomienia executora. `--detached` zamyka
sesję startującą przed wykonaniem eksperymentu; druga sesja jedynie odbiera wynik.
Nie jest to instalacja ani test produkcyjny 24 h.

Bez `--with-browser` wykonuje historyczną kontrolę adaptera i testy limitów.
`--browser-flavor full` służy do odtworzenia udokumentowanej kalibracji pełnego
Chrome, który przekroczył budżet. Nie jest wariantem odebranym w limicie 768 MiB.

Samodzielny proces Linux, po rozpakowaniu paczki diagnostycznej w nowym katalogu:

```bash
/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node --max-old-space-size=192 tools/transcript-engine/engine-check.mjs . evidence-portable
/usr/bin/python3 -B tools/transcript-engine/supervise.py --output browser-resources.json --timeout 90 -- /opt/bartosz-intelligence/runtime/node-24.21.0/bin/node --max-old-space-size=192 tools/transcript-engine/browser-check.mjs . /absolute/path/chrome-headless-shell evidence-browser --no-sandbox
```

Druga komenda dotyczy tylko lokalnego, odizolowanego od zewnętrznych hostów replay.
W tamtym teście przenośny Chromium odmówił utworzenia namespace;
nie zmieniano ustawień kernela/AppArmor. Live w tym prototypie wymaga działającego
sandboxa i odrzuca `sandbox=false` przed uruchomieniem przeglądarki.

## Konfiguracja źródła i live

Tryby CLI: dokładnie `replay VIDEO CONFIG_JSON NEW_OUTPUT_DIRECTORY` lub
`native VIDEO CONFIG_JSON NEW_OUTPUT_DIRECTORY` lub
`publisher VIDEO CONFIG_JSON NEW_OUTPUT_DIRECTORY`. ID/URL normalizuje istniejący
source-probe. Nieobsługiwane hosty, credentials i wielokrotne `v` są odrzucane.

Replay config: `schema=ote-source:1`, `format=recorded-en|recorded-dom|json3|panel`,
`path`, `snapshot_path`; opcjonalnie `reference_path` i jego obowiązkowy
`reference_sha256`, oraz `expected_track_id`. Ścieżki są względem configu.
`prepare-replay.py` przygotowuje cztery rzeczywiste przykłady.

Minimalna konfiguracja diagnostycznego native dla publicznego filmu:

```json
{
  "schema": "ote-source:1",
  "diagnostic_video_id": "aircAruvnKk",
  "browser_executable": "/opt/bartosz-intelligence/browser-runtime/snap-entry.py",
  "sandbox": true
}
```

Publiczny ID/URL nie wymaga osobnego dokumentu ani pól `access.confirmed`,
`access.method`, `access.content`. Starsze pola `access` nie stanowią bramki
uruchomienia. Historyczne wyniki BLOCKED_AUTHORIZATION opisują poprzednią wersję,
a fixture `native-blocked.json` zachowano jako materiał historyczny. Nie jest to
deklaracja uprawnień do dowolnej redystrybucji treści. Silnik wymaga supervisora
i sandboxa oraz zatrzymuje faktyczną odmowę, login, consent i limit źródła.
Pełna niezależna referencja nie jest wymagana do autoryzowanej diagnostyki
dostępności; jest wymagana do accepted. Jej schema `ote-reference:1` jest w
`engine.ts`: film, język, MANUAL/GENERATED, vss_id, pochodzenie i hash źródła,
wszystkie segmenty oraz jawne claims complete/independent/original. Claims muszą
być poparte dowodem; dwa eksporty tego samego DOM nie zapewniają niezależności.

Native wykonuje jedno kliknięcie „Show transcript” / „Pokaż transkrypcję”,
obserwuje jedną odpowiedź get_transcript oraz porównuje ją z istniejącym czytnikiem
DOM 0.4.2. Nie rekonstruuje params/tokenów, nie wykonuje własnego Innertube POST,
nie zmienia podpisanych URL. Standardowy tryb jest anonimowy; jednorazowa
diagnostyka `aircAruvnKk` może otrzymać jawnie udostępniony eksport wyłącznie
YouTube przez ograniczony `session_cookie_path`, usuwany wraz ze świeżym profilem.
Zatrzymuje
odmowę, login, consent i limit; nie przełącza klientów po odmowie.

Diagnostyka z 2026-10-14 zapisuje również `reason` i `subreason` odtwarzacza.
Identyczny anonimowy odczyt strony z Windows zwrócił `OK`, a z Oracle
`LOGIN_REQUIRED` z komunikatem „Sign in to confirm you’re not a bot”.
Osobne ograniczone próby mweb, web_embedded, Android i android_vr potwierdziły
odmowę Oracle; panel otrzymany ze strony zwrócił HTTP400.
[Dowody i stan dalszego testu](../../docs/verification/oracle/2026-10-14/login-diagnosis/REPORT_PL.md).
Nie jest to dowód konieczności konta dla tego filmu ani udany odbiór napisów.
`login-diagnostic.py` oraz `login-diagnostic-oracle.py` wykonują jednorazowe
eksperymenty w istniejącej cgroup, używając zainstalowanych bibliotek i parsera.
Zatwierdzony test sesji ma
[osobny zakres](../../docs/verification/oracle/2026-10-14/login-diagnosis/SESSION_TEST_SCOPE_PL.md)
i nie podłącza sesji do produkcyjnej pracy 24/7. Wykonane testy sesji `web`
i odświeżonego `mweb` uzyskały `player=OK` i 31 ścieżek, lecz napisy wymagają
osobnego tokena Subs Proof of Origin. Chromium z tym samym eksportem ponownie
otrzymał komunikat antybotowy. Następna zatwierdzona próba ze świeżą sesją
i tokenem Subs pobrała już bezpośrednio z YouTube na Oracle ręczne EN:
HTTP 200, 46 010 bajtów JSON3, 286 segmentów, około 20 s.
Każdy tekst i czas oraz cały plik transkrypcji zweryfikowano z odebraną
odpowiedzią. Anonimowa kontrola z tokenami PLAYER i SUBS dla tego samego
filmu nadal otrzymała komunikat antybotowy, mimo potwierdzonego przekazania
tokena w żądaniu player. Świeża sesja pozostaje warunkiem sprawdzonej metody;
pojedynczy sukces nie dowodzi autonomicznego działania 24/7.
Skryptowa wersja standardowego `bgutil-ytdlp-pot-provider` 2.0.2 została
przygotowana tymczasowo na Oracle. Opcjonalne `--pot-server` w diagnostyce
wykorzystuje binding `VIDEO_ID` dla Subs i standardowe wejście yt-dlp
`mweb.subs+TOKEN`. Anonimowa diagnostyka `--pot-player` przekazuje również
`mweb.player+TOKEN`, zgodnie z bindingiem VIDEO_ID istniejącego providera.
Dostawca nie otrzymuje cookies; jego transport ma limit
8 prób/40 s, a etap yt-dlp osobny limit 8 prób. Całe zadanie pozostaje
ograniczone do 100 s i istniejącej cgroup. Token i cache nie są zapisywane
w dowodach i są usuwane po próbie. Przygotowanie/importy oraz kontrola tokena
bez konta nie są dowodem pobrania transkrypcji ani gotowości pracy 24/7.

Etap trwałego uwierzytelnienia używa jawnego `--persistent-session`.
Zachowuje wyłącznie plik YouTube na Oracle w katalogu 0700 / pliku 0600,
UID30000. Każde zadanie pracuje na kopii i atomowo aktualizuje zapis dopiero
po rzeczywistych napisach, rozpoznanym zalogowaniu i poprawnym zakończeniu
nadzorcy. Odmowa daje `REAUTH_REQUIRED` i zachowuje poprzedni plik.
Jawne `--replace-session --cookies PATH` służy wyłącznie do inicjalizacji
lub uzgodnionego ponownego uwierzytelnienia; kolejne zadania go nie używają.
Na Oracle zainstalowano samodzielne polecenie
`sudo /opt/bartosz-intelligence/browser-runtime/youtube-mweb/transcribe VIDEO_ID`.
Po jednorazowej inicjalizacji świeżą sesją wykonano trzy rzeczywiste pobrania
z zachowanego pliku Oracle bez reimportu: dwa razy 286 segmentów EN
`aircAruvnKk` oraz 241 segmentów EN TED `uEztHu4NHrs`.
Każde zadanie uruchamia nowy proces; token Subs powstaje ponownie.
Po dwóch błędach transportu żądanie samego pliku napisów otrzymało obsługiwany
przez yt-dlp timeout 20 s, przy zachowaniu 100 s całego zadania.
Nie potwierdzono długotrwałej żywotności sesji; po jej utracie potrzebne
jest normalne ponowne uwierzytelnienie, bez automatycznego wpisywania hasła.
[Bieżące wyniki i dokładna kontynuacja](../../docs/verification/oracle/2026-10-14/persistent-auth/REPORT_PL.md).
Nie uruchomiono produkcyjnego schedulera ani migracji D1.

`publisher` pobiera niezależnie opublikowany plik napisów, a nie panel YouTube.
Konfiguracja: `schema=ote-source:1`, `source_url`, `association_url`,
`format=srt|vtt|sentence-json`, `language_code`; opcjonalnie `diagnostic_video_id`.
Obsługiwane są wyłącznie HTTPS `raw.githubusercontent.com` i `ocw.mit.edu`,
bez credentials, query, przekierowań ani retry. Dwa GET mają po 15 s i 1 MiB.
`video_url.txt` z tego samego katalogu repozytorium lub para iframe/track strony
MIT musi potwierdzać ID i wskazany plik. To nie jest automatyczne wyszukiwanie
źródeł dla dowolnego autora ani dowód tożsamości oryginalnej ścieżki YouTube.

Istniejący parser SRT przetwarza SRT i prosty VTT; sentence-json wymaga krotek
`[text,start_seconds,end_seconds]`. Niepoprawny koniec lub zgubiony cue jest
odrzucany. Raw źródła i powiązania oraz `publisher-fetch.json` są zapisywane przed
normalizacją, również przy odmowie parsowania. `PASS_LIVE_PUBLISHER` oznacza
odebranie i poprawną strukturę całego opublikowanego pliku; częściowy wynik
zachowuje `PARTIAL`. MANUAL/GENERATED i niezależna kompletność pozostają
niepotwierdzone, `accepted=false`. Warunki publikacji źródła nie są zastępowane
warunkami YouTube.

## Granice i artefakty

- Native deadline 30 s; polecenie CDP do 8 s; cleanup jest dodatkowo ograniczony.
- Body 4 MiB, 20 000 cue, 256 requestów strony, 32 MiB zdekodowanych danych
  strony, CDP message 16 MiB. Wyjście supervisora: 2 MiB na strumień.
- Supervisor domyślnie 768 MiB i 60 s; przykłady suite mają osobny deadline 90 s.
  Windows: twardy limit commit Job Object, watchdog RSS, kill-on-close.
  Linux domyślnie: suma RSS co 50 ms, kill/reap drzewa. Oracle Snap używa
  `--memory-cgroup /sys/fs/cgroup/user.slice/user-UID.slice`: root-controlled
  `memory.max=805306368`, swap=0, RSS wyłącznie diagnostyczne; limit egzekwuje kernel.
  CPU Linux jest próbkowanym dolnym
  oszacowaniem; CPU Windows pochodzi z job accounting.
- Anulowanie: SIGINT/SIGTERM oraz `--cancel-file PATH` supervisora; CLI propaguje
  sygnał do browsera. Brak retry i polling źródłowego API.
- Wyniki: `result.json`, `transcript.txt`, `source-projection.json`, `snapshot.json`,
  `native-diagnostics.json` i osobny receipt supervisora. Pełne body jest hashowane
  po odbiorze, ale nie utrwalane z tokenami. Zapis obejmuje allowlisted source
  projection wszystkich cue; nie jest kopią bajtową całej odpowiedzi YouTube.
  Nieznany renderer/continuation nie jest cicho pomijany.

Niezależny odbiór zapisanych dowodów:

```powershell
& C:/Python314/python.exe -B tools/transcript-engine/verify.py --windows docs/verification/oracle/2026-10-13/original-transcript-engine/windows/browser --oracle docs/verification/oracle/2026-10-13/original-transcript-engine/oracle --pl docs/verification/oracle/2026-10-13/original-transcript-engine/windows/pl-dom/result.json --output .local/ote-independent-repro.json
```

Najpierw build bieżących źródeł. Verifier porównuje hashe wykonanych bundli,
każdy tekst/start/end niezależnym czytnikiem Decimal, oba hosty i negatywny prefiks.
Końcowy wynik pozostaje PASS_OFFLINE_ONLY, bez promocji replay do pozyskania live.
