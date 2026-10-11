# CP-3.13 — procedura ludzkiej oceny

## Osobna decyzja właściciela o publikacji pojedynczej rewizji

Właścicielska akceptacja treści jednego filmu jest zapisywana jako
`owner-result-publication-decision:1`: scope ONE_EDITORIALLY_REVISED_RESULT,
oryginalny run, hash ocenionej rewizji, warunki i dowód ich spełnienia.
Nie wpisujemy fikcyjnego niezależnego recenzenta, labels per element ani
model approval. W przypadku rUhllpnYWR8 właściciel zaakceptował rewizję 3
po dwóch korektach; rewizja 4 i verified prywatny Daily mają oddzielne receipts.
Oryginalny provider/canonical/evidence pozostają immutable; redakcja ma nowy
manifest/hash. Publikacja nie jest dowodem CP-3.13 lub całego modelu.
[Decyzja i procedura publikacji](../../decisions/P0_SUMMARY_QUALITY_2026-10-11.md).

## Niezmieniona procedura kwalifikacji pilota

Anotator: **OWNER_A**. Niezależny recenzent: obecnie niedostępny, **AWAITING_HUMAN_REVIEW**. Decyzja właściciela pozwala kontynuować prace niezależne od tej oceny; nie daje Gate AI PASS ani production quality approval.

Prywatny pakiet `.local/ai-pilot/cp-3.13-selected/corpus.json` zamraża 12 rzeczywistych źródeł przed pilotem AI. Materiały zawierają dokładny SOURCE_ORIGINAL, manifest offsetów i czasów, oryginalny RAW captions, receipt źródła oraz formularze HTML. Publiczny receipt zawiera tylko identyfikatory i hashe. Przypadki bez potwierdzonej authority pozostają w historii puli źródeł; nie są przedstawiane jako gotowy oryginał. To dobór źródeł przed oceną/model generation, nie usuwanie niekorzystnych wyników modelu.

1. Uruchom serwer wyłącznie dla `.local/ai-pilot`, na `127.0.0.1`, i otwórz `cp-3.13-selected/index.html`. Dla każdego filmu przeczytaj źródło oraz w razie potrzeby obejrzyj nagranie. Nie oglądaj odpowiedzi modelu przed zamrożeniem ground truth.
2. W formularzu podaj `OWNER_A`. Własnymi słowami zapisz ważne twierdzenia, zachowując autora, negacje, warunki, liczby, jednostki, horyzont czasowy i dosłowne kwalifikatory. Wybierz dokładne fragmenty wspierające każde twierdzenie. Ciągłe fragmenty tworzą jeden zakres, nieciągłe — osobne zakresy. Formularz oblicza hashe dokładnych cytatów; nie wymyśla timestampów.
3. Zapisz minimum **40 rzeczywistych twierdzeń łącznie dla 12 filmów**. Zalecany rozkład to 4 na film, czyli 48; krótszy film może mieć mniej, jeśli pozostałe pokrywają minimum. Puste pola, automatyczne propozycje i fixture claims nie liczą się do minimum. Pakiet przygotowany przez implementację zawiera **0** ludzkich twierdzeń.
4. Zamroź i pobierz JSON anotacji. Zachowaj pliki prywatnie. Zapisz ich SHA-256 oraz `frozen_at` przed pierwszym pilotowym wywołaniem modelu dla danego źródła. Nie nadpisuj zamrożonych plików po zobaczeniu wyniku. Wcześniejszy techniczny smoke bez takich anotacji nie jest dowodem pilota.
5. Przed każdym rzeczywistym wywołaniem sprawdź świeżą, oficjalną quota projektu i ważny immutable profile. Unknown usage nie jest zerem. Po odpowiedzi zachowaj actual provider response, raw candidate, Core canonical i accounting. FAIL, refusal oraz brak wyniku pozostają w mianowniku; nie twórz fikcyjnego candidate ani token counts.
6. OWNER_A ocenia każdy wyemitowany element canonical, identyfikowany jako `<moduł>:<indeks>`, wskazując `supported`, `anchor_valid` i `severe_hallucination`. Dla każdego zamrożonego ważnego twierdzenia wskaż odpowiadające elementy lub pustą listę. Oceń również pokrycie streszczenia, stance versus usage, dosłowne kwalifikatory predykcji i niejednoznaczność encji. `null` oznacza brak oceny, nie PASS.
7. Przyszły niezależny człowiek z innym pseudonimem sprawdza trudne przypadki: NEGATION, CONDITION, NUMBER, REPORTED_SPEECH, STANCE_USAGE, PREDICTION_HORIZON, ENTITY_AMBIGUITY i ASR_DIFFICULT. Potwierdza wyniki względem dokładnego źródła, dokumentuje rozbieżności i ich rozwiązanie. Nie wpisuj recenzenta ani daty, zanim ten krok rzeczywiście nie nastąpi. AI może pomagać technicznie, ale nie jest ground truth ani niezależnym człowiekiem.
8. Po rzeczywistych ocenach złóż `ai-pilot-review:1` zgodny z `PilotReview`/`PilotFilm` w `tools/gates/ai-pilot-evaluation.ts`. `review-preparation.json` jest pustym arkuszem roboczym, celowo nie jest ukończonym inputem oceny. Uruchom `pnpm gate:ai <review.json> <nowy-score.json>`. CLI sprawdza pliki, identyczność hashy, quote ranges, czasy i actual metadata. Nie wykonuje provider calls ani automatycznego quality promotion.

Niezmienne kryteria limited Stage 03 pilot: co najmniej 12 filmów i 40 ważnych twierdzeń, precision ≥95%, recall ≥85%, anchors 100%, zero severe hallucinations i niezależne sprawdzenie trudnych przypadków. Raport zawiera n/mianowniki i Wilson 95% CI. Pełny Gate AI wymaga co najmniej 30 filmów i 100 twierdzeń; limited pilot go nie zastępuje. Publikacja production approval dotyczy wyłącznie rzeczywiście sprawdzonego scope. Brak niezależnego recenzenta pozostaje AWAITING_HUMAN_REVIEW, a implementacja niezależnych funkcji trwa dalej.

## Aktualizacja 2026-10-11: przyszły standard radiowy

Nowe analysis-quality:3 wyniki oceniamy także pod kątem treściwego, płynnego
polskiego akapitu, zwykle 180–260 słów, bez wypełnienia i utraty późnych tematów.
Liczba słów i format nie zastępują kontroli źródeł, niepewności, warunków,
atrybucji i zakresu czasowego. Szczegóły/Evidence kontrolujemy osobno od narracji.
Nowy quality_scope wymaga własnego live evidence; historical kwalifikacja nie
jest przenoszona. Nie wymagamy ręcznej akceptacji każdego poprawnego wyniku w
zakwalifikowanym zakresie. CP3.13 i inne odroczone odbiory zachowują procedurę
opisaną w tym dokumencie. Akceptacja/publikacja rewizji4 rUhllpnYWR8 pozostaje odrębną decyzją;
jej dokumentu nie przepisujemy dla nowej formy. [Decyzja właściciela](../../decisions/RADIO_NEWS_SUMMARY_2026-10-11.md).
