#!/bin/sh
# Asserts every rule still matches the thing it is about.
#
# A rule that matches nothing is indistinguishable from a rule that finds
# nothing, and the difference only shows up on the day it should have fired.
set -eu

RULES="$(dirname "$0")/../xetral.yml"
PROBE="$(dirname "$0")/violations.ts.probe"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# Semgrep picks its parser from the extension, so the probe is copied to a
# real one rather than named that way in the tree.
cp "${PROBE}" "${WORK}/violations.ts"

EXPECTED=$(grep -c '^  - id: ' "${RULES}")
FIRED=$(semgrep --config "${RULES}" --metrics=off --json "${WORK}" 2>/dev/null \
        | python3 -c 'import json,sys; print(len({r["check_id"] for r in json.load(sys.stdin)["results"]}))')

echo "rules that fired on the probe: ${FIRED} of ${EXPECTED}"
if [ "${FIRED}" -ne "${EXPECTED}" ]; then
  echo "::error::A rule in xetral.yml matches nothing. It will never fire in review either."
  semgrep --config "${RULES}" --metrics=off "${WORK}" 2>/dev/null || true
  exit 1
fi
