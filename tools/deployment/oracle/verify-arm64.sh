#!/usr/bin/env bash
# Odczyt po zatwierdzonej instalacji; testy zapisują wyłącznie pliki tymczasowe lokalne.
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
[[ "$(uname -m)" == aarch64 ]] || { echo 'ORACLE_ARM64_REQUIRED' >&2; exit 78; }
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || { echo 'ORACLE_UBUNTU_REQUIRED' >&2; exit 78; }
task_runtime=/opt/bartosz-intelligence/runtime
export PATH="$task_runtime/node-24.21.0/bin:$task_runtime/pnpm-12.9.1:/usr/bin:/bin"
export BARTOSZ_TEST_PYTHON="$task_runtime/python/bin/python"
export BARTOSZ_TEST_BASH=/bin/bash
cd -- "$task_root"
[[ "$(node --version)" == v24.21.0 && "$(pnpm --version)" == 12.9.1 ]]
"$BARTOSZ_TEST_PYTHON" -B tools/deployment/oracle/validate-locks.py
"$BARTOSZ_TEST_PYTHON" -B tools/deployment/oracle/runtime-probe.py
"$BARTOSZ_TEST_PYTHON" -B -m unittest discover -s tests/unit -p test_transcript_ytdlp.py
bash -n tools/deployment/oracle/prepare.sh
bash -n tools/deployment/oracle/prepare-host.sh
bash tools/deployment/oracle/prepare.sh --plan
node --import tsx --input-type=module -e 'import { oracleConfiguration, verifyOracleRuntime } from "./apps/executor/src/oracle-runtime.ts"; await verifyOracleRuntime(oracleConfiguration(process.env)); console.log(JSON.stringify({event:"ORACLE_RUNTIME_VERIFIED"}));'
# Wyłącznie uruchomienie już zainstalowanych zależności; domyślne pnpm exec może instalować.
# Integralność instalacji nadal sprawdza prepare.sh (frozen lockfile i hashe).
pnpm --config.verifyDepsBeforeRun=false exec vitest run --configLoader runner --no-cache --project unit --project contracts --maxWorkers=1 tests/unit/oracle-runtime.spec.ts tests/unit/oracle-deployment.spec.ts tests/unit/caption-process.spec.ts tests/unit/executor-cycle-loop.spec.ts tests/contracts/oracle-worker.spec.ts tests/contracts/transcript-providers.spec.ts tests/contracts/oracle-source-qualification.spec.ts
printf '%s\n' 'ORACLE_ARM64_OFFLINE_VERIFIED: bez pobrań YouTube, zmian D1 i aktywacji usługi.'
