// Compare only trusted renderer envelopes. Source text, counts, mode, size
// warnings and every body byte remain material; only bookkeeping is ignored.
export function materialReport(markdown: string): string {
  const end = markdown.indexOf('\n---\n\n');
  if (!markdown.startsWith('---\n') || end < 0)
    throw new Error('EXPORT_PROTOCOL_INVALID');
  const header = markdown.slice(0, end);
  const revision = header.match(/^revision: ([1-9]\d*)$/gm);
  const cut = header.match(/^source_change_seq: (0|[1-9]\d*)$/gm);
  const date = header.match(/^date: (\d{4}-\d{2}-\d{2})$/m)?.[1];
  if (
    revision?.length !== 1 ||
    cut?.length !== 1 ||
    !date ||
    !header.includes('\nreport_schema_version: "1.1"\n') ||
    !/\nrenderer_version: "daily-renderer:1\.[12]"\n/.test(header)
  )
    throw new Error('EXPORT_PROTOCOL_INVALID');
  const footer = markdown.match(
    /\nEND_REPORT date=(\d{4}-\d{2}-\d{2}) revision=([1-9]\d*) item_count=(\d+) ready_count=(\d+) pending_count=(\d+)\n$/,
  );
  if (!footer || footer[1] !== date || 'revision: ' + footer[2] !== revision[0])
    throw new Error('EXPORT_PROTOCOL_INVALID');
  return (
    header
      .replace(/^revision: [1-9]\d*$/m, 'revision: *')
      .replace(/^source_change_seq: (0|[1-9]\d*)$/m, 'source_change_seq: *') +
    markdown.slice(end, footer.index) +
    `\nEND_REPORT date=${date} revision=* item_count=${footer[3]} ready_count=${footer[4]} pending_count=${footer[5]}\n`
  );
}
