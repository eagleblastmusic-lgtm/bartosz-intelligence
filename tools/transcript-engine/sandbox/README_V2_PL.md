# AppArmor enforced library boundary v2

Przygotowany kod i profil są kandydatem do oddzielnego odbioru. **Instalacja
jest zablokowana.** Nie istnieje dowód z aktywnej polityki, że bezpośredni ELF
odrzuca bibliotekę UID 997 i zachowuje sandbox Chromium. Dodatkowo obecny model
nie zamyka wejścia `unconfined -> aa_change_profile` bez exec ani bezpośrednich
argumentów wyłączających sandbox. `accepted=false`; YouTube pozostaje
`BLOCKED_AUTHORIZATION`.

Raport: [REPORT_PL.md](../../../docs/verification/oracle/2026-10-14/apparmor-library-boundary-v2/REPORT_PL.md).

## Pliki i granice

- `enforced-runtime.json`: wersja 153.0.8010.12, dokładna ścieżka ELF w `/opt`,
  UID 997/GID 988, SHA archiwum/ELF/lock.
- `v2-library-lock.json`: 60 literalnych miejsc mapowania — 55 rzeczywistych
  bibliotek Oracle oraz ELF i 4 biblioteki przypiętego archiwum. Zawiera hashe,
  owner/mode/ACL/caps, 56 aliasów z rodzicami, zależności ELF i jawny brak
  obserwacji późnych `dlopen`.
- `bartosz-ote-chromium-153_0_8010_12-enforced-v2.apparmor`: enforce,
  `mediate_deleted`, bez importów abstrakcji. Jeden ELF `mrix`, biblioteki `mr`;
  scratch i dane bez `m`/`x`. Jedynie ponowne wykonanie tego ELF (`ix`).
- `enforced.py`: kontrola manifestu, całego runtime, każdego miejsca `m` i jego
  rodziców/symlinków; odrzucenie ACL, file capabilities i hardlinków. Reguły
  profilu muszą odpowiadać dokładnie generatorowi, bez dodatkowych mapowań.
- `launcher-v2.py`: oczyszczone środowisko, stałe argumenty obecnego CDP,
  świeży profil i integralność. Jest opcjonalnym wrapperem, więc nie jest
  systemową kontrolą argv bezpośredniego ELF.
- `v2-plan.py`: osobny plan z hashami; `apply` zawsze odmawia kodem
  `V2_INSTALLATION_BLOCKED_NO_FORCE_PATH`. Przygotowana funkcja rollbacku
  odwołuje tylko dokładny profil i zachowuje runtime root-only.
- `v2-active-tests.py`: przygotowany przyszły odbiór już zainstalowanej polityki.
  Domyślnie nie uruchamia żadnego subprocess ani przeglądarki.

AppArmor `m` ogranicza wykonywalne mapowania **plików**, nie stanowi kontroli
całego pochodzenia kodu JS/Wasm/JIT lub anonimowej pamięci. `deny change_profile`
dotyczy wyjścia z już zastosowanego profilu. Obecne hostowe
`apparmor_restrict_unprivileged_unconfined=0` pozostawia odrębną drogę wejścia
do profilu z zachowaniem wcześniejszych mapowań. Nie zmieniamy tego sysctl.

## Odtwarzanie dozwolonych kontroli

Z katalogu głównego repozytorium, z istniejącym Pythonem i SSH:

```powershell
python -B tools/transcript-engine/sandbox/v2-contracts.py .local/chromium-sandbox-v2/recheck-windows.json
python -B tools/transcript-engine/sandbox/v2-plan.py plan --output .local/chromium-sandbox-v2/recheck-plan.json
python -B tools/transcript-engine/sandbox/v2-active-tests.py --output .local/chromium-sandbox-v2/recheck-gate.json
python -B tools/transcript-engine/sandbox/v2-offline-oracle.py --key C:/Users/Skarabeusz/.ssh/bartosz-intelligence.key --output .local/chromium-sandbox-v2/recheck-oracle.json
```

Ostatnie polecenie wymaga istniejącego administratora tylko do **odczytu**
metadanych bibliotek i załadowanej listy profili. Używa własnego katalogu `/tmp`,
kontraktów offline oraz `apparmor_parser --skip-kernel-load --skip-cache --stdout`.
Nie zapisuje konfiguracji ani cache AppArmor, nie uruchamia Chromium. Kompiluje
również celowo niepoprawny profil, który musi zostać odrzucony. Porównuje aktywną
listę profili, sysctl i nieobecność runtime/profile przed i po; usuwa własny tmp.
Testy negatywne owner/ACL/mode/hash i rollbacku używają kontrolowanych fixture
oraz mocków, bez zmiany praw rzeczywistych bibliotek.

Inwentaryzacja zmienionego środowiska wymaga świadomego utworzenia **nowego**
kandydata i unieważnia stary plan. Poniższe polecenie czyta Oracle i istniejące
lokalne ZIP, a zapisuje wyłącznie lokalne manifest/config/profile:

```powershell
python -B tools/transcript-engine/sandbox/v2-inventory.py --key C:/Users/Skarabeusz/.ssh/bartosz-intelligence.key --archive .local/chromium-sandbox/chrome-headless-shell-linux-arm64.zip --output .local/chromium-sandbox-v2/new-inventory.json
```

Nie generować ponownie ani nie formatować bajtów zamrożonego kandydata podczas
jego odbioru. Profil generowany jest z LF — parser hosta odrzucił CRLF. SHA-256
nie zastępuje podpisu dostawcy; archiwum jest pinem wcześniejszego etapu.

## Plan instalacji — zatrzymany przed zmianami

`v2-plan.py plan` podaje dokładny ELF, jeden plik `/etc/apparmor.d`, 60 miejsc
`m`, hashe kodu i krytyczne blokady. Skrypt nie zawiera działającej ścieżki
instalacji ani opcji `force`. Samo podanie hasha lub flagi testowej nie jest
zgodą właściciela. Stary `install.py` pozostaje zablokowany.

Po rozwiązaniu modelu wejścia do profilu i osobnym zatwierdzeniu planu etap
administracyjny wymagałby:

1. Umieszczenia paczki w root-owned `/root`, kontroli wszystkich bajtów,
   ponownej kontroli bibliotek i backupu dokładnego stanu przed zmianą.
2. Utworzenia jednego nieistniejącego runtime wersji; 287 assetów i 6 plików
   kontrolnych, root:988, katalogi/ELF/launcher `0750`, dane `0640`. Rodzice
   root-owned, bez symlinków/ACL/zapisu grupowego. Bez SUID i capabilities.
3. Wyłącznej instalacji profilu v2, root:root `0644`, oraz pojedynczego
   `apparmor_parser --add --skip-cache`. Bez profilu historycznego i bez
   reloadu innych polityk, sysctl, usług, kont lub executora.
4. Walidacji jako UID 997 oraz osobno autoryzowanego odbioru już aktywnej
   polityki. Żadne z tych poleceń nie zostało wykonane.

Plan nie jest rekomendacją zastosowania obecnego kandydata. Najpierw konieczna
jest decyzja o architekturze zamykającej ujawnione drogi wejścia.

## Przyszły test aktywny

Po osobno zatwierdzonej instalacji oraz rozwiązaniu blokad, administrator może
uruchomić `python3 -I v2-active-tests.py --owner-authorized-active-policy --output RESULT`
z root-owned paczki, zachowując układ `tools/transcript-engine/sandbox/` i
`tools/transcript-engine/supervise.py`. Root jest obserwatorem, Chromium oraz
próby wykonawcze działają jako UID 997/GID 988 bez dodatkowych grup. Katalog
wynikowy musi już istnieć i należeć do root bez praw zapisu innych kont;
receipt jest nowym plikiem `0600`, bez nadpisywania istniejących dowodów.

Kolejność: próba wejścia `aa_change_profile` z już załadowanym interpreterem
(sukces zatrzymuje odbiór), rzeczywiste pozytywne kontrole fixture DSO/ABI,
launcher + lokalna strona CDP, następnie direct ELF z UID-owned `LD_PRELOAD`
i `LD_LIBRARY_PATH`. Zanieczyszczone środowisko pojawia się dopiero przy exec
ELF; nie trafia do wcześniejszego loadera powłoki.

Odmowa musi mieć audit `file_mmap`, właściwe PID/profile/path i maskę `m`.
Brak pliku lub sama odmowa `open`, `LD_TRACE_LOADED_OBJECTS`, nieobecny marker
bez pozytywnej kontroli ani błąd CDP nie wystarczają. Pozytywny odbiór wymaga
enforce, prawdziwych rendererów, odrębnych user/PID/net namespaces, bounded
UID/GID maps, NNP i filtrów seccomp, zerowych effective/permitted/inheritable/
ambient capabilities browsera/renderera oraz działającej strony. Mapowania
porównuje przez `/proc/PID/map_files`, inode/device i SHA, odróżniając JIT.

Istniejący supervisor zachowuje **768 MiB** i timeout 100 s. To watchdog sumy
RSS, nie twardy cgroup limit. Każdy launch ma timeouty CDP, killpg i cleanup;
supervisor musi potwierdzić brak pozostałych potomków. Kod testu nie instaluje
ani nie usuwa polityki. Nawet komplet tych testów nie dowodzi OS kontroli argv
lub całego pochodzenia kodu anonimowego; pełny deployment pozostaje odrębną bramką.

## Rollback i aktualizacja

Przygotowany `v2-plan.py rollback --approved-plan-sha256 HASH` wymaga rootowego
izolowanego Pythona i zaufanej paczki. Nie używać go teraz — nie zainstalowano v2.
Po przyszłej zgodzie: zatrzymać testy, odmówić rollbacku przy aktywnym dokładnym
ELF, zamknąć katalog runtime na `0700`, zachować kopię pliku profilu z SHA,
usunąć wyłącznie profil v2 z kernela przez `--remove --skip-cache`, potwierdzić
jego brak i usunąć dokładny plik. Resume po już usuniętym profilu pomija parser.
Sysctl muszą zostać identyczne. Runtime i
uszkodzone assety pozostają jako evidence. Nie wymaga poprawnych hashy assetów;
niebezpieczne granice katalogu/profilu powodują odmowę zamiast kasowania.

Po rollbacku oddzielny odczyt potwierdza SSH/usługi/autostart i brak testowych
procesów. Nie wykonuje się restartu VM ani rekurencyjnego usuwania runtime.
Test kontraktu ćwiczy sekwencję na fixture; rzeczywistego rollbacku nie wykonano.

Aktualizacja systemowej biblioteki unieważnia lock i blokuje launcher. Nowy
Chromium wymaga nowej wersjonowanej ścieżki, pinów i pełnego odbioru (w tym
późnych dlopen); nie nadpisywać starego ELF, nie dopisywać wildcardów `m` i nie
przechodzić automatycznie na `--no-sandbox`. Plan i zgoda wiążą konkretne bajty.
