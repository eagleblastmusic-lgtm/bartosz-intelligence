# Chromium ARM64: przygotowana poprawka sandboxa

> **Kandydat enforce v2 (2026-10-14):** [README_V2_PL.md](README_V2_PL.md).
> Ma dokładny manifest wykonywalnych mapowań i testy, lecz nie jest wdrożony.
> `SANDBOX_DEPLOYMENT_READINESS=BLOCKED_SECURITY_MODEL_AND_ACTIVE_ACCEPTANCE`.
> Poniższy wariant unconfined pozostaje historyczny; blokady instalatora nie zdjęto.

> **STOP — preflight wdrożenia 2026-10-14 wykrył niespełnione wymaganie 8.**
> Aktualny stan: `SANDBOX_READINESS=BLOCKED_PREFLIGHT_LIBRARY_BOUNDARY`.
> Konto może ominąć launcher i wybrać bibliotekę przez bezpośredni exec ELF.
> `install.py apply` ma lokalną blokadę przed jakimkolwiek zapisem na hoście.
> Poprzedni plan i instrukcje poniżej dokumentują przygotowany wariant; nie są
> zgodą na obejście nowej bramki. Raport wdrożeniowego preflightu znajduje się w
> `docs/verification/oracle/2026-10-14/chromium-sandbox-deployment/REPORT_PL.md`.

Historyczny stan przygotowania z 2026-10-13: `SANDBOX_READINESS=PREPARED_AWAITING_OWNER_APPROVAL`.
`LIVE_SOURCE_ACCESS=BLOCKED_AUTHORIZATION`. Niczego nie zastosowano na hoście.
Nie uruchomiono Chromium ani stron YouTube w tym etapie. Testy kontraktów nie
potwierdzają działania sandboxa. Raport i dowody:
`docs/verification/oracle/2026-10-13/chromium-sandbox/`.

## Docelowy runtime

Jedna wersja: Chromium Headless Shell **153.0.8010.12**, Linux ARM64.
Konfiguracja znajduje się w `runtime.json`, pełny manifest 287 plików w
`assets.json`. Archiwum ZIP ma 120278638 bajtów, rozpakowane pliki 277495266.
ZIP nie jest częścią małej paczki do przeglądu; jest pobierany osobno przez HTTPS.

```text
ZIP SHA256: d433c45172c7836e38124fe545f767b02210bfb43a6262f08a297473a8e91c99
ELF SHA256: f5d89353cc9ef8dc1541268bbee1f05ee40a31ce3d9799b3a274e5147f6a8cdb
```

Docelowy katalog:
`/opt/bartosz-intelligence/browser-runtimes/chromium-headless-shell-153.0.8010.12`.
Katalogi, ELF i launcher: `root:988`, `0750`; pozostałe pliki: `root:988`, `0640`.
Istniejące konto wykonawcze: `bartosz-executor`, UID 997, GID 988, bez dodatkowych
grup. Walidacja odrzuca zmianę tych danych. Rodzice runtime'u muszą należeć do
roota i nie mogą być zapisywalni przez inne konta ani być symlinkami.

Profil `/etc/apparmor.d/bartosz-ote-chromium-153_0_8010_12`, `root:root`, `0644`,
pasuje dokładnie do tego ELF. Nie zawiera wildcardów ani lokalnych rozszerzeń.
`flags=(unconfined)` i `userns,` tworzą wyjątek od ograniczenia user namespaces.
To **nie jest pełne ograniczenie plików lub sieci przez AppArmor**. Wymagana
izolacja niezaufanych rendererów pozostaje zadaniem sandboxa Chromium.

Launcher weryfikuje wszystkie zasoby przy każdym starcie, odrzuca symlinki,
niezgodne hashe, zapisywalne pliki, SUID/SGID i file capabilities. Przyjmuje
wyłącznie argumenty istniejącego klienta CDP, świeży prywatny profil w `/tmp`
i konto 997. Czyści środowisko i wykonuje ELF przez `execve`; nie zawiera fallbacku.
Sam launcher nie jest osobną granicą uprawnień: konto wykonawcze ma dostęp do ELF
i może uruchomić go bez launchera. Zaufanie do tego konta jest częścią modelu.

## Odtworzenie testów bez zmian zabezpieczeń

Z katalogu głównego repozytorium, używając istniejących zależności:

```powershell
python -B tools/transcript-engine/sandbox/contracts.py .local/chromium-sandbox/windows-contracts.json
node tools/transcript-engine/sandbox/build-check.mjs
python -B tools/transcript-engine/sandbox/positive.py --output .local/chromium-sandbox/windows-positive-gate.json
python -B tools/transcript-engine/sandbox/install.py plan --output .local/chromium-sandbox/change-plan.json
python -B tools/transcript-engine/sandbox/offline-oracle.py --key C:/Users/Skarabeusz/.ssh/bartosz-intelligence.key --output .local/chromium-sandbox/oracle-offline.json
```

`offline-oracle.py` używa istniejącego SSH, wykonuje obecnie 42 kontrakty na ARM64,
sprawdza rzeczywisty start klienta CDP za pomocą nieszkodliwego programu fixture,
kompiluje poprawny i celowo błędny profil. Nie pobiera ani nie uruchamia przeglądarki.
Parser otrzymuje tylko `--skip-kernel-load --skip-cache --stdout`. Zmiany ograniczają
się do własnego, usuwanego katalogu `/tmp/ote-sandbox-contracts-*`. Porównuje też
hashe wskazanych sysctl i plików polityk przed i po teście.

`positive.py` bez `--owner-authorized` zapisuje blokadę i **nie uruchamia procesu**.
Ten argument dokumentuje decyzję operatora; jego wpisanie nie zastępuje zgody
właściciela. Składnię profilu można sprawdzić bez instalacji również lokalnie na
Linuxie z AppArmor 4:

```sh
/usr/sbin/apparmor_parser --skip-kernel-load --skip-cache --stdout < bartosz-ote-chromium-153_0_8010_12.apparmor > /tmp/ote-profile.compiled
```

Na Windows nie emulujemy AppArmor. Tam sprawdzane są kontrakty, składnia Pythona,
TypeScript, lint i format. Odczytowa diagnostyka przyczyny, jeśli stan się zmienił:

```powershell
python -B tools/transcript-engine/sandbox/diagnose.py --key C:/Users/Skarabeusz/.ssh/bartosz-intelligence.key --output .local/chromium-sandbox/diagnosis.json
```

Inspekcja ZIP bez wykonania ELF:

```powershell
python -B tools/transcript-engine/sandbox/prepare.py --archive .local/chromium-sandbox/chrome-headless-shell-linux-arm64.zip --download
```

`prepare.py` generuje manifest i profil. Po ponownym generowaniu trzeba porównać
bajty z zatwierdzoną paczką oraz ponownie wygenerować plan; nie formatować
zatwierdzonych plików podczas przenoszenia.

## Dokładna bramka wdrożenia — wymaga osobnej zgody

Poniższych operacji **nie wykonano**. Konto SSH użyte w diagnozie nie otrzymuje
nowych uprawnień. Potrzebny jest istniejący administrator, który może zapisywać
`/opt`, `/etc/apparmor.d` i ładować politykę AppArmor. Nie potrzeba zmiany IAM,
SSH, sysctl, systemd ani uruchamiania produkcyjnego executora.

1. Administrator sprawdza raport, paczkę `review-packet.tar.gz`, jej SHA256 w
   `evidence-manifest.json` oraz `change-plan.json`. Umieszcza i kontroluje
   **root-owned** paczkę w `/root/bartosz-ote-sandbox-20261013` (`0700`), bez
   symlinków i praw zapisu dla innych kont. ZIP trafia do tego katalogu jako
   `browser.zip`, root:root `0600`. Rozpakowanie paczki do katalogu root również
   jest operacją administratora objętą zgodą. ZIP może pochodzić z lokalnego
   pobrania; jego hash jest ponownie sprawdzany przed ekstrakcją.
2. Jako administrator odtwarza plan i porównuje `plan_sha256` z zaakceptowanym
   dokumentem. Hash planu wiąże bajty kodu instalatora, launchera, polityki,
   konfiguracji i manifestu. Zmiana dowolnego z nich unieważnia ten plan.
3. Dopiero po zgodzie uruchamia `apply`. Skrypt tworzy brakujący katalog bazowy
   `/opt/bartosz-intelligence/browser-runtimes` (`root:root`, `0755`) i jeden
   katalog wersji; kopiuje 287 zasobów oraz cztery pliki kontrolne. Nie zastępuje
   istniejącego runtime'u ani profilu. Instaluje jeden plik AppArmor i ładuje
   **wyłącznie jego** treść przez `apparmor_parser --add --skip-cache`.
4. Zapisuje `install-receipt.json`, ze stanem `INSTALLED_AWAITING_POSITIVE_PROBE`.
   Nie uruchamia przeglądarki, usług ani executora. Nie dodaje SUID lub capabilities.

Polecenia **do późniejszego wykonania przez administratora**, po zatwierdzeniu:

```sh
cd /root/bartosz-ote-sandbox-20261013
/usr/bin/python3 -I install.py plan --output /root/ote-approved-plan.json
# PLAN_SHA to literalna wartość z zatwierdzonego change-plan.json.
/usr/bin/python3 -I install.py apply --archive ./browser.zip --approved-plan-sha256 PLAN_SHA
```

Nie stosować `sudo` jako konta wykonawczego przeglądarki. Root wykonuje tylko
administrację/obserwację; Chromium ma działać jako UID 997.

## Test pozytywny dopiero po autoryzowanym zastosowaniu

Walidator na zainstalowanym runtime, uruchomiony jako istniejące konto wykonawcze:

```sh
runuser -u bartosz-executor -- /opt/bartosz-intelligence/browser-runtimes/chromium-headless-shell-153.0.8010.12/launcher.py --validate-only
```

Wynik `configuration=PASS` oznacza integralność konfiguracji, nie aktywny sandbox.
Następny test wymaga osobnego, autoryzowanego startu kontrolowanej przeglądarki:

```sh
/usr/bin/python3 -I /root/bartosz-ote-sandbox-20261013/positive.py --owner-authorized --output /root/ote-sandbox-positive.json
```

Skrypt prowadzi lokalny serwer `127.0.0.1` bez zapisanych sesji, tworzy świeży
profil i uruchamia przeglądarkę jako UID 997/GID 988 **bez dodatkowych grup**.
Root jest opcjonalnym obserwatorem: Chromium może ustawiać procesy jako
non-dumpable, więc odczyt namespace rendererów może wymagać uprawnień administratora.
Proces przeglądarki nigdy nie ma UID 0. Test odczytuje `/proc` z żywych procesów
tej konkretnej grupy procesów i wymaga jednocześnie:

- zgodnego hasha/wersji i nazwanego profilu AppArmor głównego procesu i rendererów;
- UID/GID konta wykonawczego oraz braku effective/ambient capabilities rendererów;
- `Seccomp=2`, co najmniej jednego filtra i `NoNewPrivs=1` w rendererach;
- odrębnych user/PID/net namespaces rendererów względem procesu głównego;
- widocznej z hosta zagnieżdżonej przestrzeni PID oraz działającej strony lokalnej.

Nie wystarcza brak flagi `--no-sandbox` ani sam start procesu. Każdy brak dowodu
daje `FAIL_CLOSED`. Watchdog kończy grupę procesów po 30 s; CDP ma timeout 5 s,
limit wiadomości 2 MiB, kolejki 256 zdarzeń i stderr 64 KiB. Nie ma retry.
Fetch Guard odrzuca ruch strony poza własny loopback i lokalne blob/data;
nie jest systemowym firewallem. Ten test zawsze pozostawia `accepted=false`
i `LIVE_SOURCE_ACCESS=BLOCKED_AUTHORIZATION`.

## Rollback

Wycofanie również jest operacją administratora. Po zakończeniu kontrolowanego
testu, z tą samą zatwierdzoną paczką:

```sh
/usr/bin/python3 -I /root/bartosz-ote-sandbox-20261013/install.py rollback --approved-plan-sha256 PLAN_SHA
```

Rollback sprawdza integralność i odmawia przy żywych procesach tego ELF. Nie
zatrzymuje żadnej usługi. Odbiera grupie dostęp do katalogu wersji (`0700`),
ponownie sprawdza procesy, usuwa tylko wskazany profil przez
`apparmor_parser --remove --skip-cache` i usuwa tylko jego plik. Porównuje sysctl
przed i po. Runtime i `rollback.json` pozostają dostępne wyłącznie rootowi;
katalog bazowy może pozostać. Nie ma rekursywnego kasowania zasobów ani cudzych plików.

W razie błędu instalacji po przeniesieniu runtime'u skrypt ustawia katalog na
`0700` i zachowuje stan do diagnozy. Błąd nie oznacza automatycznego sukcesu lub
pełnego rollbacku. Administrator sprawdza plik oraz załadowaną politykę i wykonuje
kontrolowane wycofanie. Częściowy/uszkodzony plik polityki zostanie odrzucony,
zamiast zostać usunięty bez sprawdzenia.

## Aktualizacja i integracja

Nie zastępować ELF w istniejącej ścieżce ani nie używać symlinku `current`.
Nowa wersja wymaga nowego URL, pinów, inspekcji ZIP, manifestu, dokładnej ścieżki
i osobnego profilu. Administrator weryfikuje pochodzenie wydania i dostępne
publikowane sumy/podpisy. Obecne SHA są pinami pobranego przez HTTPS artefaktu,
nie podpisem producenta ani audytem jego podatności.

Po testach kontraktów, kompilacji bez ładowania i nowej zgodzie instalujemy nową
wersję obok starej. Najpierw musi przejść test lokalny z rzeczywistym sandboxem.
Dopiero wtedy osobno zatwierdza się zmianę konfiguracji konsumenta. Cofnięcie
konsumenta wskazuje poprzednią, nadal zweryfikowaną wersję. Wycofanie starego
profilu odbywa się po sprawdzeniu, że nie ma jego procesów. Skrypt odmawia
ponownego użycia istniejącej ścieżki; ponowna aktywacja po rollback wymaga przeglądu.

`native.example.json` wskazuje launcher i `sandbox=true`, a zgodę na YouTube
pozostawia wyłączoną. Jedyna zmiana istniejącego klienta CDP usuwa przekazywanie
`LD_LIBRARY_PATH`, ponieważ dynamiczny loader działa przed kodem launchera.
`LD_PRELOAD`, `PYTHONPATH` i `NODE_OPTIONS` także nie są przekazywane — sprawdzono
to przez rzeczywisty `captureNative` na ARM64, bez przeglądarki i sieci.

Nie zmieniono produkcyjnego executora. Jego docelowe ograniczenia systemd
(np. `NoNewPrivileges`, `CapabilityBoundingSet`, `PrivateTmp`, `TasksMax`) mogą
wpływać na start; pozytywny test standalone nie będzie odbiorem tego kontekstu.
Integracja wymaga osobnego testu pod tymi ograniczeniami, bez ich osłabiania.
Podstawa automatycznego dostępu do YouTube nadal wymaga udokumentowania w osobnym
etapie. Gotowy sandbox nie zmienia tej decyzji.
