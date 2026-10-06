import type { AcceptedView } from '../../../contracts/src/daily.js';
import type { enrichEconomy } from '../ai/enrichment/canonical.js';
type Canonical = Awaited<ReturnType<typeof enrichEconomy>>['canonical'];
// A bounded deterministic preview of the accepted canonical. Whole notes are
// retained in order; no AI, word truncation, or new semantic ranking occurs.
export function acceptedView(
  canonical: Canonical,
  relationalCoverage?: AcceptedView['relational_coverage'],
): AcceptedView {
  return {
    version: 'accepted-view:1',
    status: canonical.status,
    enabled_modules: [...canonical.enabled_modules],
    coverage_complete: relationalCoverage !== 'WITHIN_CHUNKS_ONLY',
    ...(relationalCoverage ? { relational_coverage: relationalCoverage } : {}),
    summary_pl: canonical.summary_pl.slice(0, 1),
    key_points: canonical.key_points.slice(0, 3),
    entities: canonical.entities
      .slice(0, 6)
      .map(({ entity_id, label, entity_type }) => ({
        entity_id,
        label,
        entity_type,
      })),
    tools: canonical.tools
      .slice(0, 6)
      .map(({ entity_ref, context_pl }) => ({ entity_ref, context_pl })),
    typed_counts: Object.fromEntries(
      [
        'claims',
        'stance',
        'predictions',
        'usage',
        'recommendations',
        'uncertainties',
        'contradictions',
      ].map((kind) => [kind, canonical[kind as 'claims'].length]),
    ),
  };
}
