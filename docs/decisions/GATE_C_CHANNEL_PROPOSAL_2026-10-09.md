# Gate C — propozycja 19 dodatkowych kanałów

Status: **OWNER_APPROVED / NOT_ADDED**. Właściciel 2026-10-09 zatwierdził
„listę i stopniowe new-only”. Dodanie źródeł oczekuje na realny reset D1 i
zastosowanie optymalizacji. Istniejący zatwierdzony TED
pozostaje jedynym aktywnym źródłem. Poniższa propozycja daje łącznie 20 źródeł;
nie wykonano żadnego source-create, backfill ani Gemini requestu.

Dobór: publiczne materiały edukacyjne, science/technology/mathematics oraz
różna długość i struktura wypowiedzi. Linki identyfikują kanały, nie dowodzą
bieżącej liczby uploads, kompletności captions, języka każdego materiału czy
AI capacity. Canonical channel ID zostanie rozwiązany istniejącym adapterem
po zatwierdzeniu; nie inventujemy IDs z handle.

| #   | Kanał / link                                                                  | Zastosowanie w kwalifikacji                            |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | [Veritasium](https://www.youtube.com/@veritasium)                             | dłuższa narracja naukowa, argumenty i provenance       |
| 2   | [3Blue1Brown](https://www.youtube.com/@3blue1brown)                           | matematyka, trudny związek narracji i wizualizacji     |
| 3   | [Numberphile](https://www.youtube.com/@numberphile)                           | rozmowy o matematyce, terminologia                     |
| 4   | [Computerphile](https://www.youtube.com/@computerphile)                       | informatyka, rozmowy techniczne                        |
| 5   | [SmarterEveryDay](https://www.youtube.com/@smartereveryday)                   | doświadczenia i dokumentacja inżynierska               |
| 6   | [minutephysics](https://www.youtube.com/@minutephysics)                       | krótkie materiały o dużej gęstości treści              |
| 7   | [CGP Grey](https://www.youtube.com/@CGPGrey)                                  | explainers i źródła wnioskowania                       |
| 8   | [Kurzgesagt](https://www.youtube.com/@kurzgesagt)                             | science explainers, rozróżnienie faktów i scenariuszy  |
| 9   | [Real Engineering](https://www.youtube.com/@RealEngineering)                  | dłuższe historie technologii i zależności              |
| 10  | [Technology Connections](https://www.youtube.com/@TechnologyConnections)      | szczegółowe opisy urządzeń i ograniczeń                |
| 11  | [Practical Engineering](https://www.youtube.com/@PracticalEngineeringChannel) | infrastruktura, eksperymenty i causal explanations     |
| 12  | [Two Minute Papers](https://www.youtube.com/@TwoMinutePapers)                 | research/AI, konieczność oddzielenia claims i evidence |
| 13  | [The Royal Institution](https://www.youtube.com/@TheRoyalInstitution)         | długie wykłady i wypowiedzi wielu osób                 |
| 14  | [Big Think](https://www.youtube.com/@bigthink)                                | wywiady i wiedza zależna od autorstwa wypowiedzi       |
| 15  | [Stand-up Maths](https://www.youtube.com/@standupmaths)                       | matematyka, humor, wyjaśnianie modeli                  |
| 16  | [Steve Mould](https://www.youtube.com/@SteveMould)                            | praktyczne demonstracje naukowe                        |
| 17  | [Mark Rober](https://www.youtube.com/@MarkRober)                              | rozbudowane eksperymenty i narracja popularna          |
| 18  | [Branch Education](https://www.youtube.com/@BranchEducation)                  | mechanizmy urządzeń, terminologia i animacje           |
| 19  | [The Action Lab](https://www.youtube.com/@TheActionLab)                       | krótsze eksperymenty, obserwacje i hipotezy            |

Rekomendacja po zgodzie: rozwiązać tożsamości, sprawdzić rzeczywiste original
captions oraz źródłową eligible klasyfikację. Włączać etapami z new-only,
bez jednoczesnego pełnego backfill. To propozycja sposobu uruchomienia, a nie
zmiana Definition of Done: Gate C nadal wymaga 20 zatwierdzonych źródeł,
7 dni kalibracji i 28 dni rzeczywistej obserwacji. Nie wytwarzamy brakujących
próbek ani accepted AI dla spełnienia denominator.

D1 read budget po zmianach jest lokalnie poprawiony, ale write/AI/peak capacity
nie jest jeszcze kwalifikowana. Powiązane koszty, założenia i rzeczywiste
ograniczenia: [D1 root cause](../verification/release/D1_QUOTA_ROOT_CAUSE_2026-10-09.md).
