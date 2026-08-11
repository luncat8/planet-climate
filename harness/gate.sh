#!/usr/bin/env bash
# gate.sh — run the harness against the working tree and compare to a stored
# baseline. Exits non-zero on hash drift (phases 0-2) or on NaN/shader errors.
#
#   ./gate.sh <tag> [--allow-drift]
#
# Baselines live in baselines/<tag>.json and are created on first run.
set -uo pipefail
cd "$(dirname "$0")"
TAG="${1:?usage: gate.sh <tag> [--allow-drift]}"
ALLOW="${2:-}"
mkdir -p baselines runs

# The no-op phases (0-2) must reproduce the ORIGINAL bytes, which means
# running with the legacy flat slab and the legacy Math.random()->0.5 seed.
# NOTE: kept as an ARRAY. As a plain string the JSON gets word-split by the
# shell and --params silently loses its value, which made a "no-op" gate run
# against procedural bathymetry without saying so.
if [ "${EXTRA+set}" = set ]; then read -r -a EXTRA_ARR <<< "$EXTRA"
else EXTRA_ARR=(--legacy-seed '--params={"bathyMode":0}'); fi

declare -A CASES=(
  [L5]="--steps=500 --level=5"
  [L6]="--steps=200 --level=6"
)

fail=0
for name in L5 L6; do
  args="${CASES[$name]}"
  out="runs/${TAG}_${name}.json"
  # capture stdout too: harness.js reports shaderLogs/fatal on stdout as JSON,
  # and redirecting only stderr made failures show up as a bare "HARNESS ERROR"
  # with an empty .err file.
  if ! node harness.js $args "${EXTRA_ARR[@]}" --out="$out" >runs/${TAG}_${name}.err 2>&1; then
    echo "  [$name] HARNESS ERROR"; sed 's/^/      /' runs/${TAG}_${name}.err | head -30; fail=1; continue
  fi
  h=$(python3 -c "import json;print(json.load(open('$out'))['hash'])")
  n=$(python3 -c "import json;print(json.load(open('$out'))['nanCount'])")
  base="baselines/${name}.json"
  if [ ! -f "$base" ]; then
    cp "$out" "$base"; echo "  [$name] baseline created  hash=$h nan=$n"
  else
    bh=$(python3 -c "import json;print(json.load(open('$base'))['hash'])")
    if [ "$h" == "$bh" ]; then
      echo "  [$name] IDENTICAL      hash=$h nan=$n"
    elif [ "$ALLOW" == "--allow-drift" ]; then
      echo "  [$name] drift (allowed) $bh -> $h  nan=$n"
    else
      echo "  [$name] HASH DRIFT !!  $bh -> $h  nan=$n"; fail=1
    fi
  fi
  if [ "$n" != "0" ]; then echo "  [$name] NaN DETECTED: $n"; fail=1; fi
done
exit $fail
