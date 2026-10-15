# Obserwacja 24–72 godzin po odbiorze20 kanałów

Ten dokument nie potwierdza upływu czasu obserwacji. Start należy zapisać dopiero
po rzeczywistym zakończeniu MANUAL20. Pierwszy możliwy odbiór24h następuje
24godziny po tym znaczniku; końcowy72h odpowiednio później.

System produkcyjny pracuje niezależnie od Windows: Cloudflare Cron/Queue/D1 oraz
usługi systemd Oracle. Codex nie utworzył osobnej działającej usługi obserwacyjnej
ani automatyzacji. Zbieranie kolejnych raportów operatora wymaga uruchomienia
istniejących narzędzi; nie oznacza to zależności samego pipeline od Windows.

## Zbieranie dowodów

1. Dwa dzienne sloty15:00 i23:00 Europe/Warsaw: odczytać `monitoring_cycles`
   i powiązane `discovery_scans`/`jobs`. PASS wymaga20 rzeczywiście zakończonych
   kontroli z `pages_committed>0`, a nie wyłącznie cursor/utworzenia zadań.
   Przy RSS404/410 raportowaćUNAVAILABLE oraz jawny uploads fallback.
2. Odczytać nowe FETCH_TRANSCRIPT i job_attempts: due_at względem discovered_at,
   rzeczywiste NO_CAPTIONS osobno od technicalfailure, fencing/attempt_count,
   accepted compactsource. Nie uruchamiać dodatkowych pobrań do samej obserwacji.
3. Odczytać transcript_archives i transcript_payload_archives: trwałe IDs, stan
   VERIFIED, hashe, wersje i opóźnienia. Normalna archiwizacja pozostaje wQueue;
   ręcznego payload-dry-run nie planować cyklicznie.
4. Uruchomić istniejący `.local/production-readiness-20261015/final-metrics-readonly.mjs`
   z `BARTOSZ_METRICS_VERSION`, rzeczywistym `BARTOSZ_METRICS_DEPLOY_AT` i unikalnym
   `BARTOSZ_METRICS_OUTPUT`. Raportowaćaccount-wide i project D1 osobno, częściową
   dobę i lag oddzielnie od ekstrapolacji. Nie nadpisywać poprzednichreceipts.
5. Użyć istniejącego bounded `tail-cpu.py` z unikalnym `BARTOSZ_CPU_OUTPUT` w pobliżu
   naturalnego Cron lub rzeczywistego pobrania. Zachować tylko CPU/wallTime,
   pathbezquery, outcome i dokładny scriptVersion. Bez nagłówków/logów/sekretów.
6. Przez istniejącą procedurę SSH odczytać status executora/brokera, NRestarts,
   RAM/CPU, wolny dysk i bezpiecznie filtrowane journal/receipts. Nie odczytywać
   treści cookies/tokenów ani zmieniać sesji YouTube.
7. Drive: odczytaćquota i istniejące receipts. Wybrany ograniczony readback
   przez istniejący OAuth wyłącznie w razie konkretnej niezgodności lub odbioru;
   nie generować nowych uploadów ani powtarzać testu bazowego dostępu ChatGPT.

## Warunki zatrzymania

Niezgodny hash/tekst/ms, utrataaccepted, niepoprawna prywatnośćDrive, AI lub DELETE
włączone, utratafencing, rosnąca kolejka, exceededCpu/1102 albo istotne wyczerpanie
Free wymagają zatrzymania dalszych operacji operatora i diagnozy. Nie usuwać danych,
nie przywracać staregoDBsnapshotu, nie aktywować płatnego planu.

Wersja rollback musi czytać compactv2 i obecne metadaneDrive. Przywrócenie wersji
przez Cloudflare deployment zachowuje addytywny schema i zaakceptowane dane.
Awaryjny LEGACY dla nowych pozyskań jest opisany w głównym raporcie; nie zmieniać
działającego silnika ani sesji. Operacje wykraczające poza istniejąceGO wymagają zgody.

## Odbiór

Rozdzielić DEPLOYED, E2EVERIFIED, kontrolowany odbiórFree, SOAKINPROGRESS i
SOAKPASSED. Pełny PASS24/72h wymaga rzeczywistego upływu czasu i dowodów
z zaplanowanych cykli, zwykłych zadań oraz zużycia konta. Brak nowego filmu
w danym oknie oznacza brak testu nowegoFETCH, a nie jego PASS.

## Godzinowe wznowienie odbioru w Codex — 15.10.2026, 13:55 Warsaw

Utworzono aktywne wznowienie w tym czacie: `bartosz-odbi-r-produkcji-24-72-h`.
Co godzinę zbiera wyłącznie metadane i metryki, bez zmian produkcyjnych, dodatkowych
skanów, pobrań, uploadów, nowych sesji lub DELETE. Zapisano limit 73 wystąpień
oraz zakończenie po odbiorze 72 h. Informuje o istotnym problemie, potrzebnej
czynności właściciela lub udokumentowanym odbiorze 24/72 h; bez rutynowych statusów.
Pierwszego zaplanowanego uruchomienia jeszcze nie potwierdzono.

To aktualizacja wcześniejszej informacji o braku automatyzacji. Pomocniczy monitor
wymaga działającego komputera i lokalnej aplikacji Codex; produkcyjny pipeline
Cloudflare/Oracle nadal pracuje autonomicznie bez Windows. Zgodnie z
[oficjalną dokumentacją OpenAI](https://learn.chatgpt.com/docs/automations?surface=app)
lokalne zadania potrzebują dostępnego projektu i uruchomionej aplikacji.
Dowód: [SOAK_AUTOMATION_RECEIPT.json](SOAK_AUTOMATION_RECEIPT.json).
