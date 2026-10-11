# Domyślny standard radiowy — decyzja właściciela 2026-10-11

Właściciel zlecił FINAL RADIO NEWS SUMMARY STANDARD: przyszłe polskie
streszczenie ma przekazywać wiedzę w jednym płynnym akapicie, zwykle 180–260
słów, do 300–350 dla bogatego źródła i krócej dla ubogiego. Liczba słów jest
wskazówką; nie uzasadnia wypełniaczy, skracania ważnych tematów ani akceptacji.
Każde zdanie powinno wnosić konkret wsparty źródłem. Zależnie od materiału
obejmujemy mechanizmy, liczby, argumenty, przykłady, zastosowania i ograniczenia.
Ważne późne tematy mają równą wagę. Atrybucja, niepewność, warunki i zakres
czasowy pozostają w narracji tam, gdzie są potrzebne. Bez list, śródtytułów,
linków, timestampów, technicznych ID, zapowiedzi filmu i sensacyjnych formułek.

Ta decyzja zastępuje domyślną wielosekcyjną prezentację streszczenia, nie
Drive-only, siedmiodniową retencję, oryginalne transkrypcje ani zabezpieczenia
P0. Film nadal kończy się dopiero po zweryfikowanym zapisie podsumowania na
Drive. Nie zmieniamy dawnych checkpointów na FAIL z powodu zmiany produktu.

## Minimalna zmiana istniejącego rozwiązania

| Obszar              | Obowiązujące wykonanie                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry            | Nowe analysis snapshots Economy/Full/Custom otrzymują wspólną `analysis-quality:3`. Polityka i SHA wiążą prompt/context/quality_scope. Nie nadpisujemy Master bundle ani wersji promptów. Dokładne historyczne polityki 1/2 nadal są czytelne.                                                                                                                         |
| Canonical / wire    | Bez migracji i zmiany schema. `summary_pl` zachowuje uporządkowane `text_pl` i lokalne refs; kolejne notatki są zdaniami jednego akapitu. Claims, predictions, key_points, provenance i Evidence pozostają odrębne.                                                                                                                                                    |
| Długie źródła       | Każda część otrzymuje numer/liczbę części i proporcjonalną wskazówkę długości. Plan rezerwuje 512 szacowanych bajtów na te metadane, a rzeczywisty request nadal sprawdza pełną pojemność kontekstu. Merge nie obcina tekstu i nie uruchamia dodatkowej syntezy AI. Długość/płynność realnego merge wymaga kwalifikacji; nie gwarantujemy twardego limitu 350 słów.    |
| Walidacja           | Dla nowych policy3 sprawdzamy listy/Markdown/linki/timestampy/rozpoznane techniczne ID, znane zapowiedzi i wypełniacze oraz dosłowne powtórzenia zdań. Zachowujemy dotychczasowe kontrole źródeł, atrybucji, zapewnień, dat i zastrzeżeń. Przy wybranym summary pokrycie przedziałów musi być w samym summary, nie tylko key_points.                                   |
| Holds               | Krytyczny wynik trafia do `AI_OUTPUT_REVIEW_REQUIRED`, bez accepted effects/publikacji/automatycznej regeneracji. Validation3 ma odrębny cache dla nowych snapshotów. Poprawny wynik w zakwalifikowanym zakresie nadal przyjmowany jest automatycznie, bez odbioru każdego filmu.                                                                                      |
| GUI                 | Dziennik i szczegóły pokazują jeden pełny akapit bez skracania. Źródła/notatki/key_points/typed records są w zamkniętej sekcji szczegółów. Klawiatura i deep links do Observation otwierają ją przed fokusem. Metadane i linki archiwum pozostają poza akapitem.                                                                                                       |
| Daily               | Renderer1.3 daje jeden akapit na film i źródła poza nim. COMPACT/FULL mają warstwę szczegółów w osobnym `<details>`; FULL zachowuje kompletny dotychczasowy materiał recovery/Evidence. Znaczniki zwijają treść w zgodnych rendererach Markdown/HTML; surowy podgląd Markdown może pokazać znaczniki. Nie deklarujemy testu natywnego podglądu Drive dla nowego pliku. |
| Zgodność / recovery | Envelopes1.1/1.2/1.3 są czytelne. Historyczny blok po cleanup jest przenoszony bajt w bajt. Reserved ID, intent, conditional update, conflict, SHA/version/readback i wymogi retencji pozostają. Nie wykonano zapisu do istniejących plików Drive ani nowego cleanup.                                                                                                  |
| Rewizja4            | Właścicielski dokument rUhllpnYWR8, jego ID, canonical, raw output, source i evidence pozostają bez zmian. Lokalny podgląd jest wyłącznie projekcją, nie nową rewizją redakcyjną ani publikacją.                                                                                                                                                                       |

Detektory są konserwatywnymi heurystykami, nie pełną kontrolą prawdziwości,
entailmentu, gęstości informacji, języka czy wszystkich tematów. Pokrycie
ośmiu przedziałów jest kontrolą strukturalną, nie dowodem znaczenia każdej
parafrazy. Word count nie blokuje ubogich źródeł ani nie dopuszcza bogatego
tekstu samodzielnie. `semantic_verification=NOT_ASSERTED` i
`information_density=NOT_ASSERTED` pozostają jawne. Nowego, zbyt szerokiego
sprawdzania każdego „if” w obszernych refs notatek nie włączono; dotychczasowy
typed condition guard pozostaje. Wstępny diagnostyczny receipt zachowano
obok wyniku końcowego, bez przypisywania jego wskazań błędowi modelu.

## Rewizja wymagań planu i odbioru

Stage03: generowanie i walidacja mają wspólny standard, zachowują poprawność
źródłową; realne wyniki nowego promptu nadal wymagają osobnej kwalifikacji.
Stage04: domyślny Dziennik/Item to jeden akapit i dostępna warstwa dowodowa.
Stage07/CP7.4: Daily musi zachować akapit, cały materiał wybranego trybu i
bezpieczny eksport. Stage08: regresje oraz security/build przed deployem;
test formatowania nie zastępuje live E2E, oceny semantycznej i niezawodności.

Gate AI i CP3.13 nie otrzymują PASS. Nowy quality_scope nie dziedziczy
historycznej kwalifikacji promptu. Pending pinned jobs nie są masowo
przepinane ani regenerowane. Gate C/R/D oraz pozostałe odbiory zachowują
rzeczywisty status; starych receipts nie przypinamy do nowego wdrożenia.
`paid_services_enabled=false`, deletion_enabled=0, approval_reference=NULL.
Nie wykonujemy nowych Gemini/model GET, zmiany modelu/endpointu ani płatności.

## Weryfikacja i dalszy P0

[Końcowa projekcja rzeczywistego materiału](../verification/gate-ai/radio-summary-legacy-final-2026-10-11.json):
7 notatek → 1 akapit, 182 słowa, 80/80 źródłowych powiązań, identyczne SHA
oryginałów, zero provider/Drive/production SQL. To PASS prezentacji i lokalnych
reguł, nie nowa ocena semantyczna modelu. Syntetyczne golden cases obejmują
naukę, technikę, wiadomości, rozmowę i długie źródło; testy słów 40/210/320/400
są tylko pomiarem długości, nie przykładami jakościowej generacji.

[Przygotowanie kolejnej kwalifikacji offline](../verification/gate-ai/radio-summary-live-preparation-2026-10-11.json)
zachowuje 1071 cues, istniejący model i schemas, nowy prompt SHA/scope.
Nie jest zgodą na wywołanie; cached profile nie daje live admission. Dalsza
próba wymaga osobnej zgody i świeżego Free/quota/preflight, oddzielnego
QUALITY_TEST i zachowania surowej odpowiedzi. Jeden smoke nie zastępuje
kwalifikacji modelu/CP3.13/automatycznego P0.

Wynik regresji i wdrożenia oraz otwarte kryteria są w istniejącym
[RELEASE_READINESS_REPORT](../../RELEASE_READINESS_REPORT.md).
