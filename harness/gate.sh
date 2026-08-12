#!/usr/bin/env bash
# gate.sh — run the harness against the working tree and compare to a stored
# baseline. Exits non-zero on hash drift (phases 0-2) or on NaN/shader errors.
#
#   ./gate.sh <tag> [--allow-drift]
#   LEVELS="L5 L6" ./gate.sh <tag>     # skip L7 (slow in SwiftShader)
#
# Air dt-independence is a separate check:
#   node dti_check.js --quick          # 1 day, dts=10,60,300
#   node dti_check.js                  # 3 days, dts=10,30,60,120,300
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
  [L7]="--steps=100 --level=7"
)

# LEVELS selects which grid resolutions to run. L7 is slow in SwiftShader
# (sandbox does not need it):  LEVELS="L5 L6" ./gate.sh <tag>
LEVELS="${LEVELS:-L5 L6 L7}"

# SCHEMES (default "0") selects which ocean engine to gate/sweep. Pass e.g.
#   SCHEMES="0 1 2" ./gate.sh <tag>
# Scheme 0 is regression-gated against its baseline; schemes 1/2 are run and
# their hashes reported (no drift is asserted, since they are new code paths).
SCHEMES="${SCHEMES:-0}"

fail=0
for s in $SCHEMES; do
  spre=""
  if [ "$s" != "0" ]; then spre="_s${s}"; fi
  for name in $LEVELS; do
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
    base="baselines/${name}.json"
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
  done
done
exit $fail
