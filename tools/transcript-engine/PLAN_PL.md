# Original Transcript Engine — plan eksperymentu

Zakres: samodzielny prototyp badawczy, publiczny ID, bez D1/RPC/produkcji.
Nie zmienia zastanych providerów ani historycznych dowodów.

## Trzy hipotezy

|                            | I: adapter udostępnionej ścieżki                                                                     | II: transakcja natywnego panelu na ARM64                                                                                        | III: rozdzielne domeny źródeł                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Nowość                     | Ścisłe powiązanie tożsamości filmu/ścieżki, wszystkich cue i referencji; nie tylko parsowanie tekstu | Własny klient CDP, świeży profil, jedna operacja UI, odpowiedź panelu z dokładnymi endMs + istniejący czytnik DOM jako kontrola | Plan źródeł identyfikuje wspólny upstream; yt-dlp/Python/panel nie stają się trzema niezależnymi źródłami  |
| Wymagania                  | Payload oraz metadane faktycznie ujawnione przez źródło                                              | Przenośny Chromium ARM64, istniejące biblioteki Ubuntu, zatwierdzony materiał dla live                                          | Rzeczywiście niezależny resolver i dowód pochodzenia dla konkretnego ID                                    |
| Ryzyko                     | Poprawny prefiks wygląda jak pełny plik; metadata nie dowodzą oryginalnego audio                     | Ten sam YouTube może odmówić świeżej przeglądarce; DOM nie ma końców cue                                                        | Zmienione grupowanie tekstu, błędne przypisanie filmu, pozorna niezależność                                |
| Test falsyfikujący         | Brak jednego cue/końca, inny język/film/track nie może uzyskać accepted                              | Offline na obu hostach, następnie dokładnie jedna operacja native dla zatwierdzonego ID; odmowa kończy eksperyment              | Dwie metody YouTube po odmowie nie mogą uruchomić drugiej próby; niezależne źródło wymaga osobnego wejścia |
| Oczekiwane rozstrzygnięcie | Poprawny adapter nie usuwa odmowy dostępu                                                            | Największa wartość poznawcza: odróżnienie wykonalności przeglądarki ARM64 od dostępności panelu                                 | Możliwe poszerzenie pokrycia, bez obietnicy pokrycia dowolnego publicznego ID                              |

Wybrano II wraz z minimalnym adapterem I. III otrzyma mały, testowany mechanizm
planu/terminalnej odmowy, bez fikcyjnego providera lub katalogu jako celu głównego.

Wykorzystujemy niezmienione `decodeOffline`, `publicVideoId`, parser JSON3 oraz
czytnik panelu 0.4.2. Nowy kod nie odtwarza podpisów, tokenów, cookies, klientów
Innertube ani atestacji. CDP obserwuje odpowiedź wywołaną jednym kliknięciem UI.
Brak udostępnionego panelu nie oznacza automatycznie NO_CAPTIONS.

Stały przypadek diagnostyczny: `aircAruvnKk`, zgodnie z doprecyzowaniem użytkownika.
Odszukane EN/PL pozostają materiałami diagnostycznymi bez potwierdzenia typu,
oryginalności i niezależnej pełności. Live pozostaje BLOCKED_AUTHORIZATION do
udokumentowania podstawy automatycznego dostępu. Niezależna pełna referencja jest dodatkowo potrzebna do
accepted, lecz nie do samej autoryzowanej diagnostyki dostępności.

Kolejność odbioru: adapter → CDP/loopback → limity/anulowanie → te same bajty na
Oracle → samodzielny proces Oracle → niezależna porównywarka → raport/manifest.
Odtwarzane teksty historyczne oraz zrekonstruowane koperty transportowe są
oznaczone REPLAY, nigdy jako nowe pobranie oryginalnych napisów.
