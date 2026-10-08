import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';

/** Only immutable, complete actual trials qualify the selected upload method. */
export async function driveGuardQualification(
  db: Database,
  context: AccessContext,
  connectionId: string,
  rootId: string,
) {
  assertContext(context);
  context.requireOwner();
  const prefix =
    'drive-guard-probe:' +
    (await sha256(JSON.stringify([connectionId, rootId]))) +
    ':';
  const rows = (
    await db
      .prepare(
        `SELECT a.payload_json intent,a.content_hash intent_hash,b.payload_json receipt,b.content_hash receipt_hash FROM config_versions a JOIN config_versions b ON b.owner_id=a.owner_id AND b.config_id=a.config_id AND b.revision=2 WHERE a.owner_id=? AND a.revision=1 AND substr(a.config_id,1,length(?))=? ORDER BY a.created_at DESC LIMIT 3`,
      )
      .bind(context.ownerId, prefix, prefix)
      .all<{
        intent: string;
        intent_hash: string;
        receipt: string;
        receipt_hash: string;
      }>()
  ).results;
  for (const row of rows) {
    if (
      (await sha256(row.intent)) !== row.intent_hash ||
      (await sha256(row.receipt)) !== row.receipt_hash
    )
      continue;
    let intent, receipt;
    try {
      intent = JSON.parse(row.intent);
      receipt = JSON.parse(row.receipt);
    } catch {
      continue;
    }
    if (
      intent?.version === 'drive-guard-probe-intent:1' &&
      intent.connection_id === connectionId &&
      intent.root_id === rootId &&
      intent.method === 'V2_MEDIA_PUT_IF_MATCH' &&
      receipt?.status === 'PASS' &&
      receipt.method === intent.method &&
      receipt.concurrent_writers === 2 &&
      receipt.version === 'drive-upload-guard-probe:1' &&
      receipt.phase === 'PROBE' &&
      receipt.accepted_writers === 1 &&
      receipt.rejected_http_status === 412 &&
      receipt.current_guard_write === 'PASS' &&
      receipt.stable_readback === 'PASS'
    )
      return row.receipt_hash;
  }
  return null;
}
