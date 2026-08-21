#!/bin/sh
# =============================================================================
#  Fail over: promote this standby to primary.
#
#  READ THIS BEFORE RUNNING IT.
#
#  1. THE OLD PRIMARY MUST BE STOPPED, and confirmed stopped, not assumed. Two
#     databases that both accept writes give two divergent sets of postings and
#     no way afterwards to say which is the real ledger. For a system whose
#     entire value is being able to say what happened, that is worse than being
#     down.
#
#  2. PROMOTION IS ONE-WAY. The old primary cannot simply be restarted as a
#     standby afterwards; it has to be rebuilt with pg_rewind or a fresh base
#     backup.
#
#  3. Check how far behind this node is FIRST. Promoting a standby that is
#     30 seconds behind discards 30 seconds of committed transactions —
#     deposits customers have already been told about.
#
#         SELECT now() - pg_last_xact_replay_timestamp() AS behind;
# =============================================================================
set -eu

DATA_DIR="${DATA_DIR:-/var/lib/postgresql/data}"

if [ ! -f "${DATA_DIR}/standby.signal" ]; then
  echo "refusing: this node is not a standby." >&2
  exit 1
fi

echo "Replication lag on this node:"
psql -U xetral -d xetral -tAc \
  "SELECT COALESCE(now() - pg_last_xact_replay_timestamp(), interval '0')" || true

cat <<'WARN'

Before continuing, confirm ALL of the following:

  [ ] The old primary is STOPPED and cannot accept writes.
  [ ] The lag above is acceptable, or is zero.
  [ ] The application's DATABASE_URL is ready to be repointed here.

WARN

printf 'Type PROMOTE to continue: '
read -r answer
[ "$answer" = "PROMOTE" ] || { echo "aborted."; exit 1; }

pg_ctl promote -D "${DATA_DIR}" -w

echo
echo "promoted. Now:"
echo "  1. Repoint DATABASE_URL on the app node and restart it."
echo "  2. Rebuild the old primary as a standby (setup-standby.sh) — it cannot"
echo "     be restarted as-is."
