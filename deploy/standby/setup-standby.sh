#!/bin/sh
# =============================================================================
#  Turn a fresh node into a streaming standby.
#
#  Run this ON THE STANDBY, once. It takes a base backup from the primary and
#  starts following it.
#
#  AFTER IT FINISHES, CHECK THE LAG. Run this on the PRIMARY:
#
#     SELECT client_addr, state, sent_lsn, replay_lsn,
#            pg_wal_lsn_diff(sent_lsn, replay_lsn) AS bytes_behind
#       FROM pg_stat_replication;
#
#  `state` must be `streaming` and `bytes_behind` should be near zero. A
#  standby that exists and is not streaming is a standby that will be empty on
#  the day it is needed, and nothing else will tell you.
# =============================================================================
set -eu

PRIMARY_HOST="${PRIMARY_HOST:?set PRIMARY_HOST to the primary's private address}"
REPL_USER="${POSTGRES_REPLICATION_USER:-replicator}"
DATA_DIR="${DATA_DIR:-/var/lib/postgresql/data}"

if [ -s "${DATA_DIR}/PG_VERSION" ]; then
  echo "refusing: ${DATA_DIR} already contains a database." >&2
  echo "A base backup would overwrite it. Move it aside deliberately." >&2
  exit 1
fi

echo "taking a base backup from ${PRIMARY_HOST}…"

# -R writes standby.signal and the primary_conninfo for us.
# -C -S creates a replication SLOT, which is what stops the primary from
# recycling WAL this standby has not replayed yet. Without a slot, a standby
# that falls behind during a busy hour needs a full rebuild.
PGPASSWORD="${POSTGRES_REPLICATION_PASSWORD:?set POSTGRES_REPLICATION_PASSWORD}" \
  pg_basebackup \
    --host="${PRIMARY_HOST}" \
    --username="${REPL_USER}" \
    --pgdata="${DATA_DIR}" \
    --wal-method=stream \
    --write-recovery-conf \
    --create-slot \
    --slot="standby_$(hostname | tr -cd '[:alnum:]_')" \
    --checkpoint=fast \
    --progress \
    --verbose

# Read-only queries on the standby, so reporting can be pointed here rather
# than at the primary. `hot_standby_feedback` stops the primary vacuuming rows
# a long-running report on this node is still reading.
{
  echo "hot_standby = on"
  echo "hot_standby_feedback = on"
} >> "${DATA_DIR}/postgresql.auto.conf"

echo
echo "done. Start Postgres here, then run the pg_stat_replication query from"
echo "the header of this script ON THE PRIMARY and confirm state = streaming."
