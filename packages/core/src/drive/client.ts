import { fetchWithoutRedirect } from '../http/no-redirect.js';
import { sha256 } from '../auth/crypto.js';

export type DriveFailureCategory =
  | 'AUTH'
  | 'DENIED'
  | 'NOT_FOUND'
  | 'QUOTA'
  | 'TRANSIENT'
  | 'CONFLICT'
  | 'FORMAT'
  | 'TRANSPORT'
  | 'UNQUALIFIED_UPDATE';
export class DriveFailure extends Error {
  constructor(
    readonly category: DriveFailureCategory,
    readonly retry_after_seconds: number | null = null,
    readonly http_status: number | null = null,
  ) {
    super('DRIVE_' + category);
  }
}
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  version?: string;
  modifiedTime?: string;
  inheritedPermissionsDisabled?: boolean;
  appProperties?: Record<string, string>;
  capabilities?: {
    canAddChildren?: boolean;
    canEdit?: boolean;
    canDownload?: boolean;
  };
}
const fileFields =
  'id,name,mimeType,parents,trashed,version,modifiedTime,inheritedPermissionsDisabled,appProperties,capabilities(canAddChildren,canEdit,canDownload)';
export function requireDriveId(id: string) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new DriveFailure('FORMAT');
  return id;
}
async function boundedBody(response: Response, maximum: number) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new DriveFailure('FORMAT');
      }
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (error) {
    if (error instanceof DriveFailure) throw error;
    throw new DriveFailure('FORMAT');
  } finally {
    reader.releaseLock();
  }
}
function file(value: unknown): DriveFile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DriveFailure('FORMAT');
  const row = value as DriveFile;
  requireDriveId(row.id);
  if (
    typeof row.name !== 'string' ||
    row.name.length > 1024 ||
    typeof row.mimeType !== 'string' ||
    (row.parents !== undefined &&
      (!Array.isArray(row.parents) ||
        row.parents.some(
          (id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id),
        ))) ||
    (row.trashed !== undefined && typeof row.trashed !== 'boolean')
  )
    throw new DriveFailure('FORMAT');
  return row;
}
/** Fixed Google origins only; no arbitrary URLs, automatic retries or redirects.
 * A caller owns durable admission, attempt receipts and ambiguity recovery. */
export class DriveClient {
  readonly #accessToken: string;
  readonly #transport: typeof fetch;
  constructor(accessToken: string, transport: typeof fetch = fetch) {
    if (!/^[\x21-\x7e]{1,8192}$/.test(accessToken))
      throw new DriveFailure('AUTH');
    this.#accessToken = accessToken;
    this.#transport = transport;
  }
  private async request(
    path: string,
    options: RequestInit = {},
    upload = false,
    version: 'v3' | 'v2' = 'v3',
    timeoutMs = 15000,
  ) {
    const target =
      'https://www.googleapis.com/' +
      (upload ? 'upload/drive/' : 'drive/') +
      version +
      '/' +
      path;
    const response = await fetchWithoutRedirect(
      target,
      {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...options.headers,
          Authorization: 'Bearer ' + this.#accessToken,
        },
      },
      this.#transport,
    ).catch(() => {
      throw new DriveFailure('TRANSPORT');
    });
    if (response.ok) return response;
    const retry = response.headers.get('Retry-After');
    const retryAfter =
      retry && /^\d{1,5}$/.test(retry) ? Math.min(3600, Number(retry)) : null;
    let quota = false;
    if (response.status === 403) {
      try {
        const error = JSON.parse(await boundedBody(response, 32768)).error;
        quota =
          Array.isArray(error?.errors) &&
          error.errors.some((row: { reason?: unknown }) =>
            [
              'rateLimitExceeded',
              'userRateLimitExceeded',
              'storageQuotaExceeded',
              'dailyLimitExceeded',
            ].includes(String(row.reason)),
          );
      } catch {
        /* unknown/private error body is never propagated */
      }
    } else await response.body?.cancel();
    throw new DriveFailure(
      response.status === 401
        ? 'AUTH'
        : response.status === 404
          ? 'NOT_FOUND'
          : response.status === 409 || response.status === 412
            ? 'CONFLICT'
            : response.status === 429 || quota
              ? 'QUOTA'
              : response.status >= 500
                ? 'TRANSIENT'
                : 'DENIED',
      retryAfter,
      response.status,
    );
  }
  private async json(response: Response): Promise<Record<string, unknown>> {
    try {
      const value: unknown = JSON.parse(await boundedBody(response, 65536));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new DriveFailure('FORMAT');
      return value as Record<string, unknown>;
    } catch {
      throw new DriveFailure('FORMAT');
    }
  }
  async reserveId() {
    const result = await this.json(
      await this.request('files/generateIds?count=1&space=drive&type=files'),
    );
    if (
      !Array.isArray(result.ids) ||
      result.ids.length !== 1 ||
      typeof result.ids[0] !== 'string'
    )
      throw new DriveFailure('FORMAT');
    return requireDriveId(result.ids[0]);
  }
  async getFile(id: string) {
    const result = file(
      await this.json(
        await this.request(
          'files/' +
            requireDriveId(id) +
            '?fields=' +
            encodeURIComponent(fileFields),
        ),
      ),
    );
    if (result.id !== id) throw new DriveFailure('FORMAT');
    return result;
  }
  async readMarkdown(id: string, maximumBytes: number) {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 8 * 1024 * 1024
    )
      throw new DriveFailure('FORMAT');
    return boundedBody(
      await this.request('files/' + requireDriveId(id) + '?alt=media'),
      maximumBytes,
    );
  }
  async readTranscriptMarkdown(id: string) {
    return boundedBody(
      await this.request(
        'files/' + requireDriveId(id) + '?alt=media',
        {},
        false,
        'v3',
        120000,
      ),
      32 * 1024 * 1024,
    );
  }
  async createEncryptedBackup(input: {
    reserved_id: string;
    root_id: string;
    backup_id: string;
    envelope_json: string;
  }) {
    requireDriveId(input.reserved_id);
    requireDriveId(input.root_id);
    if (
      !/^[a-f0-9-]{36}$/.test(input.backup_id) ||
      new TextEncoder().encode(input.envelope_json).length > 90 * 1024 * 1024
    )
      throw new DriveFailure('FORMAT');
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(input.envelope_json) as Record<string, unknown>;
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
        throw new Error();
    } catch {
      throw new DriveFailure('FORMAT');
    }
    if (
      envelope.version !== 'canonical-backup-aes256gcm:1' ||
      envelope.backup_id !== input.backup_id ||
      Object.keys(envelope).sort().join(',') !==
        'backup_id,ciphertext,iv,key_id,plaintext_sha256,version' ||
      typeof envelope.ciphertext !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(envelope.ciphertext)
    )
      throw new DriveFailure('FORMAT');
    return this.uploadBackupFile(input, input.backup_id + '.bi-backup.json');
  }
  async createCanonicalBackup(input: {
    reserved_id: string;
    root_id: string;
    backup_id: string;
    envelope_json: string;
  }) {
    if (new TextEncoder().encode(input.envelope_json).length > 64 * 1024 * 1024)
      throw new DriveFailure('FORMAT');
    const { verifyPortableBackup } = await import('../backup/restore.js');
    try {
      const portable = JSON.parse(input.envelope_json);
      await verifyPortableBackup(portable);
      if (portable.manifest.backup_id !== input.backup_id)
        throw new Error('BACKUP_ID_MISMATCH');
    } catch {
      throw new DriveFailure('FORMAT');
    }
    return this.uploadBackupFile(input, input.backup_id + '.canonical.json');
  }
  private async uploadBackupFile(
    input: {
      reserved_id: string;
      root_id: string;
      backup_id: string;
      envelope_json: string;
    },
    name: string,
  ) {
    requireDriveId(input.reserved_id);
    requireDriveId(input.root_id);
    if (
      !/^[a-f0-9-]{36}$/.test(input.backup_id) ||
      new TextEncoder().encode(input.envelope_json).length > 90 * 1024 * 1024
    )
      throw new DriveFailure('FORMAT');
    await this.verifyPrivateFolder(input.root_id);
    const metadata = JSON.stringify({
      id: input.reserved_id,
      name,
      parents: [input.root_id],
      mimeType: 'application/json',
      appProperties: { bi_backup: input.backup_id },
    });
    let boundary: string;
    do {
      boundary = 'bi_' + crypto.randomUUID();
    } while (
      input.envelope_json.includes(boundary) ||
      metadata.includes(boundary)
    );
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${input.envelope_json}\r\n--${boundary}--\r\n`;
    const result = file(
      await this.json(
        await this.request(
          'files?uploadType=multipart&fields=' + encodeURIComponent(fileFields),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'multipart/related; boundary=' + boundary,
            },
            body,
          },
          true,
          'v3',
          120000,
        ),
      ),
    );
    if (
      result.id !== input.reserved_id ||
      result.name !== name ||
      result.mimeType !== 'application/json' ||
      !result.parents?.includes(input.root_id)
    )
      throw new DriveFailure('FORMAT');
    return result;
  }
  async readEncryptedBackup(id: string, maximumBytes: number) {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 90 * 1024 * 1024
    )
      throw new DriveFailure('FORMAT');
    return boundedBody(
      await this.request(
        'files/' + requireDriveId(id) + '?alt=media',
        {},
        false,
        'v3',
        120000,
      ),
      maximumBytes,
    );
  }
  async createMarkdown(input: {
    reserved_id: string;
    root_id: string;
    name: string;
    markdown: string;
    app_properties: Record<string, string>;
  }) {
    return this.createTextMarkdown(input, 8 * 1024 * 1024);
  }
  async createTranscriptMarkdown(input: {
    reserved_id: string;
    root_id: string;
    name: string;
    markdown: string;
    app_properties: Record<string, string>;
  }) {
    return this.createTextMarkdown(input, 32 * 1024 * 1024);
  }
  private async createTextMarkdown(
    input: {
      reserved_id: string;
      root_id: string;
      name: string;
      markdown: string;
      app_properties: Record<string, string>;
    },
    maximumBytes: number,
  ) {
    requireDriveId(input.reserved_id);
    requireDriveId(input.root_id);
    if (
      !/^[A-Za-z0-9_. -]{1,200}\.md$/.test(input.name) ||
      new TextEncoder().encode(input.markdown).length > maximumBytes ||
      Object.keys(input.app_properties).length > 6 ||
      Object.entries(input.app_properties).some(
        ([key, value]) =>
          !/^[a-z_]{1,40}$/.test(key) ||
          typeof value !== 'string' ||
          new TextEncoder().encode(key + value).length > 124,
      )
    )
      throw new DriveFailure('FORMAT');
    // A random boundary is selected against both parts, so source text cannot
    // terminate the media part or inject another metadata section.
    const metadata = JSON.stringify({
      id: input.reserved_id,
      name: input.name,
      parents: [input.root_id],
      mimeType: 'text/markdown',
      appProperties: input.app_properties,
    });
    let boundary: string;
    do {
      boundary = 'bi_' + crypto.randomUUID();
    } while (input.markdown.includes(boundary) || metadata.includes(boundary));
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${input.markdown}\r\n--${boundary}--\r\n`;
    const result = file(
      await this.json(
        await this.request(
          'files?uploadType=multipart&fields=' + encodeURIComponent(fileFields),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'multipart/related; boundary=' + boundary,
            },
            body,
          },
          true,
        ),
      ),
    );
    if (
      result.id !== input.reserved_id ||
      result.mimeType !== 'text/markdown' ||
      !result.parents?.includes(input.root_id)
    )
      throw new DriveFailure('FORMAT');
    return result;
  }
  async storage() {
    const result = await this.json(
      await this.request('about?fields=storageQuota'),
    );
    const quota = result.storageQuota as Record<string, unknown> | undefined;
    if (
      !quota ||
      typeof quota !== 'object' ||
      Array.isArray(quota) ||
      Object.values(quota).some(
        (value) => typeof value !== 'string' || !/^\d+$/.test(value),
      )
    )
      throw new DriveFailure('FORMAT');
    return {
      limit_bytes: typeof quota.limit === 'string' ? quota.limit : null,
      usage_bytes: typeof quota.usage === 'string' ? quota.usage : null,
    };
  }
  async findChildFolders(parentId: string, name: string) {
    requireDriveId(parentId);
    if (name !== 'Transkrypcje') throw new DriveFailure('FORMAT');
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder' and name='Transkrypcje'`,
      pageSize: '100',
      fields: 'nextPageToken,files(' + fileFields + ')',
    });
    const result = await this.json(await this.request('files?' + params));
    if (result.nextPageToken || !Array.isArray(result.files))
      throw new DriveFailure('FORMAT');
    return result.files.map(file);
  }
  async createFolder(input: {
    reserved_id: string;
    name: string;
    app_properties: Record<string, string>;
    parent_id?: string;
    limited_access?: true;
  }) {
    requireDriveId(input.reserved_id);
    if (input.parent_id !== undefined) requireDriveId(input.parent_id);
    if (
      !input.name.trim() ||
      input.name !== input.name.trim() ||
      /[\u0000-\u001f\u007f]/.test(input.name) ||
      new TextEncoder().encode(input.name).length > 256 ||
      Object.keys(input.app_properties).length > 6 ||
      Object.entries(input.app_properties).some(
        ([key, value]) =>
          !/^[a-z_]{1,40}$/.test(key) ||
          typeof value !== 'string' ||
          new TextEncoder().encode(key + value).length > 124,
      )
    )
      throw new DriveFailure('FORMAT');
    const result = file(
      await this.json(
        await this.request('files?fields=' + encodeURIComponent(fileFields), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: input.reserved_id,
            name: input.name,
            mimeType: 'application/vnd.google-apps.folder',
            appProperties: input.app_properties,
            ...(input.parent_id ? { parents: [input.parent_id] } : {}),
            ...(input.limited_access
              ? { inheritedPermissionsDisabled: true }
              : {}),
          }),
        }),
      ),
    );
    if (
      result.id !== input.reserved_id ||
      result.mimeType !== 'application/vnd.google-apps.folder' ||
      (input.parent_id !== undefined &&
        !result.parents?.includes(input.parent_id)) ||
      (input.limited_access === true &&
        result.inheritedPermissionsDisabled !== true)
    )
      throw new DriveFailure('FORMAT');
    return result;
  }
  async verifyPrivateFolder(id: string) {
    const result = await this.json(
      await this.request(
        'files/' +
          requireDriveId(id) +
          '/permissions?pageSize=100&fields=' +
          encodeURIComponent(
            'nextPageToken,permissions(type,role,deleted,view,inheritedPermissionsDisabled)',
          ),
      ),
    );
    if (result.nextPageToken || !Array.isArray(result.permissions))
      throw new DriveFailure('DENIED');
    const active = result.permissions.filter((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new DriveFailure('FORMAT');
      const permission = value as Record<string, unknown>;
      // Limited-access parent viewers can see folder metadata, never content.
      // Both official markers are required; unknown views remain denied.
      if (
        permission.view === 'metadata' &&
        permission.inheritedPermissionsDisabled === true
      )
        return false;
      return permission.deleted !== true;
    });
    if (
      active.length !== 1 ||
      active[0]?.type !== 'user' ||
      active[0]?.role !== 'owner'
    )
      throw new DriveFailure('DENIED');
    return { private_owner_only: true as const };
  }
  async updateMarkdown(input?: {
    id: string;
    root_id: string;
    app_properties: Record<string, string>;
    expected_hash: string;
    markdown: string;
    before_write: () => Promise<unknown>;
  }) {
    return this.updateTextMarkdown(input, 8 * 1024 * 1024);
  }
  async updateTranscriptMarkdown(input: {
    id: string;
    root_id: string;
    app_properties: Record<string, string>;
    expected_hash: string;
    markdown: string;
    before_write: () => Promise<unknown>;
  }) {
    return this.updateTextMarkdown(input, 32 * 1024 * 1024);
  }
  private async updateTextMarkdown(
    input:
      | {
          id: string;
          root_id: string;
          app_properties: Record<string, string>;
          expected_hash: string;
          markdown: string;
          before_write: () => Promise<unknown>;
        }
      | undefined,
    maximumBytes: number,
  ) {
    // Exact v2 method qualified by live trial d99d0b0d-4708-4586-9872-3923c55e96eb.
    if (!input) throw new DriveFailure('UNQUALIFIED_UPDATE');
    requireDriveId(input.id);
    requireDriveId(input.root_id);
    if (
      !/^[a-f0-9]{64}$/.test(input.expected_hash) ||
      typeof input.markdown !== 'string' ||
      new TextEncoder().encode(input.markdown).length > maximumBytes ||
      !input.app_properties ||
      Object.keys(input.app_properties).length === 0 ||
      typeof input.before_write !== 'function'
    )
      throw new DriveFailure('FORMAT');
    await this.verifyPrivateFolder(input.root_id);
    const read = () =>
      maximumBytes === 8 * 1024 * 1024
        ? this.readMarkdown(input.id, maximumBytes)
        : this.readTranscriptMarkdown(input.id);
    const metadata = async () => {
      const raw = await this.json(
        await this.request(
          'files/' +
            input.id +
            '?fields=' +
            encodeURIComponent(
              'id,mimeType,parents(id),labels(trashed),properties(key,value,visibility),etag',
            ),
          {},
          false,
          'v2',
        ),
      );
      const properties = Array.isArray(raw.properties)
        ? Object.fromEntries(
            raw.properties
              .filter((p) => p?.visibility === 'PRIVATE')
              .map((p) => [p.key, p.value]),
          )
        : {};
      if (
        raw.id !== input.id ||
        raw.mimeType !== 'text/markdown' ||
        (raw.labels as { trashed?: unknown } | undefined)?.trashed !== false ||
        !Array.isArray(raw.parents) ||
        !raw.parents.some((p) => p?.id === input.root_id) ||
        Object.entries(input.app_properties).some(
          ([key, value]) => properties[key] !== value,
        )
      )
        throw new DriveFailure('CONFLICT');
      if (
        typeof raw.etag !== 'string' ||
        !/^"[A-Za-z0-9_:/+=.-]{1,256}"$/.test(raw.etag)
      )
        throw new DriveFailure('UNQUALIFIED_UPDATE');
      return raw.etag;
    };
    const etag = await metadata();
    if (
      (await sha256(await read())) !== input.expected_hash ||
      (await metadata()) !== etag
    )
      throw new DriveFailure('CONFLICT');
    await input.before_write();
    const updated = await this.json(
      await this.request(
        'files/' + input.id + '?uploadType=media&fields=id',
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'text/markdown; charset=UTF-8',
            'If-Match': etag,
          },
          body: input.markdown,
        },
        true,
        'v2',
      ),
    );
    if (updated.id !== input.id) throw new DriveFailure('FORMAT');
    const after = await metadata();
    if (
      after === etag ||
      (await read()) !== input.markdown ||
      (await metadata()) !== after
    )
      throw new DriveFailure('CONFLICT');
    return {
      method: 'V2_MEDIA_PUT_IF_MATCH' as const,
      content_hash: await sha256(input.markdown),
    };
  }
  /** Qualification only, using a caller-persisted disposable identity. This
   * never enables updateMarkdown or touches a Daily file. No hidden retries. */
  async probeMarkdownGuard(input: {
    reserved_id: string;
    root_id: string;
    nonce: string;
    method?: 'V3_MEDIA_PATCH_IF_MATCH' | 'V2_MEDIA_PUT_IF_MATCH';
  }) {
    const v2 = input.method === 'V2_MEDIA_PUT_IF_MATCH';
    if (
      input.method !== undefined &&
      !['V3_MEDIA_PATCH_IF_MATCH', 'V2_MEDIA_PUT_IF_MATCH'].includes(
        input.method,
      )
    )
      throw new DriveFailure('FORMAT');
    requireDriveId(input.reserved_id);
    requireDriveId(input.root_id);
    if (!/^[a-f0-9]{64}$/.test(input.nonce)) throw new DriveFailure('FORMAT');
    const base =
      'Bartosz Intelligence guard probe\n' + input.nonce + '\nBASE\n';
    const metadata = async () => {
      const response = await this.request(
        'files/' +
          input.reserved_id +
          '?fields=' +
          encodeURIComponent(
            v2
              ? 'id,title,mimeType,parents(id),labels(trashed),properties(key,value,visibility),etag'
              : fileFields,
          ),
        {},
        false,
        v2 ? 'v2' : 'v3',
      );
      const raw = await this.json(response);
      const etag = v2
        ? typeof raw.etag === 'string'
          ? raw.etag
          : null
        : response.headers.get('ETag');
      const value = v2
        ? file({
            id: raw.id,
            name: raw.title,
            mimeType: raw.mimeType,
            trashed: (raw.labels as { trashed?: unknown } | undefined)?.trashed,
            parents: Array.isArray(raw.parents)
              ? raw.parents.map((parent) => parent?.id)
              : [],
            appProperties: Array.isArray(raw.properties)
              ? Object.fromEntries(
                  raw.properties
                    .filter((property) => property?.visibility === 'PRIVATE')
                    .map((property) => [property.key, property.value]),
                )
              : {},
          })
        : file(raw);
      if (
        value.id !== input.reserved_id ||
        value.mimeType !== 'text/markdown' ||
        value.trashed !== false ||
        !value.parents?.includes(input.root_id) ||
        value.appProperties?.bi_guard_probe !== input.nonce
      )
        throw new DriveFailure('DENIED');
      if (!etag || !/^"[A-Za-z0-9_:/+=.-]{1,256}"$/.test(etag))
        throw new DriveFailure('UNQUALIFIED_UPDATE');
      return { etag, value };
    };
    await this.verifyPrivateFolder(input.root_id);
    try {
      const existing = await this.getFile(input.reserved_id);
      if (
        existing.appProperties?.bi_guard_probe !== input.nonce ||
        !existing.parents?.includes(input.root_id)
      )
        throw new DriveFailure('DENIED');
    } catch (error) {
      if (!(error instanceof DriveFailure) || error.category !== 'NOT_FOUND')
        throw error;
      await this.createMarkdown({
        reserved_id: input.reserved_id,
        root_id: input.root_id,
        name: 'bi-guard-probe.md',
        markdown: base,
        app_properties: { bi_guard_probe: input.nonce },
      });
    }
    const initial = await metadata();
    if ((await this.readMarkdown(input.reserved_id, 512)) !== base)
      throw new DriveFailure('CONFLICT');
    const write = async (etag: string, body: string) => {
      const response = await this.request(
        'files/' +
          input.reserved_id +
          '?uploadType=media&fields=' +
          encodeURIComponent(v2 ? 'id' : fileFields),
        {
          method: v2 ? 'PUT' : 'PATCH',
          headers: {
            'Content-Type': 'text/markdown; charset=UTF-8',
            'If-Match': etag,
          },
          body,
        },
        true,
        v2 ? 'v2' : 'v3',
      );
      const updated = await this.json(response);
      if (updated.id !== input.reserved_id) throw new DriveFailure('FORMAT');
    };
    const candidates = [base + 'WRITER_A\n', base + 'WRITER_B\n'];
    const race = await Promise.allSettled(
      candidates.map((body) => write(initial.etag, body)),
    );
    const winners = race.flatMap((result, index) =>
      result.status === 'fulfilled' ? [index] : [],
    );
    const rejected = race.filter((result) => result.status === 'rejected');
    if (
      winners.length !== 1 ||
      rejected.length !== 1 ||
      rejected[0]!.status !== 'rejected' ||
      !(rejected[0]!.reason instanceof DriveFailure) ||
      rejected[0]!.reason.http_status !== 412
    )
      throw new DriveFailure('UNQUALIFIED_UPDATE');
    const current = await metadata();
    if (
      current.etag === initial.etag ||
      (await this.readMarkdown(input.reserved_id, 512)) !==
        candidates[winners[0]!]
    )
      throw new DriveFailure('UNQUALIFIED_UPDATE');
    const afterRead = await metadata();
    if (afterRead.etag !== current.etag) throw new DriveFailure('CONFLICT');
    const finalBody = base + 'CURRENT_GUARD\n';
    await write(current.etag, finalBody);
    const final = await metadata();
    if (
      final.etag === current.etag ||
      (await this.readMarkdown(input.reserved_id, 512)) !== finalBody ||
      (await metadata()).etag !== final.etag
    )
      throw new DriveFailure('UNQUALIFIED_UPDATE');
    return {
      version: 'drive-upload-guard-probe:1' as const,
      method: v2
        ? ('V2_MEDIA_PUT_IF_MATCH' as const)
        : ('V3_MEDIA_PATCH_IF_MATCH' as const),
      concurrent_writers: 2,
      accepted_writers: 1,
      rejected_http_status: 412,
      current_guard_write: 'PASS' as const,
      stable_readback: 'PASS' as const,
      automatic_updates_enabled: false as const,
    };
  }
}
