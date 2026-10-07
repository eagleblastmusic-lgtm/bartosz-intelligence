# Prompt Lab — przygotowanie i wykonanie porównania

Studio udostępnia porównanie dwóch istniejących wersji tej samej rodziny promptu na wskazanej rewizji źródła i profilu semantycznego. Domyślny aktywny provider pozostaje Gemini Free, runtime local, paid services wyłączone. Model A/B ma walidator kontroli, lecz GUI nie pokazuje drugiego adaptera jako dostępnego.

## Budżet i przygotowanie

W „Budżet Prompt Lab” ustaw identyfikator projektu (nie klucz API), aktualny model, maksymalną liczbę requestów Lab dziennie oraz zapas RPM/RPD/INPUT_TPM dla zwykłego przetwarzania. Zapis wymaga przeglądu i potwierdzenia. Limit 0 wstrzymuje nowe rezerwacje. Budżet to ograniczenie aplikacji, nie potwierdzenie dostępnej quota Google. Brak świeżej oficjalnej globalnej quota lub dopuszczenia Free nadal zatrzymuje requesty. Zmiany budżetu są niezmiennymi rewizjami z audytem i kontrolą konfliktów.

Wybierz wersję A w Studio. Rozwiń „Porównaj dwie wersje w Prompt Lab”, wybierz materiał, dokładną rewizję źródła, profil, model revision, limit odpowiedzi oraz wersję B, liczbę powtórzeń (1/3) i cel. Przygotowanie kompiluje podglądy i zapisuje eksperyment, bez wywołań AI i bez przyjmowania wyników do Knowledge. Schemat, dane wejściowe, reasoning i limity obu wariantów muszą być identyczne. Snapshot History obejmuje dokładny cut i rekordy; ich zmiana pomiędzy przygotowaniami powoduje odrzucenie pary. Dla History kontrolnym hashem wejścia jest SHA całego planu, dla analizy/tłumaczenia SHA źródła.

Provider nie udostępnia seed. Eksperyment rejestruje SEED_UNAVAILABLE/PROVIDER_NONDETERMINISM, a ewentualny MODEL_AB także MODEL_REASONING_IMPLEMENTATION. Samo wskazanie wersji lub rewizji nie daje scope approval. JSON_REPAIR bez kwalifikowanego rzeczywistego błędu i ścieżki naprawy pozostaje niedostępny.

## Uruchomienie, ponowienie i anulowanie

Każda próba ma osobny przycisk uruchomienia. Zadania idą przez normalne confirm, trwały backlog, lease/fencing, admission, walidację i enrichment. Mają mode QUALITY_TEST i niższy priority 20. Metadata PROMPT_LAB jest częścią niezmiennego snapshotu zadania, nie deklaracją przesłaną przez workera. Admission atomowo sprawdza bieżącą politykę Lab, jej rewizję, dzienną liczbę rezerwacji i globalny zapas dla zwykłej pracy. UNKNOWN usage nadal obciąża budżet; nie traktuj transport failure jako zerowego wykorzystania.

Deterministyczny nonce próby chroni przed duplikacją przy utracie odpowiedzi. Ponowienie po zapisaniu joba zwraca istniejący job także po wygaśnięciu podglądu. Nowe niewysłane zadanie wymaga ważnego podglądu (15 minut); po wygaśnięciu przygotuj nowy eksperyment. Nie podmieniaj źródła, promptu ani modelu w historycznej próbie. Historia eksperymentów pozostaje dostępna po odświeżeniu strony, stronicowana po 20 wpisów; widok stanów jest ograniczony do 301 rekordów i jawnie oznacza przekroczenie 300.

Anulowanie wymaga powodu, przeglądu i potwierdzenia. Trwały receipt blokuje nowe rezerwacje i przejście RESERVED→SUBMITTED także wtedy, gdy job został już zapisany. Request wysłany przed anulowaniem może się zakończyć: zachowaj wynik i usage. Anulowanie nie usuwa historii i nie odpisuje zużycia ani niepewnych rezerwacji. Nie oznacza automatycznego zakończenia wszystkich już zakolejkowanych jobów.

## Ocena i granice

Lista pokazuje rzeczywiste stany job/run, walidację i hash kandydata. Wynik QUALITY_TEST pozostaje kandydatem; nie zmienia ActiveSelection ani Observation Ledger. Porównanie nie publikuje promptu i nie kwalifikuje modelu. Ocena semantyczna nadal wymaga ludzi i korpusu zgodnego z CP-6.10; sam poprawny JSON lub test fixture nie stanowi dowodu jakości.

Materiały i evaluator tłumaczeń opisuje `TRANSLATION_BENCHMARK_PROCEDURE.md`. Trwałe formularze anotacji oraz inspekcja porównywanych wyników są kolejną częścią implementacji Lab; ich brak nie może zostać zastąpiony oceną AI. Obecne przygotowanie pary nie obsługuje multipart/recovery ani dodatkowego pass. Te ścieżki wymagają przypięcia i weryfikacji wszystkich części przed porównywalną oceną. Nie deklaruj CP-6.10 ani Stage 06 DONE na podstawie samego tego checkpointu.
