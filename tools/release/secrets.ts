import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';

/** No values, matching substrings or hashes of secrets enter the report. */
export function scanPublicBuild(
  root: string,
  environment: Record<string, string | undefined>,
) {
  const secrets = Object.entries(environment)
    .filter(
      ([key, value]) =>
        /(?:SECRET|API_KEY|CREDENTIAL|TOKEN|PASSWORD|PRIVATE_KEY)$/.test(key) &&
        !!value,
    )
    .map(([, value]) => value!);
  if (!secrets.length) throw new Error('SECRET_SCAN_INPUT_REQUIRED');
  if (secrets.some((value) => value.length < 8))
    throw new Error('SECRET_SCAN_VALUE_TOO_SHORT');
  const needles = [
    ...new Set(
      secrets.flatMap((value) => [
        value,
        encodeURIComponent(value),
        JSON.stringify(value).slice(1, -1),
        Buffer.from(value).toString('base64'),
      ]),
    ),
  ].map((value) => Buffer.from(value));
  const files: string[] = [],
    findings: string[] = [];
  let bytes = 0;
  let directories = 0;
  function visit(directory: string, depth = 0) {
    if (++directories > 512 || depth > 16)
      throw new Error('PUBLIC_BUILD_SCAN_TOO_LARGE');
    if (lstatSync(directory).isSymbolicLink())
      throw new Error('PUBLIC_BUILD_SYMLINK_DENIED');
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        entry = lstatSync(path);
      if (entry.isSymbolicLink())
        throw new Error('PUBLIC_BUILD_SYMLINK_DENIED');
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile()) {
        bytes += entry.size;
        if (
          entry.size > 16 * 1024 * 1024 ||
          bytes > 64 * 1024 * 1024 ||
          files.length >= 4096
        )
          throw new Error('PUBLIC_BUILD_SCAN_TOO_LARGE');
        const local = relative(root, path).replaceAll('\\', '/');
        files.push(local);
        const content = readFileSync(path);
        if (needles.some((needle) => content.includes(needle)))
          findings.push(local);
      } else throw new Error('INVALID_PUBLIC_BUILD_FILE');
    }
  }
  visit(root);
  if (!files.includes('index.html')) throw new Error('PUBLIC_BUILD_REQUIRED');
  return {
    version: 'public-build-secret-scan:1',
    status: findings.length ? 'FAIL' : 'PASS',
    files_scanned: files.length,
    bytes_scanned: bytes,
    findings,
    secret_values_recorded: false,
  };
}
