import { expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requirePrivateRecoveryDirectory } from '../../tools/db/private-directory.js';
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
it.runIf(process.platform === 'win32')(
  'rejects targets outside private recovery root before invoking ACL operations',
  () => {
    vi.mocked(spawnSync).mockClear();
    for (const path of ['.local', '../outside', '.local/../outside'])
      expect(() => requirePrivateRecoveryDirectory(resolve(path))).toThrow(
        'PRIVATE_RECOVERY_TARGET_REQUIRED',
      );
    expect(spawnSync).not.toHaveBeenCalled();
  },
);
it.runIf(process.platform === 'win32')(
  'uses hidden bounded ACL verification and fails closed without forwarding output',
  () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: 'private diagnostics',
      stderr: 'private diagnostics',
    } as ReturnType<typeof spawnSync>);
    expect(() =>
      requirePrivateRecoveryDirectory(resolve('.local/backups')),
    ).toThrow('PRIVATE_RECOVERY_ACL_REQUIRED');
    expect(spawnSync).toHaveBeenLastCalledWith(
      'pwsh.exe',
      expect.any(Array),
      expect.objectContaining({ windowsHide: true, timeout: 15000 }),
    );
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<
      typeof spawnSync
    >);
    expect(() =>
      requirePrivateRecoveryDirectory(resolve('.local/backups')),
    ).not.toThrow();
  },
);
it.runIf(process.platform !== 'win32')(
  'rejects the Windows ACL helper on another platform',
  () => {
    expect(() =>
      requirePrivateRecoveryDirectory(resolve('.local/backups')),
    ).toThrow('PRIVATE_WINDOWS_RECOVERY_REQUIRED');
  },
);
