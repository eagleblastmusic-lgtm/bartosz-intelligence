#!/usr/bin/env bash
# Instalator uruchamiać na Oracle dopiero po osobnym zatwierdzeniu.
set -euo pipefail
umask 022
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
task_mode="${1:---plan}"
[[ $# -le 1 && ( "$task_mode" == --plan || "$task_mode" == --apply ) ]] || { echo 'ORACLE_INSTALL_ARGUMENT_INVALID' >&2; exit 78; }
task_python=/usr/bin/python3
if [[ "$task_mode" == --plan ]]; then
  task_python="${BARTOSZ_INSTALL_PYTHON:-/usr/bin/python3}"
else
  [[ "$(uname -m)" == aarch64 ]] || { echo 'ORACLE_ARM64_REQUIRED' >&2; exit 78; }
  source /etc/os-release
  [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 && "$EUID" == 0 ]] || { echo 'ORACLE_UBUNTU_ROOT_REQUIRED' >&2; exit 78; }
fi
# Walidacja autorytatywnych pinów i hashy także w planie; bez eval/source.
"$task_python" -B "$task_root/tools/deployment/oracle/validate-locks.py"
if [[ "$task_mode" == --plan ]]; then
  printf '%s\n' 'PLAN_ONLY: Ubuntu 24.04/aarch64, uid=0; release-manifest SHA-256; runtime pod /opt/bartosz-intelligence/runtime; wheel --require-hashes; pnpm --frozen-lockfile; bez aktywacji systemd i bez operacji D1.'
  exit 0
fi
[[ "$task_root" =~ ^/opt/bartosz-intelligence/releases/[a-f0-9]{64}$ ]] || { echo 'ORACLE_RELEASE_PATH_REQUIRED' >&2; exit 78; }
"$task_python" -B "$task_root/tools/deployment/oracle/release.py" verify "$task_root"
for task_command in curl tar xz unzip sha256sum flock; do command -v "$task_command" >/dev/null || { echo 'ORACLE_SYSTEM_TOOL_REQUIRED' >&2; exit 78; }; done
"$task_python" -c 'import venv,ensurepip,sys; assert sys.version_info[:2]==(3,12)'
[[ "$(/usr/bin/ffmpeg -version)" == 'ffmpeg version 6.1.1'* ]] || { echo 'ORACLE_FFMPEG_REQUIRED' >&2; exit 78; }
[[ "$(df --output=avail -k "$task_root" | tail -n1)" -ge 5242880 ]] || { echo 'ORACLE_DISK_SPACE_REQUIRED' >&2; exit 78; }
task_runtime=/opt/bartosz-intelligence/runtime
install -d -m 0755 "$task_runtime"
exec 9>"$task_runtime/.install.lock"
flock -n 9 || { echo 'ORACLE_INSTALL_ALREADY_RUNNING' >&2; exit 78; }
task_downloads="$(mktemp -d "$task_runtime/downloads.XXXXXXXX")"
# Sprzątamy wyłącznie katalog tymczasowy utworzony przez ten proces.
trap 'rm -rf -- "$task_downloads"' EXIT
download_runtime() {
  local task_name="$1" task_url task_hash task_version
  read -r task_version task_url task_hash < <("$task_python" -c 'import json,sys; r=json.load(open(sys.argv[1]))[sys.argv[2]]; print(r["version"],r["url"],r["sha256"])' "$task_root/tools/deployment/oracle/runtime-lock.json" "$task_name")
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 15 --max-time 300 "$task_url" -o "$task_downloads/$task_name.archive"
  printf '%s  %s\n' "$task_hash" "$task_downloads/$task_name.archive" | sha256sum -c -
}
task_node="$task_runtime/node-24.21.0"
if [[ ! -e "$task_node" ]]; then
  download_runtime node
  mkdir "$task_downloads/node"
  tar -xJf "$task_downloads/node.archive" --strip-components=1 -C "$task_downloads/node"
  [[ "$("$task_downloads/node/bin/node" --version)" == v24.21.0 ]]
  mv -- "$task_downloads/node" "$task_node"
fi
[[ "$("$task_node/bin/node" --version)" == v24.21.0 ]] || { echo 'ORACLE_NODE_VERSION_MISMATCH' >&2; exit 78; }
export PATH="$task_node/bin:/usr/bin:/bin"
export NODE_OPTIONS=--max-old-space-size=1536
task_deno="$task_runtime/deno-2.9.7"
if [[ ! -e "$task_deno" ]]; then
  download_runtime deno
  mkdir "$task_downloads/deno"
  unzip -q "$task_downloads/deno.archive" -d "$task_downloads/deno"
  chmod 0755 "$task_downloads/deno/deno"
  mv -- "$task_downloads/deno" "$task_deno"
fi
[[ "$("$task_deno/deno" --version)" == 'deno 2.9.7 '* ]] || { echo 'ORACLE_DENO_VERSION_MISMATCH' >&2; exit 78; }
task_pnpm="$task_runtime/pnpm-12.9.1"
if [[ ! -e "$task_pnpm" ]]; then
  download_runtime pnpm
  mkdir "$task_downloads/pnpm"
  tar -xzf "$task_downloads/pnpm.archive" --strip-components=1 -C "$task_downloads/pnpm"
  chmod 0755 "$task_downloads/pnpm/pnpm"
  mv -- "$task_downloads/pnpm" "$task_pnpm"
fi
[[ "$("$task_pnpm/pnpm" --version)" == 12.9.1 ]] || { echo 'ORACLE_PNPM_VERSION_MISMATCH' >&2; exit 78; }
# Środowisko aplikacji jest odrębne od zastanego ~/bartosz-intelligence/.venv.
task_venv="$task_runtime/python"
if [[ ! -e "$task_venv" ]]; then
  "$task_python" -m venv "$task_venv"
fi
[[ -f "$task_venv/pyvenv.cfg" ]] || { echo 'ORACLE_VENV_CONFLICT' >&2; exit 78; }
"$task_venv/bin/python" -c 'import sys; assert sys.version_info[:2]==(3,12)'
"$task_venv/bin/python" -m pip install --disable-pip-version-check --no-cache-dir --require-hashes --only-binary=:all: --no-deps -r "$task_root/tools/deployment/oracle/requirements-arm64.lock.txt"
"$task_venv/bin/python" -m pip check
"$task_venv/bin/python" -B "$task_root/tools/deployment/oracle/runtime-probe.py"
cd -- "$task_root"
"$task_pnpm/pnpm" install --frozen-lockfile --store-dir "$task_runtime/pnpm-store"
"$task_python" -B "$task_root/tools/deployment/oracle/release.py" verify "$task_root"
printf '%s\n' 'ORACLE_INSTALL_PREPARED: runtime i zależności. Nie zainstalowano jednostki, nie uruchomiono workera, nie zmieniono D1.'
