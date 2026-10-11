# P0: systemowa jakość polskich streszczeń — decyzja właściciela 2026-10-11

## Aktualna decyzja: akceptacja jednego wyniku po dwóch korektach

Właściciel zaakceptował rewizję 3 jakościowo po doprecyzowaniu zapewnienia
Robera dla Winstona K. i popularności TED według stanu na moment rozmowy.
Rewizja 4 spełnia oba warunki. Formalny scoped receipt:
[owner-result-publication-decision:1](../verification/gate-ai/quality-review-revision-4-2026-10-11.json).
Akceptacja dotyczy treści tego materiału, nie całego modelu ani CP-3.13.
Pierwotne odpowiedzi i evidence oraz rewizje 2/3 zachowano. Zero nowych AI.

[Publikacja na rzeczywistym Drive](../verification/gate-ai/owner-reviewed-publication-rUhllpnYWR8-v4.json)
jest VERIFIED: osobny prywatny Markdown w istniejącym Daily, pełny
SHA/readback/version/ACL. Jeden create; reserved ID i create intent zapisane
przed wysłaniem. Resume sprawdza ten sam ID. Konflikt lub nierozstrzygnięte
404 po create odracza operację, bez overwrite albo nowego losowego ID.
Minimalny mapping/decision jest w config_versions. Historycznego QUALITY_TEST
nie zmieniono na production accepted run; normalny raport dnia jest zachowany.
To jawny wyjątek publikacji redakcyjnej po decyzji właściciela. Standardowa
autoakceptacja/GUI delivery i qualification pozostają kryteriami P0.

Polityka **analysis-quality:2** dodaje siłę zapewnień i zakres czasowy.
Detektory działają dla wspólnych ordinary/chunk parent ścieżek. Dokładny
snapshot v1 nadal jest dopuszczalny, zmodyfikowane/nieznane są odrzucane.
Deploy 59fb3c34… /8b8ace8/schema39, 85 aktualnych regresji PASS. Prompt v2
Master bundle i wire schemas nie są nadpisywane. Nowy prompt nadal wymaga
osobnej live kwalifikacji; nie twierdzimy, że heurystyki dowodzą pełnej semantyki.

## Historia pierwszego odbioru i wspólne wymagania

Właściciel ocenił pierwszy rzeczywisty kandydat rUhllpnYWR8 jako **WYMAGA KOREKT,
NIE AKCEPTUJĘ DO DAILY**. Dotyczy to tego materiału, nie negatywnej kwalifikacji
całego Gemini 3.8 Flash. Zażądał wspólnych poprawek oraz ponownego odbioru
wersjonowanej prezentacji bez nowej generacji. Oryginalne materiały pozostają
immutable. Decyzja uzupełnia Drive-only i nadrzędny P0; nie przywraca trwałego
Knowledge ani ręcznej akceptacji każdego przyszłego poprawnego filmu.

## Zmienione kryteria i wykonanie

| Obszar | Obowiązująca zasada / implementacja |
| --- | --- |
| Registry / szablony | Wspólna `analysis-quality:1` dla nowych Economy/Full/Custom, także draft fallback. Snapshot zapisuje pełną politykę i SHA. Hash uczestniczy w quality_scope i planie chunków; overhead obejmuje tekst polityki. Historyczne prompt v2 i Master bundle pozostają niezmienione. |
| Schema | Lean wire nadal używa `text_pl`, canonical typed records `content_pl`. Istniejące attribution/subject/qualifiers/refs wystarczają; nie zmieniono immutable schema dla samego renderowania. Oddzielny raport jakości zapisuje wykryte braki. |
| Daty / niepewność | Prompt wymaga zachowania negacji, warunków i siły prognoz. Detektory źródłowe zatrzymują m.in. nieuzasadnione „przed YEAR”, utracone rozpoznane zastrzeżenia i warunki. |
| Atrybucja | Deklaracja autora nie jest niezależnie potwierdzonym faktem. `UNCLEAR` wymaga przeglądu. Typed renderer zachowuje attribution, epistemic_status i qualifiers; czytelny przegląd podaje podmiot i linki. |
| Nazwy | Korekty wyłącznie z jednoznacznych zatwierdzonych aliasów, z izolacją owner/type/language. Canonical display może użyć nazwy zatwierdzonej; raw transcript/wire pozostają bez zmian. Brak zatwierdzonego mapowania nie jest dowodem poprawności nazwy; prompt ma zgłaszać niejednoznaczność. W tej rewizji właściciel potwierdził Class CrunchLabs, Mark Rober, OpenSciEd. |
| Pokrycie | Prompt obejmuje cały materiał, w tym końcowe Q&A. Dla długiego tekstu deterministyczny detektor sprawdza reprezentację ośmiu kolejnych przedziałów źródła przez summary/key_points. Chunk-child pomija globalną kontrolę pokrycia; parent sprawdza pełny merge. |
| Publikacja | Ordinary validation `REVIEW_REQUIRED` nie może commitować accepted effects. Disposition utrwala BLOCKED/AI_OUTPUT_REVIEW_REQUIRED i zachowuje źródło/kandydata. Parent chunk merge również blokuje taki wynik. Nie ma automatycznej regeneracji dla błędu jakości. Poprawny wynik w zakwalifikowanym zakresie nadal jest przyjmowany automatycznie. |
| Daily | Renderer 1.2 zachowuje wszystkie summary/key_points i bezpośrednie source timestamp links także w COMPACT. Przy przekroczeniu budżetu raport jawnie OVERSIZE, bez obcinania tematów. Odczyt 1.1 zachowano; istniejących plików nie przepisano. |
| Uszkodzone pola | Wspólny renderer odrzuca puste wartości i literalne undefined/null/NaN/[object Object]. Czyta rzeczywiste pola canonical; nie przypisuje błędu prezentacji utracie danych AI. |

Detektory są ograniczonymi regułami, **nie pełną weryfikacją semantyczną**.
Pokrycie przedziałów nie dowodzi uwzględnienia każdego tematu; można też mieć
referencję, która nie dowodzi całej parafrazy. Rozpoznawanie zastrzeżeń jest
ograniczone do jawnych wzorców EN/PL i może wymagać przeglądu. Inne języki,
negacje znaczeniowe, niejednoznaczne nazwy i uogólnienie nowego promptu wymagają
dalszej kwalifikacji na rzeczywistych wynikach. `semantic_verification=NOT_ASSERTED`
pozostaje. Nie wolno uznać local PASS za live model quality PASS.

## Historia: rewizja 3 przed najnowszą decyzją właściciela

Pierwotny provider output 8657 bytes i canonical 71640 bytes pozostają bez zmian.
Rewizja 3 zawiera siedem punktów streszczenia, siedem claims i trzy predictions.
Zmiany mają osobny manifest, SHA i nowy lokalny canonical; nie podszywają się
pod odpowiedź Gemini ani produkcyjny accepted run. Trzy późne tematy dodano
redakcyjnie z istniejącej transkrypcji i oznaczono ich pochodzenie. Poprawiono
datę, nazwy, deklaracje i pełne lokalne refs do prognozy Marsa. Rewizję 2 zachowano;
rewizja 3 poprawia dodatkowo prezentację językową przed ponownym odbiorem.

[Receipt rewizji 3](../verification/gate-ai/quality-review-revision-3-2026-10-11.json).
Prywatny dokument: `.local/ai-pilot/review-2026-10-11-rUhllpnYWR8/revision-3/PRZEGLAD_JAKOSCI-v3.md`.
Ówczesny status **AWAITING_HUMAN_REVIEW**, accepted=false; jeszcze bez publikacji.
Późniejsza akceptacja, rewizja 4 i osobny verified Daily są opisane powyżej.
Pierwotny wynik ma siedem wskazań nowych detektorów; rewizja zero. To porównanie
detektorów, nie skala jakości modelu i nie automatyczna akceptacja.

## Runbook i pozostałe odbiory

1. Zachować immutable provider/source/prompt/receipt i settlement użycia.
2. W razie jakościowego BLOCKED przeczytać raport findings oraz źródła; nie
   ponawiać Gemini automatycznie ani nie usuwać joba. Korekta ma nowy manifest
   i nowe hashe. Ręczny przegląd dotyczy oznaczonego wyjątku.
3. Nowa polityka zmienia quality_scope: wcześniejsza kwalifikacja nie kwalifikuje
   nowego promptu. Osobno zatwierdzona live próba jest nadal wymagana do pomiaru
   skuteczności promptu; nie jest częścią tej korekty lokalnej.
4. Nie promować QUALITY_TEST/editorial do accepted run przez zmianę historycznego
   rekordu. Właściwa ścieżka akceptacji/kwalifikacji i verified Daily readback
   pozostają kryteriami P0. Wdrożenie 59fb3c34… nie nadaje model quality PASS.
5. Gate AI/Stage03 quality, Stage04 Daily, Stage07 P0 i Stage08 live E2E mają
   powyższe kryteria. Gate C/R/D zachowują swoje mierzone zakresy. CP-3.13 i
   screen-reader pozostają wcześniej odroczone; nie wymagamy ponownego rozstrzygnięcia.

Pierwsze rewizje lokalne miały zero production mutations. Najnowsza jawnie
zatwierdzona publikacja ma własny zmierzony receipt. Nadal zero nowych Gemini,
production DELETE lub backup capture. `paid_services_enabled=false`; deletion_enabled=0,
approval_reference=NULL. Istniejące backupy i zweryfikowane archiwum transkrypcji
pozostają wystarczającymi dowodami swoich wcześniejszych właściwości.

### Kontrolowana publikacja zaakceptowanej rewizji

`node --env-file=.env --import=tsx tools/deployment/publish-reviewed-summary.ts
--live <receipt-owner-decision.json> <Daily-id> <application-folder-id>
--usage <fresh-d1-analytics.json>`.

CLI wymaga warunków spełnionych w scoped owner receipt, prywatnych plików o
zgodnych SHA, canonical schema/source refs, oryginalnego durable QUALITY_TEST
i fresh observed D1 budget. Minimalne metadane filmu są pobierane po ID.
Reserved ID, create intent i verified mapping są immutable revisions w D1.
Po istniejącym VERIFIED evidence CLI kończy ALREADY_VERIFIED bez sieci/SQL.
Nie służy to automatycznej publikacji kolejnych nieprzejrzanych kandydatów ani
nadawaniu quality approval. Każdy taki wyjątek wymaga rzeczywistej decyzji
właściciela; poprawne zwykłe wyniki pozostają automatyczne w swoim scope.
