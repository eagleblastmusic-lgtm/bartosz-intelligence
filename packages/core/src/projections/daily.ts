import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { decodeCursor, encodeCursor, pageLimit } from '../db/cursor.js';
import { sha256 } from '../auth/crypto.js';
import { localDayRange, monthDays } from './dates.js';
import { ArtifactRepository } from '../artifacts/store.js';
import type {
  CanonicalDescriptor,
  ItemDetail,
} from '../../../contracts/src/item-detail.js';
import type {
  AcceptedView,
  AnalysisReadiness,
  CalendarSnapshot,
  DailyCounts,
  DailySnapshot,
  SourceCoverage,
  SourceProgress,
} from '../../../contracts/src/daily.js';

interface ReadRow {
  item_id: string;
  source_id: string;
  canonical_url: string;
  published_at: string | null;
  publication_provenance: string;
  discovered_at: string;
  current_revision_id: string;
  metadata_json: string;
  creator: string;
  run_id: string | null;
  selection_revision: number | null;
  view_json: string | null;
  readiness: AnalysisReadiness;
  reason_code: string | null;
  state: string | null;
  due_at: string | null;
}
type Range = { start: string; end: string };
function counts(row: Record<string, number>): DailyCounts {
  const items = row.items ?? 0,
    ready = row.ready ?? 0;
  return {
    items,
    ready,
    pending: items - ready,
    blocked: row.blocked ?? 0,
    failed: row.failed ?? 0,
  };
}
function covers(windows: Range[], range: Range) {
  let covered = range.start;
  for (const window of windows
    .slice()
    .sort((a, b) => a.start.localeCompare(b.start))) {
    if (window.end <= covered) continue;
    if (window.start > covered) return false;
    covered = window.end;
    if (covered >= range.end) return true;
  }
  return false;
}
function sourceComplete(source: SourceCoverage, range: Range) {
  if (
    !covers(
      source.complete_windows.map((w) => ({
        start: w.window_start,
        end: w.window_end,
      })),
      range,
    )
  )
    return false;
  // A recent partial scan cannot become complete through an older watermark.
  return source.incomplete_windows
    .filter((w) => w.window_start < range.end && w.window_end > range.start)
    .every((open) =>
      covers(
        source.complete_windows
          .filter((w) => w.completed_at >= open.started_at)
          .map((w) => ({ start: w.window_start, end: w.window_end })),
        {
          start:
            open.window_start > range.start ? open.window_start : range.start,
          end: open.window_end < range.end ? open.window_end : range.end,
        },
      ),
    );
}
const joins = `FROM items i
JOIN item_revisions m ON m.owner_id=i.owner_id AND m.item_id=i.item_id AND m.revision_id=i.current_revision_id
LEFT JOIN channels c ON c.owner_id=i.owner_id AND c.source_id=i.source_id
LEFT JOIN active_analysis_selections s ON s.owner_id=i.owner_id AND s.item_id=i.item_id
LEFT JOIN analysis_runs r ON r.owner_id=i.owner_id AND r.item_id=i.item_id AND r.run_id=s.accepted_run_id AND r.state='ACCEPTED' AND json_extract(r.outcome_json,'$.version')='intelligence-accepted:1'
LEFT JOIN jobs j ON j.owner_id=i.owner_id AND j.job_id=(SELECT q.job_id FROM jobs q WHERE q.owner_id=i.owner_id AND q.item_id=i.item_id AND q.task_type IN ('ANALYZE','FETCH_TRANSCRIPT','NORMALIZE') AND (q.task_type!='ANALYZE' OR json_extract(q.payload_json,'$.snapshot.settings.mode')='PRODUCTION') AND json_type(q.payload_json,'$.snapshot.chunk') IS NULL ORDER BY q.created_at DESC,q.job_id DESC LIMIT 1)`;
const readiness = `CASE WHEN r.run_id IS NOT NULL THEN CASE WHEN json_extract(r.outcome_json,'$.view.coverage_complete')=0 OR json_extract(r.outcome_json,'$.view.status')='INSUFFICIENT_SOURCE' THEN 'PARTIAL' ELSE 'READY' END
WHEN i.availability IN ('PRIVATE','DELETED') OR j.state='BLOCKED' THEN 'BLOCKED'
WHEN j.state='FAILED' THEN 'FAILED'
WHEN j.reason_code IN ('REVIEW_REQUIRED','AI_INVALID','AI_REFUSED','AI_INCOMPLETE','AI_SOURCE_ISSUES') THEN 'REVIEW_REQUIRED'
ELSE 'PENDING' END`;
export class DailyProjection {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  async sourceProgress(sourceId: string): Promise<SourceProgress> {
    this.sources([sourceId]);
    const owner = this.context.ownerId;
    const rows = await this.db.batch([
      this.db
        .prepare(
          'SELECT source_id FROM sources WHERE owner_id=? AND source_id=?',
        )
        .bind(owner, sourceId),
      this.db
        .prepare(
          `WITH cohort AS (SELECT ${readiness} readiness ${joins} WHERE i.owner_id=? AND i.source_id=?) SELECT COUNT(*) items,COALESCE(SUM(readiness='READY'),0) ready,COALESCE(SUM(readiness='BLOCKED'),0) blocked,COALESCE(SUM(readiness='FAILED'),0) failed FROM cohort`,
        )
        .bind(owner, sourceId),
      this.db
        .prepare(
          `SELECT d.scan_id,d.job_id,d.window_start,d.window_end,d.coverage,d.enumerated_count,d.pages_committed,d.completed_at,j.state,j.reason_code,j.due_at FROM discovery_scans d JOIN jobs j ON j.owner_id=d.owner_id AND j.job_id=d.job_id WHERE d.owner_id=? AND d.source_id=? ORDER BY d.started_at DESC,d.scan_id DESC LIMIT 1`,
        )
        .bind(owner, sourceId),
      this.db
        .prepare(
          `SELECT COUNT(*) scheduled FROM discovery_scan_members m WHERE m.owner_id=? AND m.scan_id=(SELECT scan_id FROM discovery_scans WHERE owner_id=? AND source_id=? ORDER BY started_at DESC,scan_id DESC LIMIT 1) AND EXISTS(SELECT 1 FROM jobs q WHERE q.owner_id=m.owner_id AND q.item_id=m.item_id AND q.task_type='FETCH_TRANSCRIPT')`,
        )
        .bind(owner, owner, sourceId),
    ]);
    if (!rows[0]?.results?.length) throw new Error('NOT_FOUND');
    const scan = (rows[2]?.results?.[0] as SourceProgress['scan']) ?? null;
    return {
      source_id: sourceId,
      sampled_at: new Date().toISOString(),
      counts: counts(rows[1]?.results?.[0] as Record<string, number>),
      scan,
      scheduled: Number(
        (rows[3]?.results?.[0] as { scheduled: number }).scheduled,
      ),
      total:
        scan?.coverage === 'COMPLETE' && scan.completed_at
          ? scan.enumerated_count
          : null,
    };
  }
  async canonicalDescriptor(
    itemId: string,
    runId: string,
  ): Promise<CanonicalDescriptor> {
    const run = await this.db
      .prepare(
        "SELECT outcome_json,candidate_hash FROM analysis_runs WHERE owner_id=? AND item_id=? AND run_id=? AND state='ACCEPTED'",
      )
      .bind(this.context.ownerId, itemId, runId)
      .first<{ outcome_json: string; candidate_hash: string }>();
    if (!run || (await sha256(run.outcome_json)) !== run.candidate_hash)
      throw new Error('NOT_FOUND');
    const outcome = JSON.parse(run.outcome_json) as {
      version: string;
      canonical_artifact_id: string;
      canonical_hash: string;
      source_artifact_id: string;
    };
    if (
      outcome.version !== 'intelligence-accepted:1' ||
      !outcome.canonical_artifact_id
    )
      throw new Error('NOT_FOUND');
    const artifact = await new ArtifactRepository(this.db, this.context).get(
      outcome.canonical_artifact_id,
    );
    if (
      artifact.item_id !== itemId ||
      artifact.kind !== 'ANALYSIS_CANDIDATE' ||
      artifact.original_ref !== outcome.source_artifact_id ||
      artifact.state !== 'VERIFIED' ||
      artifact.schema_version !== 'intelligence-canonical:1.2' ||
      artifact.content_hash !== outcome.canonical_hash ||
      artifact.byte_size > 8 * 1024 * 1024
    )
      throw new Error('VERIFIED_ARTIFACT_REQUIRED');
    return {
      artifact_id: artifact.artifact_id,
      content_hash: artifact.content_hash,
      byte_size: artifact.byte_size,
      chunk_count: artifact.chunk_count,
      schema_version: artifact.schema_version,
    };
  }
  async detail(itemId: string): Promise<ItemDetail> {
    const row = await this.db
      .prepare(
        `SELECT i.item_id,i.canonical_url,i.published_at,m.metadata_json,COALESCE(c.title,'Źródło') creator,r.run_id,s.selection_revision,json_extract(r.outcome_json,'$.view') view_json,${readiness} readiness,j.state,j.reason_code ${joins} WHERE i.owner_id=? AND i.item_id=?`,
      )
      .bind(this.context.ownerId, itemId)
      .first<ReadRow>();
    if (!row) throw new Error('NOT_FOUND');
    const metadata = JSON.parse(row.metadata_json) as { title: string };
    return {
      item_id: row.item_id,
      title: metadata.title,
      creator: row.creator,
      canonical_url: row.canonical_url,
      published_at: row.published_at,
      analysis_status: row.readiness,
      processing_state: row.state,
      reason:
        row.run_id && row.readiness === 'PARTIAL'
          ? 'PARTIAL_COVERAGE'
          : row.reason_code,
      selected_run_id: row.run_id,
      selection_revision: row.selection_revision,
      view: row.view_json ? (JSON.parse(row.view_json) as AcceptedView) : null,
      canonical: row.run_id
        ? await this.canonicalDescriptor(itemId, row.run_id)
        : null,
      semantic_verification: 'NOT_ASSERTED',
    };
  }
  private sources(ids: readonly string[]) {
    if (
      ids.length > 50 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    )
      throw new Error('INVALID_SOURCE_FILTER');
    return JSON.stringify([...ids].sort());
  }
  private cohort(range: Range | null) {
    return `WITH cohort AS (SELECT i.*,m.metadata_json,COALESCE(c.title,'Źródło') creator,r.run_id,s.selection_revision,json_extract(r.outcome_json,'$.view') view_json,${readiness} readiness,j.state,j.reason_code,j.due_at ${joins}
WHERE i.owner_id=? AND ${range ? 'i.published_at>=? AND i.published_at<?' : 'i.published_at IS NULL'} AND (?='[]' OR i.source_id IN (SELECT value FROM json_each(?))))`;
  }
  private cohortBindings(range: Range | null, sources: string) {
    return [
      this.context.ownerId,
      ...(range ? [range.start, range.end] : []),
      sources,
      sources,
    ];
  }
  private coverageStatement(range: Range | null, sources: string) {
    return this.db
      .prepare(
        `SELECT s.source_id,COALESCE(c.title,s.external_id) title,s.enabled,s.window_start,s.last_complete_window_end,
COALESCE((SELECT json_group_array(json_object('window_start',d.window_start,'window_end',d.window_end,'completed_at',d.completed_at)) FROM discovery_scans d WHERE d.owner_id=s.owner_id AND d.source_id=s.source_id AND d.coverage='COMPLETE' AND d.completed_at IS NOT NULL AND (? IS NULL OR (d.window_start<? AND d.window_end>?))),'[]') complete_json,
COALESCE((SELECT json_group_array(json_object('window_start',d.window_start,'window_end',d.window_end,'coverage',d.coverage,'started_at',d.started_at)) FROM discovery_scans d WHERE d.owner_id=s.owner_id AND d.source_id=s.source_id AND d.coverage!='COMPLETE' AND (? IS NULL OR (d.window_start<? AND d.window_end>?))),'[]') incomplete_json
FROM sources s LEFT JOIN channels c ON c.owner_id=s.owner_id AND c.source_id=s.source_id WHERE s.owner_id=? AND (?='[]' OR s.source_id IN (SELECT value FROM json_each(?))) ORDER BY s.source_id`,
      )
      .bind(
        range?.start ?? null,
        range?.end ?? null,
        range?.start ?? null,
        range?.start ?? null,
        range?.end ?? null,
        range?.start ?? null,
        this.context.ownerId,
        sources,
        sources,
      );
  }
  private readCoverage(
    rows: unknown[],
    ids: readonly string[],
  ): SourceCoverage[] {
    const sources = rows.map((value) => {
      const row = value as Omit<SourceCoverage, 'enabled'> & {
        enabled: number;
        complete_json: string;
        incomplete_json: string;
      };
      return {
        source_id: row.source_id,
        title: row.title,
        enabled: row.enabled === 1,
        window_start: row.window_start,
        last_complete_window_end: row.last_complete_window_end,
        complete_windows: JSON.parse(row.complete_json),
        incomplete_windows: JSON.parse(row.incomplete_json),
      };
    });
    if (ids.length && sources.length !== ids.length)
      throw new Error('NOT_FOUND');
    return sources;
  }
  async day(
    input: {
      date: string | null;
      timezone: string;
      source_ids?: string[];
      cursor?: string;
      limit: number;
    },
    secret: string,
    now: Date,
  ): Promise<DailySnapshot> {
    this.context.requireOwner();
    pageLimit(input.limit);
    if (input.timezone !== 'Europe/Warsaw' || !Number.isFinite(now.getTime()))
      throw new Error('INVALID_TIMEZONE');
    const range =
        input.date === null ? null : localDayRange(input.date, input.timezone),
      ids = input.source_ids ?? [],
      sources = this.sources(ids);
    const kind =
      'daily:' +
      (await sha256(JSON.stringify([input.date, input.timezone, sources])));
    const cursor = input.cursor
      ? await decodeCursor(input.cursor, this.context.ownerId, kind, secret)
      : null;
    const bindings = this.cohortBindings(range, sources),
      cohort = this.cohort(range),
      sort = range ? 'published_at' : 'discovered_at';
    const result = await this.db.batch([
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq),0) cut_seq FROM change_log WHERE owner_id=?',
        )
        .bind(this.context.ownerId),
      this.db
        .prepare(
          `${cohort} SELECT COUNT(*) items,COALESCE(SUM(readiness='READY'),0) ready,COALESCE(SUM(readiness='BLOCKED'),0) blocked,COALESCE(SUM(readiness='FAILED'),0) failed FROM cohort`,
        )
        .bind(...bindings),
      this.db
        .prepare(
          `${cohort} SELECT * FROM cohort WHERE (? IS NULL OR ${sort}<? OR (${sort}=? AND item_id<?)) ORDER BY ${sort} DESC,item_id DESC LIMIT ?`,
        )
        .bind(
          ...bindings,
          cursor?.time ?? null,
          cursor?.time ?? null,
          cursor?.time ?? null,
          cursor?.id ?? null,
          input.limit + 1,
        ),
      this.coverageStatement(range, sources),
    ]);
    const seq = Number(
      (result[0]?.results?.[0] as { cut_seq: number }).cut_seq,
    );
    if (cursor && cursor.snapshot !== String(seq))
      throw new Error('READ_SNAPSHOT_CHANGED');
    const coverage = this.readCoverage(result[3]?.results ?? [], ids),
      rows = (result[2]?.results ?? []) as ReadRow[],
      page = rows.slice(0, input.limit),
      last = page.at(-1);
    const totals = counts(result[1]?.results?.[0] as Record<string, number>);
    const discoveryComplete =
      range !== null &&
      coverage.length > 0 &&
      coverage.every((source) => sourceComplete(source, range));
    return {
      date: input.date,
      timezone: 'Europe/Warsaw',
      cut_seq: seq,
      projection_revision: await sha256(JSON.stringify([kind, seq])),
      counts: totals,
      discovery_complete: discoveryComplete,
      complete: discoveryComplete && totals.pending === 0,
      partial: !discoveryComplete || totals.pending > 0,
      source_coverage: coverage,
      freshness: { sampled_at: now.toISOString(), status: 'CURRENT' },
      items: page.map((row) => {
        const metadata = JSON.parse(row.metadata_json) as {
          title: string;
          duration_seconds: number | null;
        };
        const view = row.view_json
          ? (JSON.parse(row.view_json) as AcceptedView)
          : null;
        return {
          item_id: row.item_id,
          source_id: row.source_id,
          title: metadata.title,
          creator: row.creator,
          canonical_url: row.canonical_url,
          published_at: row.published_at,
          publication_provenance: row.publication_provenance,
          duration_seconds: metadata.duration_seconds,
          metadata_revision: row.current_revision_id,
          selected_run_id: row.run_id,
          selection_revision: row.selection_revision,
          analysis_status: row.readiness,
          reason: row.run_id
            ? row.readiness === 'PARTIAL'
              ? 'PARTIAL_COVERAGE'
              : null
            : (row.reason_code ??
              (row.readiness === 'BLOCKED'
                ? 'SOURCE_UNAVAILABLE'
                : 'ANALYSIS_PENDING')),
          retry_at: ['PENDING', 'DEFERRED', 'RETRY_WAIT'].includes(
            row.state ?? '',
          )
            ? row.due_at
            : null,
          processing_state: row.state,
          view,
        };
      }),
      next_cursor:
        rows.length > input.limit && last
          ? await encodeCursor(
              {
                owner: this.context.ownerId,
                kind,
                snapshot: String(seq),
                time: (range ? last.published_at : last.discovered_at)!,
                id: last.item_id,
              },
              secret,
            )
          : null,
    };
  }
  async calendar(
    month: string,
    sourceIds: string[],
    now: Date,
  ): Promise<CalendarSnapshot> {
    this.context.requireOwner();
    const days = monthDays(month),
      range = { start: days[0]!.start, end: days.at(-1)!.end },
      sources = this.sources(sourceIds),
      cohort = this.cohort(range);
    const result = await this.db.batch([
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq),0) cut_seq FROM change_log WHERE owner_id=?',
        )
        .bind(this.context.ownerId),
      this.db
        .prepare(
          `${cohort}, days(date,start,end) AS (VALUES ${days.map(() => '(?,?,?)').join(',')}) SELECT d.date,COUNT(c.item_id) items,COALESCE(SUM(c.readiness='READY'),0) ready,COALESCE(SUM(c.readiness='BLOCKED'),0) blocked,COALESCE(SUM(c.readiness='FAILED'),0) failed FROM days d LEFT JOIN cohort c ON c.published_at>=d.start AND c.published_at<d.end GROUP BY d.date ORDER BY d.date`,
        )
        .bind(
          ...this.cohortBindings(range, sources),
          ...days.flatMap((day) => [day.date, day.start, day.end]),
        ),
      this.coverageStatement(range, sources),
    ]);
    const seq = Number(
        (result[0]?.results?.[0] as { cut_seq: number }).cut_seq,
      ),
      coverage = this.readCoverage(result[2]?.results ?? [], sourceIds);
    return {
      month,
      timezone: 'Europe/Warsaw',
      cut_seq: seq,
      projection_revision: await sha256(
        JSON.stringify(['calendar', month, sources, seq]),
      ),
      freshness: { sampled_at: now.toISOString(), status: 'CURRENT' },
      days: (result[1]?.results ?? []).map((value) => {
        const row = value as Record<string, number> & { date: string },
          day = days.find((d) => d.date === row.date)!,
          totals = counts(row),
          discoveryComplete =
            coverage.length > 0 &&
            coverage.every((source) => sourceComplete(source, day));
        return {
          date: row.date,
          counts: totals,
          discovery_complete: discoveryComplete,
          complete: discoveryComplete && totals.pending === 0,
        };
      }),
    };
  }
}
