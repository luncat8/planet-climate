#!/usr/bin/env bash
# gate.sh — run the harness against the working tree and compare to a stored
# baseline. Exits non-zero on hash drift (phases 0-2) or on NaN/shader errors.
#
#   ./gate.sh <tag> [--allow-drift]
#
# Baselines live in $BASELINES_DIR/<level>.json and are created on first run.
# Hashes are driver-specific (ANGLE backend / SwiftShader version change float
# rounding), so each driver keeps its own baseline dir:
#   baselines/       — owner reference driver (committed L5/L6; L7 by owner)
#   baselines-swvk/  — sandbox SwiftShader-Vulkan driver (see docs/BENCH.md)
# Override with BASELINES_DIR=baselines-swvk ./gate.sh <tag>.
set -uo pipefail
cd "$(dirname "$0")"
TAG="${1:?usage: gate.sh <tag> [--allow-drift]}"
BASELINES_DIR="${BASELINES_DIR:-baselines}"
mkdir -p "$BASELINES_DIR"
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
  [L7]="--steps=100 --level=7"
)

# SCHEMES (default "0") selects which ocean engine to gate/sweep. Pass e.g.
#   SCHEMES="0 1 2" ./gate.sh <tag>
# Scheme 0 is regression-gated against its baseline; schemes 1/2 are run and
# their hashes reported (no drift is asserted, since they are new code paths).
SCHEMES="${SCHEMES:-0}"

fail=0
for s in $SCHEMES; do
  spre=""
  if [ "$s" != "0" ]; then spre="_s${s}"; fi
  for name in L5 L6 L7; do
    args="${CASES[$name]} --scheme=$s"
    out="runs/${TAG}${spre}_${name}.json"
    # capture stdout too: harness.js reports shaderLogs/fatal on stdout as JSON,
    # and redirecting only stderr made failures show up as a bare "HARNESS ERROR"
    # with an empty .err file.
    if ! node harness.js $args "${EXTRA_ARR[@]}" --out="$out" >runs/${TAG}${spre}_${name}.err 2>&1; then
      echo "  [s$s $name] HARNESS ERROR"; sed 's/^/      /' runs/${TAG}${spre}_${name}.err | head -30; fail=1; continue
    fi
    h=$(python3 -c "import json;print(json.load(open('$out'))['hash'])")
    n=$(python3 -c "import json;print(json.load(open('$out'))['nanCount'])")
    # only scheme 0 has a committed baseline to gate against
    if [ "$s" != "0" ]; then
      echo "  [s$s $name] hash=$h nan=$n  (new scheme, no baseline gate)"
      if [ "$n" != "0" ]; then echo "  [s$s $name] NaN DETECTED: $n"; fail=1; fi
      continue
    fi
    base="${BASELINES_DIR}/${name}.json"
    if [ ! -f "$base" ]; then
      cp "$out" "$base"; echo "  [s$s $name] baseline created  hash=$h nan=$n"
    else
      bh=$(python3 -c "import json;print(json.load(open('$base'))['hash'])")
      if [ "$h" == "$bh" ]; then
        echo "  [s$s $name] IDENTICAL      hash=$h nan=$n"
      elif [ "$ALLOW" == "--allow-drift" ]; then
        echo "  [s$s $name] drift (allowed) $bh -> $h  nan=$n"
      else
        echo "  [s$s $name] HASH DRIFT !!  $bh -> $h  nan=$n"; fail=1
      fi
    fi
    if [ "$n" != "0" ]; then echo "  [s$s $name] NaN DETECTED: $n"; fail=1; fi
    sleep 3   # cooldown: back-to-back launches flake when teardown overlaps init
  done
done
exit $fail
