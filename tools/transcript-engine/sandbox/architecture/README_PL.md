# Decyzja izolacji przeglądarki — A + minimalne C

Wybrany kandydat: Chromium Snap od Canonical przez `/snap/bin/chromium`, osobne
konto `bartosz-browser`, pusty HOME, czyste środowisko, pojedyncze zadanie oraz
limity we wspólnej slice konta. Nie przygotowujemy AppArmor v3. Nie instalowano
Snap/Chromium, nie tworzono kont ani usług; instalator v2 nadal odmawia.

`BROWSER_ISOLATION_ARCHITECTURE=A_PLUS_C_SELECTED_PENDING_OWNER_APPROVAL_AND_ACTIVE_ACCEPTANCE`.
To wybór architektury do kontrolowanego odbioru, nie potwierdzony sandbox.

Raport i porównanie:
[REPORT_PL.md](../../../../docs/verification/oracle/2026-10-14/browser-isolation-architecture/REPORT_PL.md).

## Odtwarzanie offline

Z głównego katalogu repozytorium, bez instalacji nowych zależności:

```powershell
python -B tools/transcript-engine/sandbox/architecture/contracts.py .local/browser-isolation/recheck-windows-contracts.json
node tools/transcript-engine/sandbox/architecture/cdp-contract.mjs --root . --output .local/browser-isolation/recheck-cdp
python -B tools/transcript-engine/sandbox/architecture/candidate.py plan --output .local/browser-isolation/recheck-plan.json
python -B tools/transcript-engine/sandbox/architecture/candidate.py render --uid 60000 --output .local/browser-isolation/recheck-render
python -B tools/transcript-engine/sandbox/architecture/run-local-trial.py
```

UID 60000 jest wyłącznie fixture do renderowania, nie zarezerwowanym UID hosta.
Polecenia `plan`/`render` są lokalne. `apply` zawsze odmawia, bez opcji force.
`run-local-trial.py` domyślnie niczego nie uruchamia. Test CDP używa jawnie
emulowanego transportu/DOM, nie Snap ani Chromium, i zapisanych 286 tekstów.
Na Windows ma testowy adapter spawn; na Linux używa prawdziwego `/bin/sh -> exec`.
Jeśli managed sandbox odmówi startu esbuild, potrzebne jest tylko autoryzowane
wykonanie lokalnego kompilatora; nie instalacja zależności.

Odczyty Oracle i oficjalnego Store:

```powershell
python -B tools/transcript-engine/sandbox/architecture/oracle-read.py --key C:/Users/Skarabeusz/.ssh/bartosz-intelligence.key --output .local/browser-isolation/NEW-oracle-read.json
python -B tools/transcript-engine/sandbox/architecture/store-read.py --output .local/browser-isolation/NEW-store-read.json
python -B tools/transcript-engine/sandbox/architecture/offline-oracle.py --key C:/Users/Skarabeusz/.ssh/bartosz-intelligence.key --client-bundle .local/browser-isolation/recheck-cdp/client-contract.mjs --output .local/browser-isolation/NEW-oracle-offline.json
```

`oracle-read.py` nie wywołuje `snap`, aby przypadkiem nie aktywować socketa.
Czyta dpkg, systemd, profile, metadane, wybrane pola stanu snapd, dysk/RAM i
capabilities helpera. Nie kopiuje prywatnego state.json ani poświadczeń.
`store-read.py` pobiera wyłącznie anonimowe publiczne JSON/manifesty siedmiu
pakietów; zero pakietów binarnych. `offline-oracle.py` uruchamia kontrakty,
`systemd-analyze verify` bez startu i nieszkodliwy CDP jako istniejący UID 1001.
Porównuje granice przed/po i usuwa własny `/tmp`.

## Przygotowana konfiguracja

- `candidate.json`: ścieżki i bramki, limit 768 MiB, 50% CPU, 256 tasks,
  100 s, concurrency 1, brak dziedziczenia sekretów; `deployment_allowed=false`.
- `candidate.py`: walidacja dokładnego kandydata i render dwóch jednostek.
  `user-UID.slice` obejmuje zarówno trial service, jak i ewentualny user-manager
  scope utworzony przez Snap. Faktyczne cgroup wszystkich procesów muszą to
  potwierdzić. Sama nazwa jednostki nie jest dowodem limitu.
- Trial service: nie ma `[Install]`, autostartu ani restartu. `PrivateNetwork=yes`;
  lokalny serwer harness działa w tym samym środowisku. Nie dodano przed Snap
  NNP, pustego capability bounding set, PrivateUsers ani seccomp dyrektyw.
  Uprzywilejowany helper Canonical potrzebuje praw setup; Chromium po setup
  musi mieć nieuprzywilejowany UID i zerowe capabilities.
- `run-local-trial.py`: przyszły start wyłącznie jako nowe konto, z root-owned
  kodem w `/opt/bartosz-intelligence/browser-trial`, świeży job i istniejący
  supervisor/browser-check `--first`. Nie przyjmuje dowolnych argv/ELF/ścieżek.
  Profil trafia do `~/snap/chromium/common/jobs` przez TMPDIR; core CDP bez zmian.

## Minimalny plan — wymaga osobnej zgody

1. Zapisać stan Snap/usług i zatwierdzić transakcję instalacji Chromium stable
   wraz z zależnościami: core24, gnome-46-2404, mesa-2404, gtk-common-themes,
   cups, core26. Odczytany kandydat: 3555/155.0.8059.39 ARM64. Instalacja może
   uruchomić nowe usługi CUPS/Mesa; ten efekt wymaga jawnej zgody. Nie dotykać
   istniejących snapd/core18/oracle-cloud-agent. Nieoczekiwana delta = STOP.
2. Utworzyć jedno konto browser bez loginu/sudo/grup executora, HOME0700,
   pusty profil, brak sekretów. Uruchamiać cały standalone OTE pod tym UID,
   przez `/snap/bin/chromium`, nie bezpośredni ELF. Kod trial i kopia Node
   root-owned; istniejący uid1001-owned Node i release executora bez zmian.
3. Użyć przygotowanego pojedynczego trial service i wspólnej `user-UID.slice`
   z limitem 768 MiB, CPU50%, tasks256, timeout100 s. Bez autostartu, nowego
   user managera, własnej polityki AppArmor czy globalnego sysctl. PrivateNetwork
   to jedna dyrektywa wyłącznie dla pierwszego lokalnego testu: harness i browser
   mają działać w tym samym loopback, bez internetu. Nie rozwijamy sieci.
4. Ręcznie wykonać jeden lokalny `browser-check --first` z istniejącym CDP i
   supervisorem. Administrator obserwuje sandbox/namespace/seccomp/capabilities
   oraz cgroup wszystkich procesów. Nie powiększać 768 MiB, nie wyłączać sandboxa.
   Trial worker sam nie przyznaje statusu bezpieczeństwa PASS.

Warunki odbioru: faktyczne FD3/4 przez Snap, lokalna strona i wszystkie zapisane
teksty/czasy, AppArmor enforce, browser UID bez host caps, renderer z aktywnym
sandboxem (USER/PID/NET, NNP, seccomp), skuteczny limit całego drzewa, timeout/
anulowanie i brak potomków/profili. Sprawdzić niesekretne canary dostępu do plików
executora. Snap może zmienić scope; sama jednostka wrappera nie dowodzi limitu.
Przy cleanup zatrzymać całą dedykowaną gałąź UID, nie tylko service.

Rollback: zakończyć trial, zachować evidence, usunąć tylko dodany service/drop-in,
wykonać zatwierdzony daemon-reload, odinstalować Chromium i wyłącznie nowe,
nieużywane zależności. Zachować HOME/kod root-only do decyzji właściciela;
nie usuwać Snap Oracle agent ani snapd. Porównać stan usług/SSH/AppArmor/sysctl;
bez reboot. Nie wykonywano żadnej z tych operacji.

Aktualizacje: krótki hold Chromium tylko na odbiór, następnie stable refresh
w oknie bez zadania i smoke offline. Nie zamrażać bezpieczeństwa miesiącami.
Zmiana launch chain/base/providers wymaga nowego odbioru. Revert nie cofa common.

Jeden następny krok: osobna zgoda na dokładną instalację i ten jeden odbiór
lokalny. Odbiór nie obejmuje produkcji, D1 ani dostępu live YouTube.
