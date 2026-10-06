# Gate U — wymagany przegląd ręczny

Status: NOT_RUN. Automat axe i Playwright nie zastępują tego przeglądu. Nie oznaczać PASS na podstawie samego zatwierdzenia materiałów ani zrzutu ekranu.

Osoba oceniająca zapisuje swój identyfikator, datę, commit/build, adres środowiska, system, przeglądarkę, czytnik ekranu i jego wersję, viewport oraz skalowanie. Każdy wiersz otrzymuje PASS/FAIL/NOT_RUN i krótki dowód. Nie zapisywać danych sesji, tokenów, sekretów ani całej prywatnej treści.

| Próba                         | Oczekiwany wynik                                                                                                                     | Wynik / dowód |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Klawiatura od pierwszego Tab  | Link pominięcia nawigacji działa; logiczny porządek fokusu, widoczny obrys                                                           | NOT_RUN       |
| Nawigacja czytnikiem          | Jeden main, rozpoznawalna nawigacja, hierarchia nagłówków i aktywna sekcja                                                           | NOT_RUN       |
| Dzień, kanał, gęstość         | Etykiety i stan zaznaczenia odczytywane; zmiana filtra nie odczytuje całej listy automatycznie                                       | NOT_RUN       |
| Kalendarz                     | Strzałki/Home/End, Enter wybiera dzień; czytnik odczytuje datę, licznik i niepełne sprawdzenie; Escape przywraca fokus               | NOT_RUN       |
| Lista i paginacja             | Tytuły, autorzy i statusy czytelne; przycisk kolejnej strony dostępny; po późnym wyniku brak samowolnego przesunięcia                | NOT_RUN       |
| Widok czytania                | Powrót zachowuje dzień/filtry; disabled/partial/review i przypisanie wypowiedzi są zrozumiałe                                        | NOT_RUN       |
| Evidence                      | Nazwa dialogu i oryginalny cytat odczytywane; tło nie jest osiągalne; Tab/Shift+Tab pozostają w dialogu                              | NOT_RUN       |
| Zamknięcie Evidence           | Escape i przycisk przywracają fokus do właściwego źródła                                                                             | NOT_RUN       |
| Nieznany czas/helper          | Brak wymyślonego czasu; niedostępny helper wyjaśniony; źródło otwierane wyłącznie świadomą akcją                                     | NOT_RUN       |
| Status i błędy                | Brak napisów, quota nieznana/stara, local offline, FAILED i review rozróżnialne bez samego koloru; błąd odświeżenia nie usuwa wyniku | NOT_RUN       |
| Powiększenie 200%             | Treść i wszystkie działania dostępne bez utraty treści/poziomego przewijania na uzgodnionych rozmiarach                              | NOT_RUN       |
| Oba motywy i reduced motion   | Fokus i informacja pozostają czytelne; ograniczenie animacji respektowane                                                            | NOT_RUN       |
| Wylogowanie/wygaśnięcie sesji | Prywatne dane znikają; czytnik otrzymuje czytelny komunikat i dostęp do logowania                                                    | NOT_RUN       |

Do przeglądu użyć zbudowanego środowiska odpowiadającego raportowi automatycznemu. Dane syntetyczne są dopuszczalne dla GUI, ale nie potwierdzają real provider quality, live vertical slice ani capacity. Jeśli jakikolwiek wymagany wiersz nie został wykonany, globalny Gate U pozostaje INCONCLUSIVE / AWAITING_MANUAL_ACCESSIBILITY_REVIEW. Naprawa FAIL wymaga ponownego sprawdzenia dotkniętej próby, nie zmiany kryterium.
