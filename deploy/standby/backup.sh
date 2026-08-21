#!/bin/sh
# Nightly base backup.
#
# Replication protects against a node dying. It does NOT protect against a bad
# migration or a mistaken DELETE, both of which replicate to the standby
# faithfully in under a second. This is the copy that survives those.
set -eu

HOST="${POSTGRES_HOST:-postgres}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

while true; do
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  TARGET="/backups/${STAMP}"

  echo "[backup] starting ${STAMP}"
  if pg_basebackup --host="${HOST}" --username=xetral --pgdata="${TARGET}" \
       --format=tar --gzip --checkpoint=fast --wal-method=stream; then
    echo "[backup] ${STAMP} complete"
  else
    # Loud, and does not stop the loop. A backup job that dies on one failure
    # is a backup job that silently stopped running weeks ago.
    echo "[backup] FAILED at ${STAMP}" >&2
    rm -rf "${TARGET}"
  fi

  find /backups -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" -exec rm -rf {} + || true

  # A local disk is not a backup. Ship /backups off this machine — object
  # storage in another region — or this protects against nothing but fat
  # fingers.
  sleep 86400
done
