# Wdrożenie Cloudflare — 14 października 2026

Po jawnej końcowej zgodzie użytkownika wykonano część Cloudflare:
**backup i niezależne odtworzenie PASS, migracja 040 PASS,
nowa wersja istniejącego Workera aktywna w 100%**.
Oracle/executor i rzeczywisty produkcyjny job są osobnymi dowodami
koordynowanymi w tym samym zadaniu; sam health nie jest dowodem pobrania.

- Backup: 25 403 500 B; SHA-256 `0046c46edceefe29a1daa3af98c638928b4e5240710e5cb6a7ca28ca87a6fab1`.
  Prywatny eksport pozostaje w `.local/pre-deployment-backups/`.
  Niezależny SQLite restore, próba upgrade 39→40, integralność i FK
  przeszły; liczby istniejących danych zachowane.
- Produkcja: przed zmianą 39 migracji zgodnych nazwami i hashami z repo.
  Zastosowano wyłącznie istniejącą `040_daily_tasks_workflow.sql`.
  Po zmianie 40/40 hashów, `quick_check` i FK PASS.
- Worker: nowa wersja `39edd639-eba3-40bb-93c7-022f1aec31d6`;
  ten sam origin i bindingi DB/Queue/ASSETS, `--keep-vars`, bez wysyłania
  sekretów i bez tworzenia nowych zasobów Cloudflare.
- Kontrola live: health HTTP 200 z trzema bindingami; nieuwierzytelniony
  POST transkrypcji odrzucony HTTP 401 bez utworzenia zadania.
  Sprawdzenie wersji potwierdziło nową wersję w 100%.
- Lokalne testy zmienionego API i regresji: 21/21 PASS; typecheck API,
  worker-tests i tools oraz ESLint/format PASS.

[Instrukcja API](../../../../operations/YOUTUBE_TRANSCRIPT_API_PL.md)
opisuje owner/CSRF, URL lub ID → zadanie, status, odczyt tekstu/mapy i
istniejące replay. Zmiana nie wprowadza nowego modelu D1 ani backendu;
040 była istniejącą niewdrożoną migracją wymaganą przez bieżącą akceptację.

Rollback aplikacji: przywrócić istniejącą wersję
`224ba7ff-a4ab-47ff-8cc1-70aadb2d91b1`, np. oficjalnym Wrangler rollback
z `apps/api/wrangler.production.json`. Nie usuwać addytywnych tabel 040
ani przyjętych danych. W razie wycofania całego uruchomienia zatrzymać
nowy executor/broker i odwołać jego scoped identity zgodnie z koordynacją
Oracle. Backup umożliwia odtworzenie, ale nie wykonano destrukcyjnego
rollbacku danych.

Nie włączono płatnych funkcji ani nowej subskrypcji. Aktualne publiczne
limity Free sprawdzono 14 października 2026:

| Usługa | Limit Free |
| --- | --- |
| Cloudflare Workers | 100 000 żądań/dzień, 10 ms CPU na wywołanie |
| D1 | 5 mln odczytanych i 100 000 zapisanych wierszy/dzień; 500 MB/baza, 5 GB/konto |
| Queues | 10 000 operacji/dzień, zwykle 3 operacje na dostarczenie małej wiadomości |
| Oracle A1 Always Free | Obecna dokumentacja: 1500 OCPU-h i 9000 GB-h/miesiąc, odpowiednik 2 OCPU / 12 GB |

Źródła: [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Queues](https://developers.cloudflare.com/queues/platform/pricing/),
[Oracle](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
To limity planów z dokumentacji, nie odczyt planu billingowego konkretnego
konta. Istniejąca D1 miała 27 836 416 B przed wdrożeniem, poniżej 500 MB.
Nie zmieniano rozmiaru ani liczby VM Oracle. Zachowana konfiguracja projektu
ma `paid_services_enabled=false`; miesięczny rachunek konta nie był mierzony.

JSON-y w tym katalogu zawierają wyłącznie metadane. Prywatny backup,
sekrety Workera, cookies i tokeny nie trafiają do dowodów.
