# Rzeczywisty odbiór 20 kanałów — 15.10.2026

Cykl manualny zakończył się wynikiem **20/20 PASS**, bez błędów, duplikatów i importu historii. Wszystkie czasy poniżej są w UTC; w Warszawie obowiązywało UTC+2.

| Kanał                      | YouTube channel ID         | Początek kontroli UTC | Koniec kontroli UTC | Próba / fencing | Zapisane strony | Wynik                   |
| -------------------------- | -------------------------- | --------------------- | ------------------- | --------------- | --------------- | ----------------------- |
| CGP Grey                   | `UC2C_jShtL725hvbm1arSV9w` | 11:39:02.382          | 11:39:03.867        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Numberphile                | `UCoxcjq-8xIDTYp3uz647V5A` | 11:39:05.318          | 11:39:06.709        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Kurzgesagt – In a Nutshell | `UCsXVk37bltHxD1rDPwtNM8Q` | 11:39:08.175          | 11:39:09.529        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Big Think                  | `UCvQECJukTDE2i6aCoMnS-Vg` | 11:39:10.922          | 11:39:12.381        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| TED                        | `UCAuUUnT6oDeKwE6v1NGQxug` | 11:39:14.316          | 11:39:15.731        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Technology Connections     | `UCy0tKL1T7wFoYcxCe0xjN6Q` | 11:39:17.120          | 11:39:18.528        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| minutephysics              | `UCUHW94eEFW7hkUMVaZz4eDg` | 11:39:19.917          | 11:39:21.284        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Stand-up Maths             | `UCSju5G2aFaWMqn-_0YBtq5A` | 11:39:22.668          | 11:39:24.175        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Two Minute Papers          | `UCbfYPyITQ-7l4upoX8nvctg` | 11:39:25.548          | 11:39:26.884        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| The Action Lab             | `UC1VLQPn9cYSqx8plbk9RxxQ` | 11:39:28.273          | 11:39:29.620        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Veritasium                 | `UCHnyfMqiRRG1u-2MsSQLbXA` | 11:39:31.010          | 11:39:32.505        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Practical Engineering      | `UCMOqf8ab-42UUQIdVoKwjlQ` | 11:39:34.000          | 11:39:35.367        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| SmarterEveryDay            | `UC6107grRI4m0o2-emgoDnAA` | 11:39:36.713          | 11:39:38.059        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Real Engineering           | `UCR1IuLEqb6UEA_zQ81kwXfg` | 11:39:39.452          | 11:39:40.820        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| 3Blue1Brown                | `UCYO_jab_esuFRV4b17AJtAw` | 11:39:42.337          | 11:39:43.692        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| The Royal Institution      | `UCYeF244yNGuFefuFKqxIAXw` | 11:39:45.068          | 11:39:46.533        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Computerphile              | `UC9-y-6csu5WGm29I7JiwpnA` | 11:39:47.903          | 11:39:49.252        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Steve Mould                | `UCEIwxahdLz7bap-VDs9h35A` | 11:39:50.646          | 11:39:52.022        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Mark Rober                 | `UCY1kMZp36IQSyNx_9h4mpCg` | 11:39:53.834          | 11:39:55.246        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |
| Branch Education           | `UCdp4_l1vPmpN-gDbUwhaRUQ` | 11:39:56.619          | 11:39:58.198        | 1 / 1           | 1               | SUCCEEDED, RSS odebrany |

Wszystkie kontrole mają `RSS_PAGE_ACQUIRED`, `PAGE_COMMITTED`, zakończony `job_attempt` i `pages_committed=1`. Stan całego cyklu: `COMPLETE`, `completed=20`, `failed=0`.

Czas od trwałego utworzenia cyklu do jego zakończenia: **86,773 s**. Przerwy między końcem jednej kontroli a początkiem kolejnej: **1,346–1,935 s**. Obejmują transport, lease i fencing; nie wystąpiło oczekiwanie pięciu minut.

Kontrole RSS mają `coverage=PARTIAL`: nie enumerowano całej historycznej playlisty. Znacznik `discovery_scans.completed_at` dotyczy pełnego pokrycia historycznego okna; faktyczne zakończenie kontroli potwierdzają zapis strony, SUCCEEDED oraz `job_attempts.finished_at`.

Dokładne identyfikatory scan/job/attempt i surowe metadane dowodowe: [MANUAL20_PRODUCTION_VERIFICATION.json](MANUAL20_PRODUCTION_VERIFICATION.json).
