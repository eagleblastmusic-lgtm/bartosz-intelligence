import { useState } from 'react';
import type {
  BackupChunk,
  BackupManifest,
  BackupTable,
} from '../../../packages/core/src/backup/snapshot.js';
import { verifyPortableBackup } from '../../../packages/core/src/backup/restore.js';
export function BackupDownload({
  request,
}: {
  request: <T>(path: string, input?: unknown) => Promise<T>;
}) {
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState('');
  async function download() {
    let id: string | undefined;
    setBusy(true);
    setStatus('Przygotowywanie prywatnej kopii…');
    try {
      const started = await request<{
        backup_id: string;
        tables: BackupTable[];
      }>('/backup', {});
      id = started.backup_id;
      const chunks: BackupChunk[] = [];
      for (const table of started.tables) {
        let cursor: number | null = 0;
        do {
          const chunk: BackupChunk = await request<BackupChunk>(
            `/backup/${id}/chunk?table=${encodeURIComponent(table)}&cursor=${cursor}`,
          );
          chunks.push(chunk);
          cursor = chunk.next_cursor;
          if (chunks.length > 200) throw new Error('BACKUP_PILOT_LIMIT');
        } while (cursor !== null);
      }
      const manifest = await request<BackupManifest>(
        `/backup/${id}/complete`,
        {},
      );
      const portable = { manifest, chunks };
      await verifyPortableBackup(portable);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(portable)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `bartosz-core-${id}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setStatus(
        'Kopia zweryfikowana. Pobieranie rozpoczęte — zachowaj plik w prywatnym miejscu.',
      );
    } catch (error) {
      if (id) await request(`/backup/${id}/abort`, {}).catch(() => undefined);
      setStatus(
        'Kopia nie została pobrana: ' +
          (error instanceof Error ? error.message : 'REQUEST_FAILED'),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="backup">
      <h2 id="backup">Prywatna kopia danych</h2>
      <p>
        Kopia nie zawiera sesji ani kluczy API. Zapisy zostaną wstrzymane na
        czas eksportu, maksymalnie na dwie minuty. To kopia podstawowego control
        plane.
      </p>
      <button disabled={busy} onClick={() => void download()}>
        Pobierz prywatny backup
      </button>
      {status && <p role="status">{status}</p>}
    </section>
  );
}
