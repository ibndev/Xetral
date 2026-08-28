#!/bin/sh
# ============================================================================
#  Nightly base backup — encrypted here, shipped off this machine.
#
#  Replication protects against a node dying. It does NOT protect against a bad
#  migration or a mistaken DELETE, both of which replicate to the standby
#  faithfully in under a second. This is the copy that survives those.
#
#  THREE PROPERTIES, and the backup is worth very little without all three.
#
#  1. ENCRYPTED WITH A PUBLIC KEY. `age` encrypts to a recipient; this host
#     holds only the public half. So a full compromise of the database node
#     yields the backup files and not their contents — which matters because
#     this file contains every customer's balance, every BVN we hold, and the
#     sealed envelopes for every card code. The private key lives with whoever
#     runs a restore, never here.
#
#  2. OFF THIS MACHINE. A backup on the same disk as the database protects
#     against a fat finger and nothing else — not the disk, not the node, not
#     the provider account. It goes to object storage in a DIFFERENT region.
#
#  3. RESTORED, PERIODICALLY, BY SOMEBODY. That is `restore-drill.sh`, and it
#     is the property most often missing: an untested backup is a hope with a
#     cron entry. Every step above can succeed for months and produce an
#     archive that will not restore.
# ============================================================================
set -eu

HOST="${POSTGRES_HOST:-postgres}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

# The public half of an age keypair, as `age1...`. Generated with
# `age-keygen`; the PRIVATE half must never be copied onto this node.
RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"

# An rclone remote and path, e.g. `b2:xetral-backups/prod`. Configured through
# `RCLONE_CONFIG_*` environment variables so no credential file is baked in.
REMOTE="${BACKUP_REMOTE:-}"

if [ -z "${RECIPIENT}" ]; then
  # FAILING TO START is the point. A backup loop that ran unencrypted because
  # a variable was missing would look healthy in every log line it produced,
  # and the problem would be discovered by whoever found the bucket.
  echo "[backup] BACKUP_AGE_RECIPIENT is not set. Refusing to write unencrypted" >&2
  echo "[backup] backups of a customer ledger. Generate a key with age-keygen," >&2
  echo "[backup] keep the private half OFF this host, and set the public half." >&2
  exit 1
fi

if [ -z "${REMOTE}" ]; then
  # A warning rather than a refusal: a local encrypted copy is worth more than
  # no copy at all, and there are legitimate first-day deployments where the
  # bucket is not ready yet. It is loud because it is not a state to stay in.
  echo "[backup] WARNING: BACKUP_REMOTE is not set. Backups stay on THIS DISK," >&2
  echo "[backup] which protects against a mistaken DELETE and against nothing" >&2
  echo "[backup] else — not the disk, not the node, not the provider account." >&2
fi

run_once() {
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  WORK="/backups/${STAMP}"
  ARCHIVE="/backups/${STAMP}.tar.gz.age"

  echo "[backup] starting ${STAMP}"

  # --wal-method=stream, so the archive is consistent on its own. Without the
  # WAL segments written during the copy, restoring needs an archive this
  # script does not ship, and the failure appears only during a restore.
  if ! pg_basebackup --host="${HOST}" --username=xetral --pgdata="${WORK}" \
       --format=tar --gzip --checkpoint=fast --wal-method=stream; then
    echo "[backup] FAILED: pg_basebackup at ${STAMP}" >&2
    rm -rf "${WORK}"
    return 1
  fi

  # One archive, encrypted, rather than a directory of encrypted members: a
  # restore needs all of them or none, and a directory invites a partial
  # upload that looks complete.
  if ! tar -C "${WORK}" -cf - . | gzip -c | age -r "${RECIPIENT}" -o "${ARCHIVE}"; then
    echo "[backup] FAILED: encryption at ${STAMP}" >&2
    rm -rf "${WORK}" "${ARCHIVE}"
    return 1
  fi
  rm -rf "${WORK}"

  # Proof that what landed is what we made. A truncated upload is the failure
  # that looks most like success.
  sha256sum "${ARCHIVE}" | awk '{print $1}' > "${ARCHIVE}.sha256"

  if [ -n "${REMOTE}" ]; then
    if rclone copy "${ARCHIVE}" "${REMOTE}/" && \
       rclone copy "${ARCHIVE}.sha256" "${REMOTE}/"; then
      echo "[backup] ${STAMP} shipped to ${REMOTE}"
    else
      # The local copy is KEPT on a failed upload. Deleting it would turn a
      # network problem into a night with no backup at all.
      echo "[backup] FAILED: upload at ${STAMP}; the local copy is kept" >&2
      return 1
    fi
  fi

  echo "[backup] ${STAMP} complete ($(du -h "${ARCHIVE}" | awk '{print $1}'))"
  return 0
}

while true; do
  # Never exits the loop on a failure. A backup job that dies on one bad night
  # is a backup job that silently stopped running weeks ago, and nobody finds
  # out until they need it.
  run_once || echo "[backup] continuing after a failure" >&2

  # Local retention only. Remote retention is a lifecycle rule on the bucket,
  # where it belongs: a compromised database host must not be able to delete
  # its own history, so this script is given no permission to.
  find /backups -maxdepth 1 -name '*.tar.gz.age*' -mtime "+${KEEP_DAYS}" -delete || true

  sleep "${INTERVAL}"
done
