import type { JobState } from '../../../../packages/contracts/src/jobs.js';
import type { AnalysisReadiness } from '../../../../packages/contracts/src/daily.js';
export const statusLabels: Record<JobState | AnalysisReadiness, string> = {
  PENDING: 'Oczekuje',
  LEASED: 'Przydzielone',
  RUNNING: 'W trakcie',
  SUCCEEDED: 'Ukończone',
  DEFERRED: 'Odroczone',
  RETRY_WAIT: 'Czeka na ponowienie',
  BLOCKED: 'Zablokowane',
  FAILED: 'Błąd',
  READY: 'Gotowe',
  PARTIAL: 'Częściowe',
  REVIEW_REQUIRED: 'Wymaga przeglądu',
};
export function statusLabel(state: string) {
  return statusLabels[state as keyof typeof statusLabels] ?? 'Stan nieznany';
}
const reasons: Record<string, string> = {
  NO_CAPTIONS: 'Źródło nie udostępnia napisów.',
  LOCAL_YTDLP_NO_CAPTIONS_FINAL: 'Brak dostępnych napisów',
  LOCAL_YTDLP_NO_CAPTIONS:
    'Napisy jeszcze niedostępne; oczekiwanie na kolejną próbę.',
  QUOTA: 'Przetwarzanie czeka na odnowienie limitu dostawcy.',
  QUOTA_UNKNOWN_OR_STALE: 'Bieżący limit nie został potwierdzony.',
  MODEL_NOT_ELIGIBLE: 'Profil AI wymaga aktualnej weryfikacji dostępności.',
  SOURCE_UNAVAILABLE: 'Materiał źródłowy jest niedostępny.',
  NO_LOCAL_EXECUTOR: 'Trwała kolejka czeka na lokalny executor.',
  WORKER_OFFLINE: 'Trwała kolejka czeka na lokalny executor.',
  CHUNKS_PENDING: 'Części długiego materiału oczekują na przetworzenie.',
  PARTIAL_COVERAGE: 'Analiza ma częściowe pokrycie źródła.',
  REVIEW_REQUIRED: 'Wynik wymaga przeglądu.',
  AI_INVALID: 'Wynik nie przeszedł walidacji.',
  AI_REFUSED: 'Dostawca odmówił odpowiedzi.',
  AI_INCOMPLETE: 'Odpowiedź dostawcy jest niekompletna.',
  AI_SOURCE_ISSUES: 'Źródło ma ograniczenia wymagające przeglądu.',
  PROVIDER_UNAVAILABLE: 'Dostawca jest chwilowo niedostępny.',
  ANALYSIS_PENDING: 'Analiza oczekuje na przetworzenie.',
  TRANSCRIPT_ARCHIVE_PENDING:
    'Transkrypcja pobrana; oczekuje na zapis na Google Drive.',
};
export function reasonLabel(reason: string | null) {
  return reason === null
    ? null
    : (reasons[reason] ?? 'Szczegóły oczekiwania są dostępne w widoku System.');
}
