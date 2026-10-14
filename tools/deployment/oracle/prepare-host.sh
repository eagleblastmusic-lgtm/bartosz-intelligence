#!/usr/bin/env bash
# Opcjonalne odtworzenie pakietów bazowych po reinstalacji. Wymaga osobnej zgody.
set -euo pipefail
task_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
task_mode="${1:---plan}"
[[ $# -le 1 && ( "$task_mode" == --plan || "$task_mode" == --apply ) ]] || { echo 'ORACLE_HOST_ARGUMENT_INVALID' >&2; exit 78; }
if [[ "$task_mode" == --plan ]]; then
  cat "$task_directory/host-packages.lock.txt"
  printf '%s\n' 'PLAN_ONLY: instalacja tylko brakujących lub starszych pakietów z dokładnych pinów; bez downgrade i bez usług.'
  exit 0
fi
[[ "$(uname -m)" == aarch64 ]] || { echo 'ORACLE_ARM64_REQUIRED' >&2; exit 78; }
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 && "$EUID" == 0 ]] || { echo 'ORACLE_UBUNTU_ROOT_REQUIRED' >&2; exit 78; }
task_packages=()
while IFS= read -r task_pin; do
  [[ -z "$task_pin" || "$task_pin" == \#* ]] && continue
  [[ "$task_pin" =~ ^[a-z0-9.+-]+=[a-zA-Z0-9:~.+-]+$ ]] || { echo 'ORACLE_PACKAGE_PIN_INVALID' >&2; exit 78; }
  task_name="${task_pin%%=*}" task_expected="${task_pin#*=}"
  task_installed="$(dpkg-query -W -f='${Version}' "$task_name" 2>/dev/null || true)"
  if [[ -n "$task_installed" ]] && dpkg --compare-versions "$task_installed" ge "$task_expected"; then continue; fi
  apt-cache show "$task_pin" >/dev/null 2>&1 || { echo 'ORACLE_PINNED_OS_PACKAGE_UNAVAILABLE' >&2; exit 78; }
  task_packages+=("$task_pin")
done < "$task_directory/host-packages.lock.txt"
if [[ "${#task_packages[@]}" -gt 0 ]]; then
  DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends "${task_packages[@]}"
fi
printf '%s\n' 'ORACLE_BASE_PACKAGES_READY: bez zmian IAM, sieci i usług Bartosz.'
