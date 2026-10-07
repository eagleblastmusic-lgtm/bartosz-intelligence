# Translation benchmark — procedura CP-6.10

To instrukcja przygotowania rzeczywistej oceny, nie raport PASS. Testy syntetyczne weryfikują harness. Nie zastępują wyników Gemini ani ocen człowieka.

## Przed requestami

Zamroź 24–30 różnych źródeł z dokładnymi SHA źródła i manifestu. Oznacz SHORT/MEDIUM/LONG według zarejestrowanych wcześniej granic korpusu. Uwzględnij EN→PL i inne języki, TECH_AI, GENERAL, ECON_GEO, ASR, NAMES, NUMBERS, NEGATION. Dla części źródeł zaplanuj trzy powtórzenia obu wariantów; dla pozostałych po jednym. Nie usuwaj trudnych ani nieudanych prób po zobaczeniu wyników.

`LabControls` w `packages/core/src/registry/lab.ts` określa dokładne hashe źródeł, promptów, wire/canonical, modele i rewizje, reasoning oraz limit output. PROMPT_AB utrzymuje ten sam model/rewizję; MODEL_AB ten sam prompt i różne modele. Oba utrzymują schema/input/reasoning/output. Bieżący adapter nie obsługuje seed: wpisz `null`, `SEED_UNAVAILABLE`, `PROVIDER_NONDETERMINISM`; MODEL_AB wymaga dodatkowo `MODEL_REASONING_IMPLEMENTATION`. Nie pokazuj drugiego modelu jako dostępnego bez działającego, dopuszczonego adaptera Free.

Requesty wolno wykonywać dopiero przez normalne admission na świeżych oficjalnych obserwacjach quota, aktywnym dopuszczeniu Free i przy wyłączonych paid services. Offline evaluator nie wykonuje żadnych requestów. Prace nad submission/quota/UI Lab są osobną częścią checkpointu.

## Rzeczywiste pliki i formularz

Format `TranslationBenchmark` i `TranslationTrial` znajduje się w `tools/gates/translation-evaluation.ts`. Każda próba zawiera wariant/powtórzenie, SHA request/response/annotations, rzeczywisty request ID, czas startu, latency, trzy identyfikatory quota, provenance i odnośniki do czterech lokalnych plików:

- `source`: JSON `TranslationSource` z dokładnym oryginalnym tekstem, manifestem, językiem i identyfikatorami źródła. Nie nadpisuj timestampów.
- `request`: JSON `{request, prompt_snapshot, purpose, region}`. Request musi być dokładnym wynikiem normalnego `compileTranslation` dla FULL, pustego glossary i kontrolowanej wersji promptu; snapshot schematów zawiera ich hashe. Zapis nie może zawierać kluczy, credentials ani Authorization headers.
- `response`: rzeczywisty kontrakt `AIResponse`, obejmujący raw output, actual provider/model i usage. Brakujące usage pozostaje `null`. Nie zastępuj 503/odmowy/niepełnego wyniku udaną fixture.
- `annotations`: JSON `{source_hash, response_hash, ratings}`. Ratingi muszą być identyczne z formularzem benchmarku. Nie dopisuj fikcyjnych osób ani ocen.

Osoba przygotowująca materiały przydziela losowe, nieujawniające modelu/promptu etykiety próbek. Każdy z dwóch niezależnych ludzi otrzymuje oryginał, dokładne anchory i tłumaczenia w ślepej parze; mapę wariantów przechowuj poza formularzem dla oceniającego. `blind_label` nie może być A/B; identyfikatory obu ludzi muszą być różne. Po ocenie osoba przygotowująca materiały przypisuje ratingi do wariantów. Brak recenzenta pozostawia ratingi niewypełnione.

Każdy rating zawiera `reviewer_id`, `blind_label`, `reviewed_at`, `scores` i `critical_errors`. `scores` to cztery wartości 0–4 albo `null` w kolejności: wierność (40%), liczby/negacje/warunki (25%), kompletność/alignment (20%), naturalność polszczyzny (15%). 0 oznacza niepoprawne, 1 duże błędy, 2 istotne niedostatki, 3 drobne niedostatki, 4 brak zauważonych błędów. `null` oznacza niewykonaną ocenę, nie zero. `critical_errors=null` oznacza niewykonaną ocenę błędów; `[]` potwierdza ich sprawdzenie.

Błędy krytyczne: NEGATION_CHANGED, NUMBER_CHANGED, FABRICATED_FACT, ASR_GUESSED, MISSING_SEGMENT, FABRICATED_TIMESTAMP. Dowolny z nich blokuje wynik kwalifikacyjny, nawet gdy pozostałe pola są idealne lub nieocenione. Zachowaj obie rozbieżne oceny; evaluator raportuje różnice i wymaga przeglądu. Nie uśrednia rozbieżności do PASS.

## Ocena offline

Uruchom `pnpm gate:translation <benchmark.json> <nowy-report.json>`. Raport powstaje wyłącznie pod nową nazwą (`wx`); wcześniejsze FAIL nie są nadpisywane. CLI sprawdza SHA plików, ponownie kompiluje request z rzeczywistego źródła i snapshotów, mapuje raw output tym samym walidatorem/DR co aplikacja oraz wylicza raw/mapped validity, kompletność, missing/duplicates, wire/canonical bytes, rzeczywiste usage, latency i cztery ważone oceny. Nie zawiera tekstów źródłowych ani odpowiedzi/sekretów. Koszt pozostaje UNKNOWN; bytes estimate nie jest dowodem oszczędności quota.

Fixture daje NOT_RUN, brak ocen AWAITING_HUMAN_REVIEW, krytyczny błąd lub walidacja daje FAIL. PASS dotyczy poprawności i wymaganej kompletności tego benchmarku; nie oznacza automatycznej promocji ani nowej eligibility. Raport nie publikuje scope approval. Oceny jakości pozostają jawne, bez wymyślonego progu średniej. Obecny verifier obsługuje pojedyncze rzeczywiste odpowiedzi FULL bez AI repair; repair-assisted lub skomponowane chunk/recovery wymagają osobnych zweryfikowanych receipts przed kwalifikacją, a nie flagi udającej ich weryfikację.
