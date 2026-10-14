# Executor Oracle — instrukcja wdrożenia i odtworzenia

Stan przygotowania pakietu: [raport historyczny](../../../docs/verification/oracle/2026-10-13/executor-readiness/REPORT_PL.md).
Instalacja środowiska i odbiór offline ARM64 zostały następnie wykonane: [aktualny raport](../../../docs/verification/oracle/2026-10-13/arm64-offline/REPORT_PL.md).
**Produkcja pozostaje NO-GO. Nie wykonano rejestracji D1 ani aktywacji usługi.**
Polecenia z sekcji Oracle wymagają osobnej zgody. Nie uruchamiać workera przed kwalifikacją źródła.

## 1. Warunki wejścia

- Ubuntu 24.04 ARM64, istniejąca VM `bartosz-intelligence-server`, SSH do `ubuntu@89.168.89.196`.
- Odrębna tożsamość D1 `oracle-frankfurt-transcript-1`, scope wyłącznie `FETCH_TRANSCRIPT`.
- Produkcyjny HTTPS `APP_ORIGIN`, zgodne kontrakty i schema D1. Nie przekazywać Oracle tokenu Cloudflare, kluczy Google ani sekretu sesji.
- Właściciel potwierdza limity/koszty konta OCI, kopie trwałych danych i uprawnienia do trzech pełnych referencji.
- Przygotowanie hosta zatwierdzono i wykonano w etapie ARM64 offline; późniejsze uruchomienie usługi nadal wymaga osobnej zgody.

Trwały stan to istniejące D1, `jobs`, `job_attempts`, artefakty i mechanizmy control plane.
Oracle nie ma własnej kolejki ani bazy zadań. `runtime_id=local` oznacza istniejący kontrakt procesu OS.

## 2. Sprawdzenia i pakowanie na Windows — lokalne

Z katalogu repozytorium, PowerShell:

```powershell
$taskNode = "$PWD\.tools\node-v24.21.0-win-x64\node.exe"
$taskPnpm = "$PWD\.tools\node_modules\@pnpm\exe.win32-x64\pnpm.exe"
$env:PATH = (Split-Path $taskNode) + ';' + (Split-Path $taskPnpm) + ';' + $env:PATH
& $taskNode --version
& $taskPnpm --version
& $taskPnpm typecheck
& $taskPnpm lint
& $taskPnpm exec vitest run --project unit --project contracts --maxWorkers=2
& $taskPnpm exec vitest run --project workers --maxWorkers=2
python -B tools/deployment/oracle/validate-locks.py
python -B tools/deployment/oracle/release.py pack
Get-Content .local/oracle-deployment/executor.tar.gz.sha256
```

Nie wykonywać `git archive HEAD`: zmiany tego zadania są lokalne i nie mają commita.
`release.py pack` pakuje aktualne bajty śledzonego kodu i jawnie wskazane nowe pliki;
pomija `.env`, klucze, `node_modules`, `.tools`, `.local` i zastane nieśledzone eksperymenty.
Manifest zawiera bazowy commit i SHA-256 każdego pliku. Powtórzenie bez zmiany wejścia daje ten sam hash archiwum.
Opcjonalny katalog wyjściowy pozwala zachować poprzednią zatwierdzoną paczkę; bez argumentu
narzędzie nadal zapisuje do `.local/oracle-deployment`. Nowej paczki z poprawką P0 nie wdrożono.
W bieżącym audycie użyto `release.py pack .local/oracle-deployment/p0-source-storage-20261013`;
przyszły transfer tej paczki wymaga użycia tego katalogu zamiast domyślnej ścieżki z przykładu poniżej.
Aktualny konkretny hash przekazania znajduje się w `package.json` w katalogu dowodów raportu.
Zmiana jakiegokolwiek pliku wymaga ponownego pakowania i kontroli hashy.

Wyjście etapu: testy odpowiednie do zmiany PASS, zatwierdzony manifest plików i hash paczki.
Zastane materiały tylko do odczytu nie powinny być przepisywane przez `prettier --write .`.

## 3. Przygotowanie serwera — MODYFIKUJE ORACLE

Po zgodzie skopiować konkretną paczkę, bez `.env` i bez kluczy prywatnych:

```powershell
& 'C:\Windows\System32\OpenSSH\scp.exe' -F NUL -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -i 'C:\Users\Skarabeusz\.ssh\bartosz-intelligence.key' .local/oracle-deployment/executor.tar.gz .local/oracle-deployment/executor.tar.gz.sha256 ubuntu@89.168.89.196:/tmp/
```

Na Oracle (Bash; sprawdzić hash również względem lokalnego zatwierdzonego wyniku):

```bash
cd /tmp
sha256sum -c executor.tar.gz.sha256
task_release=$(sha256sum executor.tar.gz | cut -d ' ' -f1)
test "${#task_release}" -eq 64
sudo install -d -m 0755 /opt/bartosz-intelligence/releases
test ! -e "/opt/bartosz-intelligence/releases/$task_release"
sudo install -d -m 0755 "/opt/bartosz-intelligence/releases/$task_release"
sudo tar --no-same-owner -xzf executor.tar.gz -C "/opt/bartosz-intelligence/releases/$task_release"
cd "/opt/bartosz-intelligence/releases/$task_release"
```

Nie rozpakowywać ponownie do istniejącego wydania. Przy ponowieniu użyć już zweryfikowanego katalogu.
Przy reinstalacji OS albo braku pakietów bazowych:

```bash
bash tools/deployment/oracle/prepare-host.sh --plan
# Opcjonalnie po zatwierdzeniu odświeżenia indeksów pakietów:
sudo apt-get update
sudo bash tools/deployment/oracle/prepare-host.sh --apply
```

Bootstrap używa dokładnych wersji z `host-packages.lock.txt` dla brakujących/starszych pakietów.
Nie obniża nowszych zastanych wersji i nie wybiera `latest`. Niedostępność przypiętego wydania
zatrzymuje instalację: pozyskać zaufane archiwum Ubuntu albo jawnie zaktualizować pin i powtórzyć odbiór.
Nie zastępować tego dowolnym pakietem. Runtime wymaga Python 3.12.x i ffmpeg 6.1.1; security revision Ubuntu może być nowsza.

```bash
sudo /usr/bin/python3 -B tools/deployment/oracle/release.py verify "$PWD"
bash tools/deployment/oracle/prepare.sh --plan
sudo bash tools/deployment/oracle/prepare.sh --apply
sudo bash tools/deployment/oracle/prepare.sh --apply
```

Drugie uruchomienie sprawdza możliwość ponowienia; nie usuwa katalogów runtime ani `.venv` użytkownika Ubuntu.
Instalator używa blokady `flock`, zweryfikowanych archiwów Node 24.21.0, Deno 2.9.7 i pnpm 12.9.1,
odrębnego `/opt/bartosz-intelligence/runtime/python`, wheel z hashami i `pnpm install --frozen-lockfile`.
Nie instaluje jednostki, nie ustawia `current` i nie kontaktuje się z D1/YouTube.
Zależności npm są weryfikowane według integralności lockfile; skrypty build dopuszcza istniejące `allowBuilds`.
Uszkodzony istniejący runtime zatrzymuje instalację zamiast usuwać środowisko.

Wyjście: poprawne wersje, `pip check`, `runtime-probe.py` i manifest PASS, powtórzenie instalatora PASS.
Pełne wykonanie tego etapu potwierdzono dla poprzedniej zatwierdzonej paczki w raporcie ARM64 offline.
Nowe wydanie wymaga osobnego przekazania i odbioru; niniejsza poprawka go nie wdraża.

## 4. Konto, tożsamość i konfiguracja — MODYFIKUJE ORACLE / D1

Na Oracle po zgodzie:

```bash
getent passwd bartosz-executor || sudo useradd --system --user-group --home-dir /var/lib/bartosz-executor --no-create-home --shell /usr/sbin/nologin bartosz-executor
id bartosz-executor
sudo install -d -o bartosz-executor -g bartosz-executor -m 0700 /var/lib/bartosz-executor /var/lib/bartosz-executor/tmp /var/cache/bartosz-executor
sudo install -d -o root -g root -m 0750 /etc/bartosz-executor
```

Jeżeli konto już istnieje, sprawdzić jego UID, grupy i brak sudo; nie zmieniać nieznanego konta automatycznie.
Kod i runtime pozostają własnością root i są czytelne dla konta usługi. Konto zapisuje wyłącznie stan tymczasowy/cache.

**Osobna zgoda na zapis D1:** istniejący rejestrator rozszerzono o `--oracle`.
Na Windows, z aktualnym odczytem konfiguracji `config/deployment.json` i autoryzacją właściciela:

```powershell
& $taskNode --env-file=.env tools/deployment/local-worker.mjs --oracle
```

Tworzy dokładnie `oracle-frankfurt-transcript-1 / FETCH_TRANSCRIPT` i zapisuje
`ORACLE_TRANSCRIPT_WORKER_CREDENTIAL` do prywatnego lokalnego `.env` przed rejestracją jego SHA-256.
Nie nadpisuje poświadczenia Windows `LOCAL_WORKER_CREDENTIAL`. Konflikt lub odwołane poświadczenie
wymaga jawnej procedury odzyskania; rejestrator nie rotuje go automatycznie.

Przygotować prywatny plik na Windows bez drukowania wartości:

```powershell
& $taskNode --env-file=.env --input-type=module -e 'import fs from "node:fs"; const token=process.env.ORACLE_TRANSCRIPT_WORKER_CREDENTIAL; const origin=process.env.APP_ORIGIN; if(!/^[A-Za-z0-9_-]{43}$/.test(token??"")) throw Error("ORACLE_CREDENTIAL_REQUIRED"); const url=new URL(origin); if(url.protocol!=="https:"||url.username||url.password||url.pathname!=="/"||url.search||url.hash) throw Error("ORACLE_ORIGIN_REQUIRED"); let body=fs.readFileSync("tools/deployment/oracle/executor.env.example","utf8"); body=body.replace(/^APP_ORIGIN=.*$/m,"APP_ORIGIN="+origin).replace(/^LOCAL_WORKER_CREDENTIAL=.*$/m,"LOCAL_WORKER_CREDENTIAL="+token); fs.writeFileSync(".local/oracle-deployment/executor.env",body,{mode:0o600});'
& 'C:\Windows\System32\OpenSSH\scp.exe' -F NUL -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -i 'C:\Users\Skarabeusz\.ssh\bartosz-intelligence.key' .local/oracle-deployment/executor.env ubuntu@89.168.89.196:/home/ubuntu/executor.env.pending
```

Na Oracle:

```bash
chmod 0600 /home/ubuntu/executor.env.pending
sudo install -o root -g root -m 0600 /home/ubuntu/executor.env.pending /etc/bartosz-executor/executor.env
rm -- /home/ubuntu/executor.env.pending
```

Plik zawiera `BARTOSZ_SOURCE_QUALIFIED=false`. Wartości nie trafiają do argumentów procesu ani journald.
Nie używać `set -x`, `systemctl show ... -p Environment`, `cat executor.env` ani `ps e`.
Na Windows plik powinien mieć prywatny ACL użytkownika; sam POSIX `mode` nie ustawia Windows ACL.

Przed testami użyć kontrolowanego środowiska usługi przez przejściową jednostkę (nadal bez D1):

```bash
sudo systemd-run --wait --pipe --collect --unit=bartosz-executor-preflight \
  --property=User=bartosz-executor --property=Group=bartosz-executor \
  --property="WorkingDirectory=$PWD" \
  --property=EnvironmentFile=/etc/bartosz-executor/executor.env \
  /opt/bartosz-intelligence/runtime/node-24.21.0/bin/node --import tsx tools/executor/run-oracle.ts --check
sudo systemd-run --wait --pipe --collect --unit=bartosz-executor-offline-tests \
  --property=User=bartosz-executor --property=Group=bartosz-executor \
  --property="WorkingDirectory=$PWD" \
  --property=EnvironmentFile=/etc/bartosz-executor/executor.env \
  /bin/bash tools/deployment/oracle/verify-arm64.sh
```

To operacje uruchomienia jednostek testowych, wymagające zgody. `--check` nie publikuje heartbeatów
i nie rezerwuje zadań. `verify-arm64.sh` ma wyłącznie transporty testowe i lokalny HTTP.
Wymaga czytelnego kodu i zainstalowanych zależności, tworzy pliki tylko w katalogach tymczasowych.
Wywołanie testów ma jawne `--config.verifyDepsBeforeRun=false`: `pnpm exec` nie naprawia
zależności ani nie instaluje ich podczas odbioru offline. Zależności przygotowuje odrębnie
`prepare.sh` z niezmienionymi hashami, `--frozen-lockfile` i polityką `allowBuilds`.
Nie ustawiać tej opcji globalnie ani nie wyłączać `verifyStoreIntegrity`.
Po zmianie skryptu zbudować nowe lokalne wydanie; nie edytować zatwierdzonego katalogu na Oracle.
Wyjście: rzeczywiste Linux/ARM64 offline PASS pod UID usługi; nie nazywać tego kwalifikacją źródła.

## 5. Kwalifikacja źródła — osobna bramka, obecnie BLOCKED

Właściciel dostarcza trzy różne, uprawnione filmy i niezależne pełne referencje tej samej ścieżki.
Nie używać CAPTCHA, prywatnych cookies, proxy, zmiany IP, PoT ani obejść kontroli dostępu.
Jeżeli metoda yt-dlp nie ma dopuszczalnego dostępu, zatrzymać tę ścieżkę; oficjalny provider API
w repo wymaga odrębnego OAuth edytora i nie jest przełączany automatycznie przez ten worker.

Prywatny `qualification-input.json` ma tablicę `cases` zawierającą dokładnie trzy obiekty:
`video_id` (11 znaków), rzeczywiste `duration_ms`, opis `access_basis`, `reference_complete=true`,
absolutny `reference_path` i oczekiwany `reference_sha256`.
Każda referencja JSON zawiera rzeczywiste `language_code`, `track_kind` (`MANUAL`/`GENERATED`)
i **wszystkie** `segments` z `upstream_index`, `start_ms`, `end_ms`, `text`, `speaker_label`.
Nie dołączono fikcyjnych materiałów ani referencji wypełnionych placeholderami.

Po zatwierdzeniu materiałów na Oracle:

```bash
sudo systemd-run --wait --pipe --collect --unit=bartosz-source-qualification \
  --property=User=bartosz-executor --property=Group=bartosz-executor \
  --property="WorkingDirectory=$PWD" \
  --property=EnvironmentFile=/etc/bartosz-executor/executor.env \
  /opt/bartosz-intelligence/runtime/node-24.21.0/bin/node --import tsx \
  tools/deployment/oracle/qualify-source.ts \
  /var/lib/bartosz-executor/qualification-input.json \
  /var/lib/bartosz-executor/source-qualification-1
```

Helper wykorzystuje istniejący provider, nie dotyka D1, nie tworzy kolejki i nie ponawia odmowy.
Katalog wyników musi być nowy. PASS wymaga zgodności całej treści, wszystkich czasów i języka,
braku tłumaczenia i luk, pełnego niepustego raw oraz hashy raw/JSON/TXT dla wszystkich trzech przypadków.
Referencja musi być niezależnie potwierdzona jako pełna; helper nie potrafi dowieść praw ani jakości referencji.
Odmowa kończy próbę bez zmiany `BARTOSZ_SOURCE_QUALIFIED`.
Po odebraniu receipt i podstawy dostępu administrator może zmienić flagę na `true` przez
`sudoedit /etc/bartosz-executor/executor.env`. Nie wystarczy zmienić flagi, aby uzyskać dowód PASS.

## 6. Uruchomienie produkcyjne — MODYFIKUJE ORACLE I STAN ZADAŃ D1

Wejście: trzy źródła PASS, schema/kontrakty produkcji zgodne, tożsamość D1 zgodna,
offline ARM64 PASS, brak aktywnego konkurencyjnego executora Windows podczas odbioru,
osobna zgoda na uruchomienie. Wcześniejszy raport opisuje produkcję z 39 migracjami,
a repo zawiera 040; stan aktualny trzeba sprawdzić odczytowo. Nie uruchamiać tu migracji.

```bash
sudo install -o root -g root -m 0644 tools/deployment/oracle/bartosz-executor.service /etc/systemd/system/bartosz-executor.service
sudo ln -s "$PWD" /opt/bartosz-intelligence/current.next
sudo mv -Tf /opt/bartosz-intelligence/current.next /opt/bartosz-intelligence/current
sudo systemd-analyze verify /etc/systemd/system/bartosz-executor.service
sudo systemctl daemon-reload
sudo systemctl enable --now bartosz-executor.service
sudo systemctl is-enabled bartosz-executor
sudo systemctl is-active bartosz-executor
sudo bash tools/deployment/oracle/diagnose.sh
```

`current.next` musi nie istnieć przed poleceniem. Zachować wcześniejszy cel `readlink -f current`
przed przełączeniem. Nie wykonywać rekursywnego `chown` całego `/opt` ani usuwać starego wydania.
Nie otwierać portów publicznych. Worker wykonuje wyłącznie połączenia wychodzące.

Pierwszy job utworzyć przez istniejący uprawniony intake/UI, zapisać jego `job_id` i stan początkowy.
Odbiór: D1 heartbeat rzeczywistej tożsamości, jeden aktualny lease/fence, `SUCCEEDED`, jeden
zaakceptowany run, sześć zweryfikowanych artefaktów (dwie odmiany SEGMENT_MAP), kompletność i hash.
Jeżeli kwalifikacja miała inny materiał, najpierw wykonać jeden cykl w kontrolowanym zbiorze.
`--once` nie umożliwia wybrania pojedynczego transcript job; nie zakładać takiego parametru.
Archiwum Drive sprawdzić osobno: zaakceptowane źródło D1 nie dowodzi eksportu Drive.

## 7. Restart, recovery i 24 h — testy po zgodzie

```bash
sudo systemctl restart bartosz-executor
sudo systemctl is-active bartosz-executor
# Oddzielny test awaryjny wyłącznie nowej usługi, gdy ma aktywne zatwierdzone zadanie:
sudo systemctl kill --kill-whom=all --signal=SIGKILL bartosz-executor
sudo systemctl show bartosz-executor -p NRestarts -p ActiveState -p Result
```

Restart kontrolowany: przerwane zadanie trafia do istniejącego retry; cleanup ma timeout RPC 30 s.
Nagłe zabicie: zadanie pozostaje trwałe, lease local wygasa po 15 min od ostatniego heartbeat,
następnie istniejący sweeper (cron co 5 min, zależnie od limitów i kolejności) przywraca je do pracy.
Nie wymuszać SQL-em wygaśnięcia lease. Stary fence nie może sfinalizować wyniku; ponowienie
nie może dać drugiego accepted run/artefaktu tej samej tożsamości. Zarejestrować wszystkie fazy z D1.
Test SIGKILL nie jest restartem całej VM. Test bootu VM wymaga osobnej zgody na reboot.

Następnie wyłączyć Windows i przez minimum 24 h zlecać nowe zadania przez istniejący control plane.
Zapisać czasy wyłączenia, heartbeat, pełne sukcesy, błędy/retry/backlog, RSS/CPU/dysk i hashy artefaktów.
Wejście/wyjście: stale obecny wykonawca i nowe kompletne wyniki bez tunelu do Windows, bez ręcznej
sesji SSH, bez narastającego backlogu ponad zmierzoną przepustowość. Sam idle heartbeat nie wystarcza.
Nie skonfigurowano automatycznego monitora ani fikcyjnych danych.

## 8. Diagnostyka — ODCZYT

```bash
sudo bash /opt/bartosz-intelligence/current/tools/deployment/oracle/diagnose.sh
sudo journalctl -u bartosz-executor --since '24 hours ago' --output=cat --no-pager
df -h /var/lib/bartosz-executor /opt/bartosz-intelligence
free -m
```

`diagnose.sh` filtruje journald do znanych pól zdarzeń. Retencja journald jest zastana;
nie zmieniano globalnej konfiguracji. Kontrolować `journalctl --disk-usage` i wolne miejsce.
Nie rejestrować treści zewnętrznych odpowiedzi ani poświadczeń.

W control plane zalogowany właściciel może odczytać `/api/v1/system/summary` i
`/api/v1/system/transcript-archives`. Są to istniejące endpointy właściciela;
worker z samym `FETCH_TRANSCRIPT` nie otrzymuje uprawnienia administracyjnego.
Alternatywa: odczyt `status.sql` przez uprawnionego właściciela z prawidłowym owner/worker ID:

```powershell
# Po zapisaniu właściwych ID w prywatnej kopii .local/oracle-deployment/status.sql:
& $taskNode --env-file=.env --input-type=module -e 'import fs from "node:fs"; import {queryBatch} from "./tools/deployment/cloudflare.mjs"; const sql=fs.readFileSync(".local/oracle-deployment/status.sql","utf8"); if(sql.includes("UZUPELNIJ")) throw Error("DIAGNOSTIC_SCOPE_REQUIRED"); console.log(JSON.stringify(await queryBatch(sql.split(";").map(sql=>sql.trim()).filter(Boolean).map(sql=>({sql,params:[]})))));'
```

Brak heartbeat pozostaje brakiem; żadne z poleceń diagnostycznych go nie publikuje.
Sprawdzić również ostatnią pełną finalizację, `reason_code`, wygasłe lease i rzeczywisty stan eksportu.

## 9. Rollback i awaria serwera

Po zgodzie na rollback:

```bash
sudo systemctl stop bartosz-executor
task_previous=/opt/bartosz-intelligence/releases/UZUPELNIJ_ZATWIERDZONY_HASH
test -f "$task_previous/release-manifest.json"
sudo /usr/bin/python3 -B "$task_previous/tools/deployment/oracle/release.py" verify "$task_previous"
sudo ln -s "$task_previous" /opt/bartosz-intelligence/current.next
sudo mv -Tf /opt/bartosz-intelligence/current.next /opt/bartosz-intelligence/current
sudo systemctl start bartosz-executor
```

Nie przywracać starej kopii kolejki: D1 jest autorytatywne. Upewnić się, że poprzedni kod ma
zgodne API/schema/runtime i własny pozytywny odbiór. W tym pierwszym wdrożeniu nie ma starego
wydania Oracle: rollback to `systemctl disable --now bartosz-executor` i pozostawienie zadań w D1.
Nie usuwać `.venv`, danych D1 ani artefaktów. Usługa Windows może wrócić tylko jako świadoma
decyzja właściciela; nie oznacza autonomii Oracle.

Po utracie VM odtworzyć zatwierdzony obraz Ubuntu ARM64, bazowe pakiety, tę samą paczkę z hashami,
runtime, konto, bezpiecznie odzyskane poświadczenie i unit. Najpierw zatrzymać/odwołać starą
tożsamość, jeżeli stary host może nadal działać. Rejestrator nie rotuje automatycznie sekretu.
Trwałe joby odzyska sweeper; cache/tmp Oracle nie są kopią kolejki i mogą zostać odbudowane.
Odtworzenie D1/Drive wymaga ich istniejącej procedury backup/restore; żadnej migracji lub restore
produkcji nie wykonuje ten pakiet. Pojedyncza VM Always Free nie daje HA ani gwarancji braku reclamation.
