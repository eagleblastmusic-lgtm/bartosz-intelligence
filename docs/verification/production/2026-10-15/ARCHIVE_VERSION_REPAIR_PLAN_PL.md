# Naprawa uzgadniania wersji technicznego archiwum — 15.10.2026

Właściciel zatwierdził naprawę po opisaniu rzeczywistej rozbieżności: „napraw”,
„kontynuuj aż będzie wszystko działać”. Zapis: OWNER_ARCHIVE_REPAIR_AUTHORIZATION.json.
Wcześniejszy FAIL pozostaje w REPAIR_CANARY_INTEGRITY.json. Nie aktywowano 19 kanałów.

Problem: techniczny JSON oraz Markdown otrzymały Drive version=2 po zapisaniu
receipts version=1. Hash obu plików jest identyczny, prywatność i wszystkie
226 cue/ms potwierdzone. Przyczyny zewnętrznego przyrostu wersji nie przypisujemy
konkretnemu aktorowi bez dowodów. Produkcyjny czytnik techniczny odrzucał każdy
przyrost wersji mimo stabilnego odczytu i zgodnych bajtów. Markdown ma już
bezpieczny refreshVerifiedReadback; techniczny JSON nie miał odpowiednika.

Zmiana ograniczona do packages/core/src/transcript/payload-archive.ts i
apps/api/src/artifact-repository.ts, z testami transcript-payload-version.spec.ts:

- Weryfikacja dwóch identycznych wersji otaczających odczyt, prywatności, MIME,
  rodziców, appProperties, hasha całego JSON oraz każdego oryginalnego chunka.
- Dopiero po pełnym dowodzie monotoniczny przyrost wersji można zapisać CAS w D1.
  Owner/DRIVE_EXPORT wymagany; ponowne sprawdzenie worker credential. Aktywny
  eviction permit, pruning, backup barrier lub zmiana receipt blokują operację.
- Nie zmieniamy verified_at, accepted outcomes, hashy, identyfikatorów ani payloadów.
  Nie wykonujemy zapisu do Drive, DELETE ani kolejnego pozyskania YouTube.
- Resolver artefaktów wykorzystuje już zweryfikowany exporter tego samego ownera;
  pierwotna kontrola dostępu do materiału pozostaje przed resolverem.

Przed deployem: świeży backup z izolowanym restore; pełne testy Workers/D1,
typecheck/lint/build; zapis hashy konkretnego pakietu; zachowanie Workera 622b952d
jako kompatybilnego rollbacku. Brak migracji, brak zmiany executora Oracle.
Po deployem: uzgodnienie Markdown istniejącym readbackiem, rzeczywisty Worker
POST /api/system/retention/payload-dry-run, niezależny ponowny readback obu plików,
porównanie oryginalnych cue/hash/ms i historii. Dry-run nigdy nie włącza kasowania.
Dopiero pełny PASS oraz odbiór aktualnych limitów otwierają wcześniejszy plan
19 NEW_ONLY i natychmiastowy MANUAL20; nadal bez backfillu.

Rollback: przywrócić kompatybilny Worker 622b952d, pozostawić poprawione wersje
receipts, wszystkie nowe accepted i addytywne migracje. Nie przywracać D1 ze
snapshotu i nie usuwać plików Drive. Starszy czytnik może ponownie zgłaszać
bezpieczny HOLD przy następnym przyroście metadanych; nie jest to uszkodzenie danych.
