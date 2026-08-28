# Recovery objectives, and what the configuration actually gives you

Two numbers and one stance. All three were decisions nobody had written down,
which means they would have been made at three in the morning by whoever was
awake.

**RPO** — recovery point objective — is how much data you accept losing.
**RTO** — recovery time objective — is how long you accept being down.

Everything below is derived from `docker-compose.db.yml`, `postgres/*.conf` and
`standby/backup.sh` as they stand. Where the configuration does not support the
objective, that is said rather than implied.

---

## The objectives

| Failure | RPO | RTO |
|---|---|---|
| The primary node dies | **seconds** | **10 minutes**, manual |
| A bad migration or a mistaken `DELETE` | **up to 24 hours** | **1–2 hours** |
| Primary and standby both lost | **up to 24 hours** | **2–4 hours** |

### The primary node dies — RPO seconds, RTO ten minutes

`primary.conf` streams to the standby, so the standby is seconds behind. The
recovery is `standby/promote.sh`, and the ten minutes is almost entirely a
person: reading the script's header, confirming the old primary is stopped, and
repointing the application.

**Promotion is deliberately not automatic**, and the reason is in the script.
Two databases that both accept writes give two divergent sets of postings and
no way afterwards to say which is the real ledger — a split brain that for a
bank is not a degraded state but a destroyed record. Automatic failover trades
the ten minutes for that risk, and it is not a good trade here.

### A bad migration or a mistaken DELETE — RPO up to 24 hours

**Replication does not help at all**: a `DELETE` replicates to the standby
faithfully in under a second, and so does a migration that drops a column. The
copy that survives it is the nightly base backup, so the exposure is however
long ago it ran.

`archive_mode = on` and WAL is archived to `/var/lib/postgresql/archive` on the
primary, so **point-in-time recovery to the moment before the mistake is
possible while that disk survives** — which is the usual case for this failure,
because the node is fine and only the data is wrong. That takes the practical
RPO for this case to near zero. It is written as 24 hours above because it is
the number that holds when the assumption does not.

### Primary and standby both lost — RPO up to 24 hours

Region failure, provider account loss, or a compromise that reaches both nodes.

**This is the number to argue about, and here is the gap.** Only the base
backups go off-site: `backup.sh` runs `pg_basebackup --wal-method=stream`,
encrypts the result and ships it with `rclone`. The WAL archive lives in the
`wal_archive` volume on the primary and **is never shipped anywhere**. So in
the one scenario where both nodes are gone, the newest thing off-site is the
last base backup, and everything since it — up to a full day of customer
transactions — is not recoverable.

For a business holding customer deposits, a 24-hour RPO in that scenario is a
decision somebody should make deliberately rather than inherit. To close it,
ship WAL continuously: point `archive_command` at object storage, or move to a
tool that does it as a matter of course (pgBackRest, WAL-G). Both take the
off-site RPO from a day to a few minutes and cost a small, constant upload.

**Until that is done, `BACKUP_INTERVAL_SECONDS` is the RPO.** The default is
86400. Lowering it is the cheap partial mitigation and it is not free — each
base backup is a full copy of the database.

---

## What the RTOs assume

- **Somebody is awake and knows this file exists.** None of the recovery paths
  are automatic, and that is deliberate for promotion and merely unfinished for
  the rest. The one thing worth automating first is *paging*, not recovery.
- **The private half of the backup key is reachable.** `BACKUP_AGE_RECIPIENT`
  is a public key and the node holds only that half, which is what makes a
  compromised database node yield unreadable archives. It also means **an
  unreachable private key is an unrecoverable backup**. It belongs somewhere at
  least two people can get to, and that is a process question this repository
  cannot answer.
- **The restore has been done recently.** `standby/restore-drill.sh` is what
  makes the RTO a measurement rather than a guess, and it runs
  `verify-restore.sql` rather than stopping at "Postgres started" — a truncated
  copy starts perfectly and is missing a week. An RTO nobody has timed is a
  hope.
- **`pg_basebackup` does not copy the configuration on a Debian layout**,
  because it lives outside PGDATA. The restore fails with an error that reads
  like a corrupt archive. That is in the drill's header and it is worth knowing
  before an incident rather than during one.

---

## Migrations: roll forward, never back

**There are no down-migrations, and there will not be.** The migrations are
numbered SQL files applied in order, and the way to undo one is to write the
next one.

That is not laziness, and three things make it the only honest stance:

1. **Nineteen `ALTER TYPE … ADD VALUE` statements across eleven migrations, and
   Postgres cannot remove an enum value.** `account_kind` gained
   `liability_tax_payable` in 032 and `notification_class` gained `marketing` in
   033; neither can be taken out without rewriting every column that uses the
   type. A "down migration" for those files cannot exist, so a rollback story
   that claims to cover every migration is false for eleven of them.

2. **The ledger is append-only by trigger.** A down-migration that deleted rows
   it had inserted would be refused by `011_ledger_immutability.sql`, and one
   that could delete them would be a function an intruder could use to erase
   what they did. The correction for a wrong posting is a reversing entry, and
   the same logic applies one level up.

3. **A down-migration is code that runs once, under pressure, having never been
   run.** It is the least tested code in the repository at the moment it
   matters most.

### So what do you actually do

- **A migration that is wrong but harmless** — a missing index, a constraint
  too tight: write the next migration. Minutes.
- **A migration that is wrong and destructive** — dropped a column, rewrote
  data: this is the one case restoring from backup is for, and the RPO above is
  what it costs. Which is another reason to read a migration for `DROP` and
  `UPDATE` before it runs, rather than after.
- **A deploy that is wrong but whose migration was fine**: roll the application
  back. The migrations are forward-compatible by construction — every one adds
  rather than removes — so an older bundle runs against a newer schema. That is
  the ordinary case and it needs no database work at all.

### Before applying a migration to production

- Read it for `DROP`, `DELETE`, `UPDATE` and `ALTER … TYPE`. Everything else is
  additive and safe to roll forward from.
- Run it on staging **restored from a production backup**, which is the only
  place the row counts are realistic.
- Take a base backup first if it contains any of the above. `backup.sh` can be
  run by hand.
- `025_bvn_uniqueness.sql` REFUSES to apply to a database that already holds
  submissions, and that refusal is the pattern to copy: a migration that cannot
  be safely applied should say so and stop, rather than half-apply.
