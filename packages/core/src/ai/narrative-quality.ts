import { summaryNarrative } from '../../../contracts/src/narrative.js';

export const radioNarrativeValidationVersion = 'radio-narrative:2';

/** Conservative structural checks. Neither word count nor these detectors
 * prove information density, entailment, fluency or semantic truth. */
export function assessSummaryNarrative(notes: readonly { text_pl: string }[]) {
  const text = summaryNarrative(notes);
  const raw = notes.map((row) => row.text_pl).join('\n');
  const findings: string[] = [];
  if (
    /(?:^|\n)\s*(?:[-*•]\s|\d+[.)]\s|#{1,6}\s|\|.*\|)/u.test(raw) ||
    /https?:\/\/|www\.|\[[^\]]*\]\([^)]*\)|[`*_]|<\/?[a-z][^>]*>/iu.test(raw) ||
    /\[\d{1,2}:\d{2}(?::\d{2})?\]|\b\d{1,2}:\d{2}:\d{2}\b|\b(?:segment_refs|evidence_ids|run_id|source_artifact_id)\b/iu.test(
      raw,
    ) ||
    // Wire aliases are case-sensitive. S3 storage and EV3 robotics are valid
    // source names, not leaked source/evidence identifiers.
    /\b(?:s|ev)[0-9]{1,6}\b/u.test(raw)
  )
    findings.push('NARRATIVE_FORMAT');
  if (
    /\b(?:w tym filmie|film (?:opowiada|przedstawia|omawia)|autor (?:opowiada|mówi) o)\b/iu.test(
      text,
    )
  )
    findings.push('NARRATIVE_TEASER');
  if (
    /(?:warto obejrzeć (?:ten )?film|nie możesz tego przegapić|ten (?:fascynujący|niezwykły) materiał|temat jest bardzo (?:ciekawy|interesujący))/iu.test(
      text,
    )
  )
    findings.push('NARRATIVE_FILLER');
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/gu) ?? [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    const key = sentence.toLocaleLowerCase('pl').replace(/\s+/gu, ' ').trim();
    if (key.length < 30) continue;
    if (seen.has(key)) findings.push('NARRATIVE_REPETITION');
    seen.add(key);
  }
  const words =
    text.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return {
    version: radioNarrativeValidationVersion,
    findings: [...new Set(findings)],
    word_count: words,
    length_guidance:
      words < 180
        ? 'SHORT'
        : words <= 260
          ? 'STANDARD'
          : words <= 350
            ? 'EXTENDED'
            : 'LONG',
    length_is_acceptance_gate: false,
    information_density: 'NOT_ASSERTED' as const,
  };
}
