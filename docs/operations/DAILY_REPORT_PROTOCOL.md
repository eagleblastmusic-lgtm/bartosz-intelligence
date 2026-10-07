# Daily Markdown protocol 1.1

The server renderer projects the whole publication day in Europe/Warsaw from
existing accepted results. It performs no AI requests. GUI filters are not inputs.
`captureDailyExport` reads every keyset page through `DailyProjection`, verifies
selected canonical artifacts through `ArtifactRepository`, and checks the final
Core change sequence. Any change invalidates the attempt; retry the capture rather
than publishing mixed results. A later material change requires a new revision.

The renderer accepts only a complete dated snapshot with consistent counts and
selection/hash pins. Unknown publication dates remain in the application's
separate undated view. Ordering matches Daily: publication descending, then Item ID
descending. Pending means all Items without complete analysis; blocked and failed
are subsets. Partial analysis is not READY. Empty Custom collections and disabled
summary/key points do not manufacture content.

COMPACT retains the first complete summary, up to three complete key points and
six existing entity/tool labels. Optional typed additions are off. When no summary
or points exist, one complete selected typed unit is retained in canonical module
order, including attribution, qualifiers and kind-specific fields. A relation
retains both complete sides and SOURCE_INFERENCE attribution. Tools-only Custom
retains contexts and labels. No unit is rewritten or cut within its text.

Compaction levels are deterministic: 0 = three points, 1 = two, 2 = one,
3 = one and no optional entity labels. First summary, first available point,
Custom fallback and every Item's metadata remain. The default soft target is
16,000 estimated tokens. If the minimum is larger, the whole report remains and
`bridge_size_state` is OVERSIZE. This does not establish consumer capacity.
FULL includes existing selected modules and canonical Evidence; it does not
generate broader analysis or copy transcripts. Export mode is content, not file
identity. Durable Drive mapping and publication are separate integration work.

The UTF-8 file uses LF, frontmatter delimited by `---`, a blank line, body and
`END_REPORT` footer. Body starts at `# Bartosz Intelligence` and ends with the LF
immediately before `END_REPORT`. `body_sha256` excludes frontmatter and footer.
The separate `content_hash` covers every exported byte. Each Item begins with
exactly `ITEM <item_id>`. Untrusted fields are escaped into individual Markdown
lines, including line breaks, HTML and protocol markers; links allow only HTTPS.
Generated timestamps are not inserted on each read, so freshness sampling does
not change bytes or start a perpetual dirty loop.

Actual byte count and `ceil(UTF-8 bytes / 3)` estimate are computed after final
render and kept outside the body. Estimator `utf8-ceil-div3:1` has no verified
consumer tokenizer or measured safety margin; it is neither billing usage nor a
promise of ChatGPT capacity. Counts, omitted detail units, revision, cut, mode,
compaction and size state are explicit. Footer presence alone does not prove a
consumer has read every block.

Local coverage includes an independent Node SHA/parser, all statuses, whole-day
pagination, final-cut changes, Custom negation/qualifiers, tools-only and empty
arrays, FULL Evidence, hostile markers, deterministic bytes and a 504-Item
oversized corpus. SQLite verifies the accepted synthetic canonical artifact and
immutability path. These tests do not qualify Drive OAuth, remote conditional
updates, Bridge, human semantic quality or production capacity.

`ExportDirtyDays` replays owner-scoped change_log pages of at most 100 events.
Late Item/job/selection changes target the original Warsaw publication day;
publication correction targets old and new days. A qualified connection gets a
durable destination for a new day. Source coverage, shared entity identity and
corrections conservatively dirty existing reports. Organization filters and
registry drafts do not dirty the unfiltered accepted report. Replay and cursor
advance share a transaction for each event; the cursor is included in backup.

The due query applies a ten-minute debounce and thirty-minute maximum wall-clock
wait, orders oldest dirty days first, and admits only connected/verified roots
without an active lease. Explicit first exports include empty days. Older
completion advances only exported_seq, preserving a newer dirty_seq. This is
local queue correctness; executor availability accounting, scheduler wiring,
material-change suppression, mode controls and live latency qualification are
still required before claiming the complete CP-7.4 acceptance.
