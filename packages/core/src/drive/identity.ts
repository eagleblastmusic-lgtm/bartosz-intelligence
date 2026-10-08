import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { requireLocalDate } from '../projections/dates.js';
import { requireDriveId } from './client.js';
import { sha256 } from '../auth/crypto.js';

export interface ExportIdentity {
  root_id: string;
  date: string;
  connection_id: string;
  destination_key: string;
  reserved_remote_id: string | null;
  file_id: string | null;
  mode: 'COMPACT' | 'FULL';
}
export interface ExportLease {
  root_id: string;
  date: string;
  lease_owner: string;
  lease_until: string;
  fencing_token: number;
}
export class DriveExportIdentity {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwnerOrTask('DRIVE_EXPORT');
  }
  private bindings(root: string, date: string) {
    requireDriveId(root);
    requireLocalDate(date);
    return [this.context.ownerId, root, date] as const;
  }
  async ensure(
    connectionId: string,
    root: string,
    date: string,
    now: Date = new Date(),
  ): Promise<ExportIdentity> {
    const binding = this.bindings(root, date);
    if (!Number.isFinite(now.getTime()))
      throw new Error('INVALID_EXPORT_CLOCK');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(connectionId))
      throw new Error('INVALID_DRIVE_CONNECTION');
    // Only an actually qualified connection/root may create a destination.
    // Root preview itself never sets VERIFIED.
    const connected = await this.db
      .prepare(
        `SELECT connection_id FROM drive_connections WHERE owner_id=? AND connection_id=? AND auth_state='CONNECTED' AND root_id=? AND root_state='VERIFIED'`,
      )
      .bind(this.context.ownerId, connectionId, root)
      .first();
    if (!connected) throw new Error('DRIVE_ROOT_NOT_VERIFIED');
    const destination = 'drive:' + root;
    await this.db
      .prepare(
        `INSERT INTO export_state(owner_id,publication_date,timezone,destination_key,root_namespace,connection_id,dirty_seq,first_dirty_at,last_material_event_at) SELECT ?,?,'Europe/Warsaw',?,?,?,COALESCE(MAX(seq),0),?,? FROM change_log WHERE owner_id=? ON CONFLICT(owner_id,publication_date,timezone,destination_key) DO NOTHING`,
      )
      .bind(
        binding[0],
        date,
        destination,
        root,
        connectionId,
        now.toISOString(),
        now.toISOString(),
        binding[0],
      )
      .run();
    const identity = await this.get(root, date);
    if (identity.connection_id !== connectionId)
      throw new Error('EXPORT_CONNECTION_CONFLICT');
    return identity;
  }
  async get(root: string, date: string): Promise<ExportIdentity> {
    const row = await this.db
      .prepare(
        `SELECT root_namespace root_id,publication_date date,connection_id,destination_key,reserved_remote_id,file_id,mode FROM export_state WHERE owner_id=? AND root_namespace=? AND publication_date=? AND timezone='Europe/Warsaw' AND destination_key GLOB 'drive:*'`,
      )
      .bind(...this.bindings(root, date))
      .first<ExportIdentity>();
    if (!row) throw new Error('NOT_FOUND');
    return row;
  }
  async claim(
    root: string,
    date: string,
    worker: string,
    now: Date,
  ): Promise<ExportLease> {
    const binding = this.bindings(root, date);
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(worker) ||
      !Number.isFinite(now.getTime())
    )
      throw new Error('INVALID_EXPORT_LEASE');
    const until = new Date(now.getTime() + 900000).toISOString();
    const row = await this.db
      .prepare(
        `UPDATE export_state SET lease_owner=?,lease_until=?,fencing_token=fencing_token+1 WHERE owner_id=? AND root_namespace=? AND publication_date=? AND destination_key GLOB 'drive:*' AND (lease_owner IS NULL OR lease_until<=?) AND EXISTS(SELECT 1 FROM drive_connections c WHERE c.owner_id=export_state.owner_id AND c.connection_id=export_state.connection_id AND c.auth_state='CONNECTED' AND c.root_id=export_state.root_namespace AND c.root_state='VERIFIED') RETURNING fencing_token`,
      )
      .bind(worker, until, ...binding, now.toISOString())
      .first<{ fencing_token: number }>();
    if (!row) throw new Error('EXPORT_LEASE_UNAVAILABLE');
    return {
      root_id: root,
      date,
      lease_owner: worker,
      lease_until: until,
      fencing_token: row.fencing_token,
    };
  }
  async reserve(lease: ExportLease, remoteId: string, now: Date) {
    requireDriveId(remoteId);
    const binding = this.bindings(lease.root_id, lease.date);
    if (!Number.isFinite(now.getTime()))
      throw new Error('INVALID_EXPORT_LEASE');
    const result = await this.db
      .prepare(
        `UPDATE export_state SET reserved_remote_id=COALESCE(reserved_remote_id,?) WHERE owner_id=? AND root_namespace=? AND publication_date=? AND destination_key GLOB 'drive:*' AND lease_owner=? AND lease_until>? AND fencing_token=? AND (reserved_remote_id IS NULL OR reserved_remote_id=?)`,
      )
      .bind(
        remoteId,
        ...binding,
        lease.lease_owner,
        now.toISOString(),
        lease.fencing_token,
        remoteId,
      )
      .run();
    if (result.meta.changes !== 1) throw new Error('EXPORT_STALE_FENCE_OR_ID');
    return this.get(lease.root_id, lease.date);
  }
  async release(lease: ExportLease) {
    const result = await this.db
      .prepare(
        `UPDATE export_state SET lease_owner=NULL,lease_until=NULL WHERE owner_id=? AND root_namespace=? AND publication_date=? AND destination_key GLOB 'drive:*' AND lease_owner=? AND fencing_token=?`,
      )
      .bind(
        ...this.bindings(lease.root_id, lease.date),
        lease.lease_owner,
        lease.fencing_token,
      )
      .run();
    if (result.meta.changes !== 1) throw new Error('EXPORT_STALE_FENCE_OR_ID');
  }
  async appProperties(root: string, date: string) {
    this.bindings(root, date);
    return {
      bi_owner: await sha256(this.context.ownerId),
      bi_day: date,
      bi_export_key: await sha256(
        JSON.stringify([this.context.ownerId, root, date, 'text/markdown']),
      ),
    };
  }
}
