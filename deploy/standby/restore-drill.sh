#!/usr/bin/env bash
# ============================================================================
#  The restore drill.
#
#  A BACKUP NOBODY HAS RESTORED IS A HOPE WITH A CRON ENTRY. Every step of
#  `backup.sh` can succeed for months and still produce an archive that will
#  not restore: a Postgres major upgrade the sidecar image did not follow, a
#  WAL method quietly changed, an age key rotated on one side only, a bucket
#  lifecycle rule that expired the file. None of those show up in a backup log.
#  All of them show up here.
#
#  WHAT MAKES THIS A DRILL RATHER THAN A SMOKE TEST: it does not stop at
#  "Postgres started". A corrupted or truncated restore frequently starts
#  fine — the data directory is valid, the server accepts connections, and the
#  ledger is missing a week. So it goes on to interrogate the LEDGER, through
#  `verify-restore.sql`: every entry sums to zero per currency, the
#  materialised balances agree with the postings they were built from, and
#  every table the application requires is present by name.
#
#  RUN IT SOMEWHERE THAT IS NOT THE DATABASE NODE. The private age key is
#  needed to decrypt, and the entire point of encrypting to a public key is
#  that this key never touches the host holding the data.
#
#  Usage:
#    BACKUP_REMOTE=b2:xetral-backups/prod \
#    AGE_IDENTITY=/secure/xetral-backup.key \
#      ./restore-drill.sh [archive-name]
#
#  With no argument it takes the most recent archive, which is the one whose
#  failure matters most.
# ============================================================================
set -uo pipefail

REMOTE="${BACKUP_REMOTE:-}"
IDENTITY="${AGE_IDENTITY:-}"

WORK="$(mktemp -d)"
CONTAINER="xetral-restore-drill-$$"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

fail() { echo "DRILL FAILED: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

[ -n "${IDENTITY}" ] || fail "AGE_IDENTITY is not set. The private key lives with whoever runs this, never on the database node."
[ -f "${IDENTITY}" ] || fail "no age identity file at ${IDENTITY}"

# ---------------------------------------------------------------------------
step "1. Fetching the archive"
# ---------------------------------------------------------------------------
if [ -n "${REMOTE}" ]; then
  ARCHIVE_NAME="${1:-$(rclone lsf "${REMOTE}/" --include '*.tar.gz.age' | sort | tail -1)}"
  [ -n "${ARCHIVE_NAME}" ] || fail "no archives found at ${REMOTE}"

  echo "    ${ARCHIVE_NAME}"
  rclone copy "${REMOTE}/${ARCHIVE_NAME}" "${WORK}/" || fail "could not download ${ARCHIVE_NAME}"
  rclone copy "${REMOTE}/${ARCHIVE_NAME}.sha256" "${WORK}/" 2>/dev/null || true
else
  ARCHIVE_NAME="${1:?with no BACKUP_REMOTE, name a local archive}"
  cp "${ARCHIVE_NAME}" "${WORK}/" || fail "no such archive: ${ARCHIVE_NAME}"
  ARCHIVE_NAME="$(basename "${ARCHIVE_NAME}")"
fi

# The checksum catches the failure that looks most like success: a truncated
# upload. Without it the drill would proceed and report a confusing decryption
# error instead of the real one.
if [ -f "${WORK}/${ARCHIVE_NAME}.sha256" ]; then
  step "2. Verifying the checksum"
  EXPECTED="$(cat "${WORK}/${ARCHIVE_NAME}.sha256")"
  ACTUAL="$(sha256sum "${WORK}/${ARCHIVE_NAME}" | awk '{print $1}')"
  [ "${EXPECTED}" = "${ACTUAL}" ] || fail "checksum mismatch — the archive is truncated or corrupt"
  echo "    ok"
else
  echo "    (no checksum published alongside this archive)"
fi

# ---------------------------------------------------------------------------
step "3. Decrypting"
# ---------------------------------------------------------------------------
mkdir -p "${WORK}/data"
age -d -i "${IDENTITY}" "${WORK}/${ARCHIVE_NAME}" \
  | gzip -dc \
  | tar -C "${WORK}/data" -xf - \
  || fail "could not decrypt — is this the right key, and was it rotated on both sides?"

# pg_basebackup --format=tar writes base.tar.gz and pg_wal.tar.gz inside.
[ -f "${WORK}/data/base.tar.gz" ] || fail "the archive has no base.tar.gz; this is not a pg_basebackup tar"

# ---------------------------------------------------------------------------
step "4. Restoring into a scratch instance"
# ---------------------------------------------------------------------------
mkdir -p "${WORK}/pgdata"
tar -C "${WORK}/pgdata" -xzf "${WORK}/data/base.tar.gz" || fail "could not unpack base.tar.gz"
if [ -f "${WORK}/data/pg_wal.tar.gz" ]; then
  mkdir -p "${WORK}/pgdata/pg_wal"
  tar -C "${WORK}/pgdata/pg_wal" -xzf "${WORK}/data/pg_wal.tar.gz" || fail "could not unpack pg_wal.tar.gz"
fi
chmod 700 "${WORK}/pgdata"

# A CONTAINER rather than a local `pg_ctl`, and the reason is a trap this drill
# walked into the first time it was run for real.
#
# `pg_basebackup` copies the DATA DIRECTORY. On a Debian or Ubuntu layout the
# server's configuration is not in it — `postgresql.conf`, `pg_hba.conf` and
# `pg_ident.conf` live under /etc/postgresql — so the restored directory will
# not start, and the error ("could not access the server configuration file")
# reads like a corrupt backup rather than a packaging difference. The official
# image keeps its configuration inside PGDATA, so restoring there needs nothing
# that was not in the archive.
#
# Worth knowing before an incident: a restore onto a distribution-packaged
# Postgres needs the configuration supplied separately. It is not in the
# backup, and it is not supposed to be.
#
# `--network none` besides: a drill that could reach production is a drill that
# can end it.
docker run -d --name "${CONTAINER}" \
  --network none \
  -v "${WORK}/pgdata:/var/lib/postgresql/data" \
  -e POSTGRES_PASSWORD=drill \
  postgres:16-alpine >/dev/null || fail "could not start the scratch instance"

echo "    waiting for recovery"
for _ in $(seq 1 60); do
  if docker exec "${CONTAINER}" pg_isready -U xetral -d xetral >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
[ "${READY:-0}" = "1" ] || {
  docker logs "${CONTAINER}" 2>&1 | tail -30
  fail "the restored instance never became ready"
}
echo "    up"

# ---------------------------------------------------------------------------
step "5. Interrogating the LEDGER, not just the server"
#
# The checks live in `verify-restore.sql` rather than here, for two reasons.
# They are REVIEWABLE — these are the questions somebody has to be able to
# disagree with before an incident, not during one — and they are runnable BY
# HAND at 3am against a copy restored by whatever means were available, by
# somebody who is not going to read this script first.
#
# `ON_ERROR_STOP=1` is what makes the drill honest: the SQL raises on the
# first failure, psql exits non-zero, and there is no way for this script to
# report success by printing reassuring text.
# ---------------------------------------------------------------------------
HERE="$(cd "$(dirname "$0")" && pwd)"
docker cp "${HERE}/verify-restore.sql" "${CONTAINER}:/verify.sql" \
  || fail "could not copy the verification into the scratch instance"

if ! docker exec "${CONTAINER}" psql -U xetral -d xetral -v ON_ERROR_STOP=1 -f /verify.sql; then
  fail "the restored copy did not pass verification (see the error above)"
fi

echo
echo "DRILL PASSED — ${ARCHIVE_NAME} restores to a ledger that balances."
