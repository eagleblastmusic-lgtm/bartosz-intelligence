# Raporty dzienne i Radio — uruchomienie oraz monitoring

**Nie włączaj obecnie produkcyjnego workflow.** Kod i lokalne fixture’y są
zweryfikowane; pełny zdalny Transcript Engine pozostaje BLOCKED, foldery mają
publiczny dostęp przez link, a aplikacyjny OAuth nie może ich odczytać.
[Audyt i koszty](../decisions/CLOUDFLARE_TRANSCRIPT_ENGINE_2026-10-12.md),
[wynik wykonania](../verification/daily-workflow/IMPLEMENTATION_REPORT_2026-10-12.md).
Nie zakupiono żadnej usługi i nie zastosowano migracji produkcyjnej.

## Bramki przed aktywacją

1. Właściciel obu kanonicznych folderów otwiera „Udostępnij” i zmienia
   „Dostęp ogólny” z „Każda osoba mająca link” na „Ograniczony”. Sprawdza także
   wszystkie uprawnienia bezpośrednie i dziedziczone. Aplikacja wymaga prywatnego
   dostępu tylko właściciela; nie zmienia uprawnień automatycznie. Obecnych danych
   nie usuwa się ani nie migruje destrukcyjnie. W tej pracy jedynie odczytano
   rzeczywistą konfigurację, nie dokonano korekty.
2. Właściciel autoryzuje **aplikację Bartosz Intelligence**, niezależnie od
   połączenia Drive z ChatGPT, do tych konkretnych folderów i plików. Aktualny
   `drive.file` zwrócił DRIVE_NOT_FOUND dla obu rootów. Samo wpisanie ID folderu
   lub otwarcie go w przeglądarce nie daje aplikacji uprawnienia. Preferowany
   oficjalny grant per-file przez Google Picker wymaga konfiguracji Google
   Picker oraz jawnego wyboru właściciela; taki ekran nie jest obecnie wdrożony.
   Nie rozszerzono scope do całego Drive. Jeżeli alternatywą ma być szerszy
   scope, potrzebna jest świadoma decyzja właściciela i osobna implementacja
   consent flow. Dostęp do istniejących podfolderów i dokumentów utworzonych
   przez innego klienta, w tym ChatGPT, trzeba potwierdzić osobno; nie zakładać
   dziedziczenia aplikacyjnego grantu z folderu.
3. Jeśli potrzebny jest inbox, właściciel tworzy prywatny folder
   „Bartosz Intelligence — Inbox”, zapisuje jego dokładne ID i autoryzuje oba
   klienty do właściwych plików. Native Docs w niezatwierdzonym rodzicu nie
   zostanie przyjęty. Nie ma operacji obchodzącej brak uprawnień do przeniesienia.
4. Ponowić read-only audyt z istniejącym OAuth; wymagane są rzeczywiste
   permissions owner-only, możliwość tworzenia dzieci, nie-trashed metadata
   i readback właściwych obiektów. Przykład z przypiętym Node/pnpm:

   ```powershell
   pnpm exec tsx --env-file-if-exists=.env tools/deployment/daily-readonly-audit.ts --read-only
   ```

   Narzędzie odczytuje istniejące sekrety wyłącznie w pamięci, nie zapisuje
   tokenów w evidence, nie aktualizuje DB i nie tworzy plików w Drive. Receipt
   z 12.10.2026 trzeba zachować, a kolejny odczyt utrwalić jako nowy dowód.

5. Zdalny dostawca musi przejść rzeczywisty test na Cloudflare Free: pełne
   segmenty i ostatni fragment, raw/source SHA, brak atestacji/IP/CAPTCHA
   obejść, pełny zapis i readback Drive, P99 całej pracy CPU ≤8 ms, poprawny
   stan po restartach. Obecny anonymous adapter ma free_eligibility=false;
   nie wolno zmienić tego na true na podstawie samych fixture’ów. Oficjalny
   REST adapter nadaje się wyłącznie do filmów z prawem edycji i wymaga
   dodatkowego autoryzowanego YouTube OAuth. Nie kwalifikuje cudzych kanałów.
6. Potwierdzić Workers Free Active, rzeczywiste wspólne użycie D1/Queues,
   quota Google projektu i wolne miejsce Drive. Brak/stare pomiary wstrzymują
   admission. Nie aktywować billing, R2, Containers, proxy ani modelu API.
   Samo ograniczenie 35 Drive requests/tick nie jest pomiarem całego konta.
7. Właściciel zatwierdza PR i konkretny plan wdrożenia, istniejące backup/recovery
   oraz produkcyjne bramki repozytorium. Dopiero wtedy można zastosować 040
   przez istniejący deployment runner i wdrożyć kod. Nie uruchamiać fixture
   konfiguracji `apps/api/wrangler.jsonc` w produkcji. Status bieżący: PARTIAL;
   automatyczny collector/dispatcher kwalifikowanego silnika cloud nie jest
   aktywny. Flagę REMOTE_CAPTIONS_ENABLED należy traktować jako bramkę
   akceptacji wersji providera, nie jako uruchomienie executora.

## Konfiguracja przygotowanego workflow

Wymaga wdrożonej migracji 040 oraz wcześniejszych bramek. Istniejące secrets
Cloudflare — Google OAuth client, encrypted Drive wrapping key i scoped
DRIVE_EXPORT worker credential — pozostają poza Git. Nie kopiować ich do
raportów, CLI arguments ani testowych środowisk. Cron pozostaje co pięć minut.

Nowe flagi środowiska są domyślnie nieobecne/OFF:

- `DAILY_REPORTS_ENABLED=true` dopuszcza zaplanowany tick archiwizacji/importu;
- `REMOTE_CAPTIONS_ENABLED=true` dopuszcza zaakceptowanie oficjalnego native
  captions providera; nie kwalifikuje eksperymentalnego web adaptera.

W prywatnej sesji właściciela `GET /api/v1/daily/reports/settings` pokazuje
ustawienia. `POST /api/v1/daily/reports/settings` wymaga standardowej sesji,
same-origin oraz istniejącego CSRF tokenu aplikacji, z JSON:

```json
{
  "connection_id": "ID_ISTNIEJĄCEGO_POŁĄCZENIA_DRIVE",
  "staging_folder_id": "ID_ZATWIERDZONEGO_PRIVATE_INBOX",
  "enabled": true
}
```

`staging_folder_id` może być JSON null dla bezpośredniego zapisu. Rooty są
kanoniczne i nie są ustawiane przez klienta. Configure wykonuje prawdziwy audyt
przed aktywacją; 403/404 nie wolno traktować jako sukcesu. Zmiana connection lub
inboxu po pierwszej konfiguracji wymaga kontrolowanej zmiany, nie resetu danych.
Nowe materiały są enrollowane dopiero od konfiguracji; nie przenosimy historii
według dat publikacji. Data jest przypisana raz przy zatwierdzeniu pełnego source.

Do ręcznego uruchomienia jednego bounded ticku służy `POST .../sync` z `{}`.
Zadanie jest trwałe w D1: jedna próba source, jeden manifest i jeden candidate
w ticku, lease/fencing, max osiem prób, backoff do godziny. Przekroczenie
lokalnego budżetu Drive daje WAIT_NEXT_TICK, bez zużycia próby jako błędu.
Nie równoleglić tych wywołań. Utrata prywatności lub dostępu do rootu daje
PERMISSION_HOLD i wyłącza ustawienie; ponowna aktywacja wymaga audytu właściciela.

## Pliki i zamknięcie dnia

```text
Transkrypcje / 2026 / Październik / 11 / rUhllpnYWR8.md
Transkrypcje / 2026 / Październik / 11 / _manifest.md
Streszczenia / 2026 / Październik / 11 / 2026-10-11.md
```

Nie zapisujemy skróconego source. Zapis kończy się dopiero po kontrolnym odczycie
SHA wszystkich bytes i rzeczywistego rodzica/version. Reserved file ID jest
zapisywane przed POST; po timeout kolejne próby rozpoznają ten sam obiekt.
Nie nadpisujemy obcej wersji ani poprawnego COMPLETE. Backup zawiera siedem
nowych tabel; restore historycznych schematów 35–39 jest kompatybilny,
natomiast aktywacja i lease zostają wyzerowane do bezpiecznego stanu.

Dzień zamyka się na logicznej granicy północy Europe/Warsaw; tick materializuje
manifest w następnym dostępnym slocie, zwykle do pięciu minut. Dni DST mają
23/25 godzin. Source zatwierdzony po północy należy do nowego dnia. Source
partial nie wchodzi do zbioru jako READY. Opóźniony Drive zapis wcześniej
zatwierdzonego source pozostaje w jego pierwotnej dacie jako PENDING.
Zmieniona gotowość oznacza nowy digest manifestu przed COMPLETE. Nie wolno
przyjąć raportu z digestem starszej wersji. Po COMPLETE manifest jest zamrożony.

## Ręczne utworzenie i weryfikacja ChatGPT Tasks

[Pełny prompt do wklejenia](CHATGPT_DAILY_TASK_PROMPT_PL.md) korzysta z dwóch
kanonicznych rootów i nie wymaga API generatora.

1. W ChatGPT **web** otworzyć zwykłą rozmowę i potwierdzić właściwe połączenie
   Google Drive. Test odczytu pełnego manifestu i końcowego source ma używać
   rzeczywistych prywatnych plików po naprawie uprawnień. Połączenie z Drive
   w Bartosz Intelligence jest oddzielne.
2. Wkleić całą treść promptu poniżej separatora. Sprawdzić utworzoną kartę
   zadania oraz stronę zarządzania Tasks/Automations: codziennie 08:00,
   Europe/Warsaw. Nie utrwalać cron jako UTC+1 albo UTC+2. Jeśli karta nie
   potwierdza harmonogramu, nie twierdzić, że zadanie istnieje.
3. Wykonać kontrolne „Run now” jeśli interfejs je udostępnia, albo uzgodnione
   jednorazowe uruchomienie z tym samym promptem i datą. Zweryfikować cały zbiór
   IDs, pełne odczyty, jeden dokument, liczniki i końcowe zastrzeżenia. Jeśli
   brakuje zdolności Drive write w zadaniu, zapisać rzeczywiste ograniczenie;
   brak zapisu nie uruchamia płatnego AI jako fallback.
4. Bezpośredni `.md` musi mieć rzeczywisty format text/markdown i rodzica
   docelowego folderu. Natywny Docs ma nazwę `BI-Daily-RRRR-MM-DD` w
   zatwierdzonym inboxie lub w folderze docelowym; eksport text/plain zachowuje
   widoczne markers/JSON. Aplikacja tworzy z niego prawdziwy Markdown, bez
   przenoszenia i usuwania oryginału. Potwierdzić, że aplikacja widzi konkretny
   file ID; dokument utworzony przez innego klienta może wymagać osobnego grantu.
5. Automatic discovery skanuje dokładne nazwy w zatwierdzonym inboxie i
   katalogu dziennym; rotuje daty, aby brak starych raportów nie blokował nowych.
   W razie potrzeby właściciel rejestruje `POST .../candidates`:

   ```json
   { "file_id": "ID_RZECZYWISTEGO_PLIKU", "material_date": "2026-10-11" }
   ```

   Nie oznacza to zatwierdzenia treści — parser/readback muszą ją przyjąć.

6. Otworzyć `/daily/2026-10-11?view=reports` i endpoint daty. COMPLETE
   wymaga readback canonical `.md`, wszystkich IDs i zerowego skipped_count;
   PARTIAL pokazuje jawne pominięcia. Sprawdzić każdy link i rzeczywistą
   lokalizację w Drive. Do potwierdzenia semantycznej jakości nadal potrzebny
   jest przegląd człowieka: parser potwierdza strukturę/rozliczenie, nie dowodzi
   sam, że ChatGPT przeczytał całe źródła lub nie popełnił błędu merytorycznego.
7. Dopiero po udanym rzeczywistym source→Drive→Tasks→canonical readback,
   ponowieniu i obserwacji po wyłączeniu lokalnego executora można zaliczyć
   produkcyjną automatyzację. W tej pracy zadania nie utworzono ani nie włączono.

Oficjalne [ChatGPT automations](https://learn.chatgpt.com/docs/automations)
rozróżniają cloud scheduled task i lokalne zadanie desktopowe wymagające
włączonego komputera. Nie używamy automatyzacji Codex desktop jako zastępstwa
ChatGPT Tasks. Nie ma tu twierdzenia o dostępnym publicznym REST API do
konfiguracji osobistego harmonogramu Tasks.

## Brakujący, częściowy lub zmieniony raport

- MISSING/WAITING_FILES: odczytać pending/missing IDs i stan źródeł; nie generować
  streszczeń z niepełnych plików. Nie zmieniać daty dawniej zatwierdzonego source.
- PARTIAL: poprawić **ten sam** native Docs lub dostarczyć kontrolowany candidate
  z aktualnym digestem, pozostawiając nieprzeczytane źródła UNPROCESSED. Wersja
  dokumentu requeue’uje import; jedna kanoniczna `.md` jest aktualizowana CAS.
- REJECTED/CONFLICT: sprawdzić dokładny kod przyczyny w daily_report_inbox lub
  daily_drive_files, rzeczywiste permissions/parent/hash. Nie resetować receipt
  ani usuwać remote file dla pozornego sukcesu. COMPLETE jest chroniony przed
  inną treścią; świadoma korekta kompletnego raportu wymaga oddzielnej procedury.
- INTEGRITY_HOLD: canonical został zmieniony, przeniesiony, usunięty albo
  utracono dostęp/prywatność. Wyświetlany cache jest archiwalny; nie służy jako
  potwierdzenie poprawnego bieżącego Drive. Po restore/configure wymagany jest
  ponowny rzeczywisty audyt i metadata/readback verification.

## Radio

Istniejących instrukcji projektu „Bartosz Intelligence — Radio” nie zmieniono.
Użytkownik ręcznie tworzy tam nowy czat, ręcznie włącza Live i mówi „Cześć”.
Przy poprawnym dostępie i aktualnym raporcie ChatGPT czyta raport poprzedniego
dnia z Drive i rozpoczyna audycję zgodnie z istniejącymi instrukcjami projektu,
bez dodatkowego „Jestem gotowy” albo „Zaczynaj”. Może wracać do dokumentu przy
pytaniach; pamięć długoterminowa nie zastępuje pełnego raportu. Jeśli raportu
brakuje lub jest częściowy, ma to jasno powiedzieć. Nie wdrożono automatycznych
nowych czatów, sterowania UI ChatGPT ani automatycznego Live.
Odsłuch rzeczywistego nowego raportu pozostaje PENDING_OWNER_ACTION.

## Monitoring i zero kosztów

UI odświeża odczyt co 30 sekund przy widocznym oknie. API jest owner-only,
no-store; writes wymagają sesji/CSRF. `/daily?view=reports` korzysta z dotychczasowego
Daily i nawigatora, legacy tryb pozostaje dostępny. Stan w D1 pokazuje
attempts/due/reason, manifest i readback receipt. Logi nie zawierają tokenów,
podpisanych caption URLs ani treści transkrypcji.

Sprawdzać account Workers/D1/Queues usage, 403/429, rosnące due/age, najstarszy
niezamknięty dzień, brak raportu po 08:00 i aktualność prywatnych folderów.
Przy 80%/nieznanej telemetrii nowy cloud runner wstrzymuje admission. Pełny
pomiar musi obejmować inne aplikacje konta i quota reset osobny od daty raportu.
Nie zwiększać limitów przez aktywację Paid. Aktualnie zakwalifikowana pojemność
pełnych transkrypcji cloud wynosi **0/dzień**; nie obiecujemy 288 sukcesów
tylko dlatego, że istnieje tyle slotów cron.

PoC nie uruchamia się cyklicznie ani bez sprawdzenia planu:

```powershell
pnpm exec node tools/probes/run-cloud-transcript.mjs --verified-free-preview
```

Ma odizolowany token, jeden autoryzowany film, no production bindings/cron,
bounded requests i zakończenie preview. Flagę wolno podać dopiero po rzeczywistym
potwierdzeniu planu Free; nie jest automatyczną kontrolą billing. Token/raw
pozostają w ignorowanej `.local/`, publiczne evidence nie zawiera źródła.
Nie powtarzać PoC dla tej samej trwałej odmowy bez konkretnej zmiany źródła
lub kwalifikowanej metody. Ostatni rzeczywisty wynik: PROOF_OF_ORIGIN_REQUIRED.
