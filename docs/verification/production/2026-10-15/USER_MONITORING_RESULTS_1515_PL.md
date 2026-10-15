# Rzeczywiste wyniki monitoringu — 15.10.2026

Odczyt D1/Queue: 15.10.2026, 15:15:18 Europe/Warsaw. Oracle: 15:13:52 Warsaw.
Wyłącznie odczyt: 0 zapisów produkcyjnych, dodatkowych skanów, sesji i pobrań.

| Cykl                                                         | Początek Warsaw      | Zakończenie Warsaw   | Kontrole | Błędy |
| ------------------------------------------------------------ | -------------------- | -------------------- | -------- | ----- |
| Manualny 14:40 — odwołane zlecenie, wywołanie zdążyło ruszyć | 15.10.2026, 14:40:00 | 15.10.2026, 14:41:47 | 20/20    | 0     |
| Automatyczny 15:00                                           | 15.10.2026, 15:00:22 | 15.10.2026, 15:01:46 | 20/20    | 0     |

W cyklu15:00 wszystkie20jobs mają SUCCEEDED, zapisanąstronęRSS i zakończony
job_attempt. Pierwszy rzeczywistyskan:15:00:41.368, ostatni zakończony15:01:46.316;
cyklCOMPLETE15:01:46.984. To dowód wykonania,nie tylko zaplanowania.

Właściciel odwołał zlecenie14:40. Proces zdążył wysłaćhint14:40:00.504 przed
skuteczną próbązatrzymania;D1potwierdza20wykonanychkontroli. Nie zmieniło to15/23.

## TED

W obu cyklach utrwalono jeden film z istniejącego okna monitoringu:

- **How the Wealth Gap Is Reshaping Politics | Xochitl Gonzalez | TED**, videoID **PpEUTpzWt2M**.
- Publikacja: **13.10.2026, 17:00:17 Warsaw** (2026-10-13T15:00:17.000Z UTC).
- Znany w bazie od **13.10.2026, 17:35:40 Warsaw**.
- Wynik: **1 już znany,0 nowych**, bez nowego zadaniaFETCH.
- Istniejący FETCH_TRANSCRIPT: SUCCEEDED od13.10.2026 17:36:27.818Warsaw,
  job6a4a38e2-d431-48e3-a36a-a54eb6a6a3c1,attempt1.
- Istniejący receiptDrive: VERIFIED od **13.10.2026, 17:40:35 Warsaw**,
  plik **1mwrBLgNhvCGxaeLTuhfXuRTkowzd2t-A**.

To liczba materiałów dopuszczonych do okna kontroli. Surowa pełna lista RSS
nie jest zachowywana po commit; nie odpytywanoYouTube ponownie. D1 ma61filmówTED;
JSONdowodowy zawiera także10najnowszych,nie należy utożsamiać ichzwynikiemcyklu.

## Zadania, Queue, Oracle i Drive

Od14:40 oraz w cyklu15:00 utworzono **0 nowychFETCH_TRANSCRIPT** we wszystkichkanałach.
Nie powstały noweaccepted ani nowe archiwaDrive. Wcześniejsze zadaniaTED:
43SUCCEEDED,19BLOCKED/LOCAL_YTDLP_UNAVAILABLE,1DEFERRED/LOCAL_YTDLP_NO_CAPTIONS.
Nie ponawiano ich i nie zmieniano żadnego zadania.

Queuebacklog0. Oracle executor/broker active/running,restarts0; ostatnie150wpisów
toidle. Najnowszy capture pozostaje canary9i1LVL3_xpU z04:02Warsaw.
D1 zachowuje46archiwówVERIFIED. Ostatni nowyMarkdown to wcześniejszycanary,
15.10 o04:02:41.693Warsaw,JSON04:02:36.136. Nie są to nowe wyniki15:00.
StatusDrive odczytano z trwałychreceiptsD1; bez świeżegoDrive readback/OAuthrefresh.

Dowody: [D1/Queue](USER_MONITORING_20261015_1514_D1_QUEUE.json),
[Oracle](USER_MONITORING_20261015_131343_ORACLE.json),
[archiwumTED](USER_MONITORING_20261015_1517_TED_ARCHIVE.json).
