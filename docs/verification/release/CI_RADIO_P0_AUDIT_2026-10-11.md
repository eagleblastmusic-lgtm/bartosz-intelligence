# CI, radio summary and P0 audit — 2026-10-11

**Zakres zlecenia wykonany technicznie; IMPLEMENTATION COMPLETE NO;
PRODUCTION ACCEPTED NO.** Lokalna weryfikacja i rzeczywiste publiczne CI
przechodzą. Nowy standard radiowy nie ma jeszcze rzeczywistego wyniku Gemini
bez redakcji ani kwalifikacji automatycznego P0. W tym zadaniu wykonano
**0 Gemini requests/model GET, 0 production SQL, 0 Drive requests, 0 production
DELETE i 0 płatnych operacji**. `paid_services_enabled=false`,
`deletion_enabled=0`, `approval_reference=NULL` pozostają wymaganiami.

## Poprawki i rzeczywiste CI

Punkt wejścia to lokalne/zdalne main
`7c61bba806717a2d1e288443b37c04ccc0f34391`. Repo pozostało publiczne.
Nie zresetowano zmian, nie przepisano historii ani ośmiu dotychczasowych tagów.
Logiczne zmiany zapisano i wysłano w trzech commitach:

- `4874f1a`: precyzyjne wyjątki formattera, przenośny kontrakt Prompt Pack,
  bezpieczeństwo workflow i naprawy lokalnych fixture.
- `e547355`: poprawne rozpoznanie aliasów źródłowych, nowa wersja cache
  walidatora i regresje radiowe.
- `e54a7be`: przygotowanie katalogu testowej bazy SQLite w świeżym checkoutcie.

[Pierwszy przebieg 38158452306](https://github.com/eagleblastmusic-lgtm/bartosz-intelligence/actions/runs/38158452306)
zatrzymał się na pięciu plikach wskazanych przez Prettier. Cztery to
historyczne receipts/prerejestracje: otrzymały cztery dokładne wyjątki w
`.prettierignore`; ich SHA przed i po są identyczne. Tylko żywy dokument
`GEMINI_503_P0_2026-10-09.md` sformatowano, bez zmiany znaczenia. Nie wyłączono
formattera dla katalogów dowodów ani całego repo.

Nowy frozen receipt rzeczywistego udanego GitHub run również ma własny
dokładny wyjątek; zachowuje capture timestamp, wynik kroków i hash raw logu.
Nie formatujemy go ponownie po rejestracji.

Kontrakt promptów zakładał istnienie ignorowanego prywatnego `Plan/`.
Teraz każdy runner obowiązkowo porównuje bundle z publiczną, dokładną kopią
samego Master §24: **66940 bytes**, SHA
`f37e621be98cd85293fded035294299b93e21239c40de93075bfc1a9f574a103`.
Pozostają oryginalne piny Master/bundle, dziewięć schematów, sześć promptów
oraz dodatkowe porównanie prywatnego oryginału, kiedy jest dostępny.
Całego prywatnego planu nie opublikowano; fixture nie zastępuje architektury.

Lokalny test cleanup z pełnym backup/restore przekroczył pięciosekundowy
domyślny timeout runnera przy całej suite. Timeout **tego jednego testu**
wynosi teraz 15 s; wszystkie asercje rollback, restart, batch, dedup,
metadanych i restore pozostają. Nie zmieniono produkcyjnych limitów.
Dwa testy GUI miały niekompletny mock `/system/retention`; dodano właściwą
odpowiedź z deletion OFF. Logout, HTTP401, focus i storage są nadal sprawdzane.

[Przebieg 38165259523](https://github.com/eagleblastmusic-lgtm/bartosz-intelligence/actions/runs/38165259523)
potwierdził naprawione formatowanie, typy i build, ale ujawnił brak katalogu
`.local/tests` w świeżym Linux checkoutcie. Fixture tworzy go przed otwarciem
trwałej testowej bazy. Nie pominięto testu wznowienia ani jego asercji.

**Rzeczywisty GitHub Actions PASS**:
[38165715266](https://github.com/eagleblastmusic-lgtm/bartosz-intelligence/actions/runs/38165715266),
SHA **`e54a7be508c1c133c0b2863a772d147e62ef30d6`**. Wszystkie kroki joba
przeszły: instalacja frozen lockfile, ESLint, format, typy, config/migracje/
bundle/validators, build, public-build canary, unit, contracts, Workers/local
D1 oraz browser GUI/responsiveness/axe. Historyczne FAIL zachowano.
To receipt dla sprawdzonej implementacji; kolejne commity dokumentacji
mają własny przebieg widoczny w GitHub Actions.

Workflow ma `contents: read`, `persist-credentials: false`, piny dokładnych
dotychczasowych Actions v4, Node24.21.0/pnpm12.9.1 i timeout15min.
Nie korzysta z produkcyjnych sekretów, `.env`, deployu, remote D1, Drive czy AI.
Canary CI jest syntetyczne; nie zastępuje lokalnego skanu rzeczywistych sekretów.
Nie ma `continue-on-error`, osłabiania asercji ani pomijania suite dla PASS.

## Audyt pełnej ścieżki radiowej

| Granica                    | Rzeczywiste zachowanie i dowód                                                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published Registry         | `registry/store.ts` odczytuje opublikowaną, przypiętą wersję, weryfikuje hash tekstu i schematów. Zachowany verified backup i rzeczywisty wcześniejszy snapshot potwierdzają ECONOMY_ANALYSIS_V1 v2; nie deklarujemy świeżego odczytu produkcyjnego Registry.                                                        |
| Quality policy i compiler  | Do bazowego promptu dołączana jest dokładna `analysis-quality:3`; jej hash wchodzi w compiled context i `quality_scope`. Exact historical policy1/2 oraz pinned jobs nie są przepisywane. Redacted template oddziela bazę, wire schema, source placeholders i politykę.                                              |
| Provider request           | Istniejące limity, model Free, input budget, output4096, source i manifest są przypięte. Aktualna generacja nie została wykonana. `generateContent` jest wyłącznie przygotowanym diagnostic QUALITY_TEST; produkcyjny default Interactions pozostaje.                                                                |
| Parser, mapper i walidacja | Strict JSON/schema/ref checks, source-to-Evidence, canonical `content_pl`, atrybucja i dotychczasowe epistemiczne kontrole zachowane. Placeholder/broken content nie trafia do poprawnej prezentacji. Nazw ASR nie poprawia się przez zgadywanie; approved aliases dotyczą opracowania, nie źródła.                  |
| Radio guards               | Polityka wymaga wiedzy, mechanizmów/liczb/argumentów/ograniczeń stosownie do źródła i późnych tematów. Format, teaser/filler, dosłowne powtórzenia i source-window gaps mogą powodować review. Długość jest wskazówką, nigdy dowodem poprawności.                                                                    |
| Ordinary i chunks          | Chunk otrzymuje swój udział wskazówki długości i lokalny zakres. Merge zachowuje kolejność, globalne refs, kompletność planu i sectional outputs bez dodatkowej syntezy. Final validation sprawdza samo `summary_pl`; key_points nie ukrywają luk.                                                                   |
| Acceptance                 | Review powoduje `AI_OUTPUT_REVIEW_REQUIRED`/BLOCKED przed accepted effects. Source, job, response, usage i recovery zachowane; bez automatycznej regeneracji. Nowe radio receipts mają własny namespace; stary cached quality3 PASS nie omija aktualnego hold.                                                       |
| GUI                        | Wspólne `summaryNarrative()` prezentuje pełne uporządkowane notatki jako akapit, bez parafrazy i obcinania. Tytuł/kanał/status poza narracją; źródła i typed details po rozwinięciu. Klawiatura, deep links, mobile/desktop, densities i axe sprawdzone.                                                             |
| Daily i Drive boundary     | Renderer1.3 zachowuje pełne summary w FULL/COMPACT, metadata i źródła poza narracją, historyczne wersje1.1/1.2 i byte-exact odzyskiwane ITEM blocks. Local integrations sprawdzają stable ID, intent/dedup, hash/version/readback, conflict, retention i restore. Nie wykonano nowego Drive E2E ani zmiany rewizji4. |

Potwierdzony błąd radio guard: case-insensitive regexp traktował rzeczywiste
**S3** i **EV3** jako wire aliasy. Teraz aliasy `s3`/`ev3` są rozpoznawane
zgodnie z ich wielkością liter; kontrola metadata i timestampów pozostaje.
`radio-narrative:2` jest częścią klucza receipt/cache dla policy3.
Regresja seeduje stary immutable cached PASS, po czym aktualny wynik nadal
musi otrzymać review hold, bez acceptance i zapisów Observation.

`summaryNarrative()` łączy notatki i normalizuje whitespace. **Samo to nie
dowodzi płynności, logicznych przejść ani zachowania podmiotu.** Prompt wymaga
kolejnych zdań jednej narracji; exact repeats mają guard, także po merge.
Nie dodano domyślnych łączników, paraprazy, usuwania podobnych zdań z innymi
refs ani kolejnego AI requestu. Semantycznie podobne powtórzenia, sprzeczności
między chunkami i nielogiczne przejścia nadal wymagają oceny rzeczywistego
wyniku. Mechaniczne przepisywanie treści groziłoby utratą źródłowej zgodności.

Coverage to osiem przedziałów **pozycji tekstu**, z pominięciem sparse bins,
nie rozpoznawanie wszystkich tematów. Sam istniejący ref nie dowodzi
entailment twierdzenia. Gęstość informacji, prawdziwość semantyczna i pełne
pokrycie istotnych tematów pozostają **NOT_ASSERTED automatycznie**.
Kontrastowe fixtures sprawdzają właśnie tę granicę: padding210 słów, brak
centralnego faktu oraz zmyślony konkret z istniejącym ref nie otrzymują
fikcyjnego semantic PASS. Foreign refs i źródłowo osłabione/błędne prognozy
są osobnymi kontrolami. Krótkie, treściwe źródło nie jest odrzucane za długość.

## Zachowany rzeczywisty materiał i prezentacja

Offline użyto wszystkich **1071** zachowanych oryginalnych cues rUhllpnYWR8.
Sześć SHA provider/source/canonical/editorial-v4 przed i po jest identycznych.
Pierwotny wynik ma **12 wskazań lokalnych detectorów** i REVIEW_REQUIRED,
w tym brak dwóch późnych przedziałów w samym summary. Nie nadpisano jego
historycznego receipt ani nie uznano każdego wskazania za udowodniony błąd
semantyczny. Właścicielska rewizja4 przechodzi aktualne lokalne checks:
7 notatek → **1 akapit /182 słowa**, **80/80 powiązań Evidence** zachowane.
FULL/COMPACT zachowują akapit; FULL ma zero pominiętych detail units,
COMPACT zgodnie z dotychczasowym zakresem pomija24. To lokalny re-render,
bez nowej redakcji i bez nadpisania prywatnego pliku Drive rewizji4.

Natywne HTML `<details>` jest sprawdzone w naszym GUI. GitHub opisuje
[obsługę zwijanych sekcji Markdown](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections).
Surowe Markdown może pokazywać znaczniki. **Zwijanie w natywnym podglądzie
Google Drive: NOT_ASSERTED**; nie wykonano nowego odczytu tego podglądu.
Nie opublikowano prywatnych screenshotów ani treści źródłowej.

## Testy i bezpieczeństwo

| Środowisko                | Unit | Contract | Workers/local D1 | GUI | Razem PASS |  FAIL | Platform SKIP |
| ------------------------- | ---: | -------: | ---------------: | --: | ---------: | ----: | ------------: |
| Lokalny Windows           |  462 |       97 |              261 |  29 |    **849** | **0** |             1 |
| Rzeczywisty GitHub Ubuntu |  461 |       97 |              261 |  29 |    **848** | **0** |             2 |

To te same przypadki w dwóch środowiskach; **nie sumujemy 849+848**.
Lokalne29 GUI to27 początkowo zaliczonych i2 poprawione w targeted rerun;
trzeci powtórzony test session i inne subsets nie zwiększają liczby.
Windows pomija jeden non-Windows refusal test; Linux uruchamia go, a pomija
dwa testy Windows ACL. Testy syntetyczne science/tech/news/conversation,
short/sparse/long, recovery/legacy/export i public safety pozostają jawnie
syntetyczne. Zachowane źródło użyto osobno offline, bez provider generation.
Automatyczne axe nie jest odbiorem screen-reader.

Typecheck/ESLint/format/build/config/migration001–039/immutable bundle/
standalone validators PASS. Public web build z rzeczywistymi lokalnymi
secret inputs: **4 files /413922 bytes /0 findings**. Pełna osiągalna historia
na code SHAe54a7be: **254 commits /2504 blobs /2758 scanned objects /
54225767 bytes /0 findings /0 private paths**. Scanner obejmuje configured
secret variants/owner subject, credential formats, commit messages i tagi;
nie zapisuje dopasowanych wartości. Nie dowodzi braku dowolnego nieznanego
sekretu ani wszystkich klas prywatnych danych. `.env`, `.dev.vars`, `.local`,
`.tools`, pełny `Plan/` i artefakty przeglądarki są ignorowane. Public fixture
zawiera wyłącznie już używane specyfikacje promptów/schematów. Nie wykryto
ujawnienia wymagającego rotacji lub zmiany publicznej historii.

Delta dokumentacji/config obejmująca15 publicznych plików oraz dwa prywatne
logi CI została dodatkowo przeskanowana:404016 bytes/0 findings; logów nie
publikujemy. Nowy agregat security wskazuje dokładny zakres tej obserwacji,
a finalna historia po commit otrzymuje niezależny ponowny scan przed push.

## Produkcja i następny rzeczywisty test

Świeży odczyt **18:54:21 UTC** potwierdza nadal kod **6089f83**, Worker
**224ba7ff-a4ab-47ff-8cc1-70aadb2d91b1 /100%**, health200 i3 serwowane
assets z identycznym SHA. Schema39 pochodzi z istniejącego receipt dla tej
samej wersji; nie wykonano nowego SQL probe. **Poprawki e547355 nie zostały
wdrożone**. W tym audycie nie wykonano deployu; poprzedni recovery version
59fb3c34… zachowuje wcześniejszy dowód. Backup fbf01a86… ma identyczny SHA
i zgodność restore; podczas odczytu miał około22h. To sprawdzenie zachowanej
kopii, nie nowe zapewnienie aktualnego produkcyjnego RPO. Brak migracji lub
produkcyjnej data delta tego zadania nie uzasadnia capture tylko dla PASS.

W trakcie pracy w repo pojawił się niezależny receipt backupu
`docs/verification/backup/2026-10-11T19-08-25.716Z.json`, backup e9e596ad….
Nie został utworzony przez narzędzia tego audytu: zachowano jego bajty i
pozostawiono poza tym commitem. Jego independent medium i RPO/RTO pozostają
niezakwalifikowane; nie doliczamy go do wyników ani operacji tego zadania.

[Propozycja jednego QUALITY_TEST](../gate-ai/radio-quality-test-proposal-2026-10-11.json)
ma **AWAITING_OWNER_APPROVAL / NOT_GRANTED**. Zachowana kompletna transkrypcja,
ECONOMYv2 +quality3, rzeczywisty offline compiled SHA/schemas/quality_scope,
redacted template, input estimate83800 (konserwatywny UTF8 byte bound,
nie zmierzone zużycie providera), output max4096 i exact response retention
są przygotowane. Historyczne23714 input/3261 output dotyczy wcześniejszego
promptu; nie jest aktualną quota ani prognozą tego testu.

Potrzebna jest **nowa zgoda na dokładnie jeden QUALITY_TEST POST przez
generateContent dla rUhllpnYWR8, gemini-3.8-flash Free oraz niezbędny świeży
preflight model/capabilities/Free/quota**. Przed nim ponownie sprawdzamy
current Published Registry i piny. Unknown usage nie oznacza zera. Jeden
durable permit, bez retry/fallbacku/syntezy/zmiany modelu; po błędzie zachowujemy
job/raw/accounting. Oryginalna odpowiedź, byte count/SHA/readback i usage są
oddzielne od walidacji, canonical i renderera. Kryteria treści obejmują
informacyjność, cały materiał, atrybucję, uncertainty/time scope, polszczyznę,
ciągłość narracji i odczyt na głos. Nie ma zgody na publikację, automatyczny
P0, model qualification ani CP-3.13 na podstawie jednego wyniku.

Priorytety dalszego P0:

1. Wdrożyć przetestowany patch radio guard/cache w istniejącym kontrolowanym
   mechanizmie, z odczytem deployment i recovery; bez nowej migracji/backup
   tylko dla powtórzenia PASS.
2. Po osobnej zgodzie wykonać przygotowaną jedną próbę; odróżnić transport503,
   request/schema, model content, walidator i renderer. Real policy3 quality
   pozostaje nieznana; previous successful REST output nie dowodzi
   niezawodności Interactions ani usunięcia przyczyny503.
3. Zakwalifikować rzeczywisty aktywny model/profile/prompt/endpoint scope oraz
   accepted-run → verified Daily z retry/dedup/recovery. Jedna QUALITY_TEST
   jest diagnostyką; nie omija formalnej jakości ani nie wymaga ręcznej
   akceptacji każdego późniejszego poprawnego filmu. Wyniki z hold pozostają
   do przeglądu, źródła i jobs nie giną.
4. Dopiero po stabilnym automatycznym P0 aktywować etapowo approved staged19
   new-only, monitorować quota/queue/CPU i zebrać rzeczywiste Gate C capacity.
5. Domknąć brakujące aktualne kryteria Gate R/D i odbiory Stage07/08,
   korzystając z dotychczasowych receipts bez powtarzania ukończonych canary.
   CP-3.13 AWAITING_HUMAN_REVIEW i screen-reader NOT_RUN/DEFERRED pozostają;
   Gate C NOT_YET_MATURE, full R/D NOT_ACCEPTED. Formalne historyczne
   R8/10 i D-export6/13 nie są przepinane na nowy kod.

Ciężkie dane D1 nadal kwalifikują się do cleanup dopiero po verified summary
i dostępnej pełnej transkrypcji, późniejszej weryfikacji +7d, minimalnych
metadanych, braku pending dependencies i holds. Pierwsze rzeczywiste
usunięcie pozostaje osobną decyzją właściciela. Obecne zlecenie nie aktywuje
AI, staged channels, cleanup ani płatności.

Dowody: [local regressions](ci-radio-regression-2026-10-11.json),
[actual CI](ci-radio-github-actions-2026-10-11.json),
[public security](ci-radio-public-repository-security-2026-10-11.json),
[source pins and rendering](../gate-ai/radio-source-audit-2026-10-11.json),
[compiled template](../gate-ai/RADIO_COMPILED_INSTRUCTIONS_2026-10-11.md),
[production baseline](../deployment/ci-radio-baseline-2026-10-11.json).
