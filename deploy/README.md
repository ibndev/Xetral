# Deploying Xetral

Two nodes, not one. The application and the database are separate machines with
streaming replication, because a single box means a single disk failure is the
end of a licensed institution's records.

This directory holds the configuration for that: what runs where, how the
standby follows the primary, and how to fail over when the primary is gone.

```
                    Cloudflare
                        │
                 ┌──────┴──────┐
                 │  app node   │   NestJS API + Next.js web + Redis
                 └──────┬──────┘
                        │ TLS, private network only
          ┌─────────────┴─────────────┐
          │                           │
   ┌──────┴──────┐            ┌───────┴──────┐
   │  db-primary │ ──WAL────► │  db-standby  │
   └─────────────┘  stream    └──────────────┘
```

## Why two nodes and not one

A single box is fine for development and is not an acceptable production
topology for a business holding customer deposits. Three reasons, in the order
they will bite:

1. **A disk failure loses the ledger.** Postgres is the system of record; the
   application holds nothing that could rebuild it. Streaming replication means
   a second copy is always within seconds of the first.
2. **A deploy should not be able to take the database with it.** On one box,
   an out-of-memory application process and the database compete for the same
   memory, and the OOM killer does not know which one matters.
3. **The database must not be reachable from the internet.** On one box it is
   a firewall rule away from being exposed. On two, it listens only on the
   private network and there is no public route to it at all.

## What is here

| File | What it does |
|---|---|
| `docker-compose.app.yml` | the app node: API, web, Redis |
| `docker-compose.db.yml` | the database node: primary, plus a backup sidecar |
| `postgres/primary.conf` | WAL settings that make replication and PITR possible |
| `postgres/pg_hba.conf` | who may connect, from where, with what |
| `standby/setup-standby.sh` | turns a fresh node into a streaming standby |
| `standby/promote.sh` | fails over, with the checks that must happen first |
| `.env.example` | every variable the platform needs, and what happens if it is wrong |

## Order of operations for a first deploy

1. Provision three Hetzner nodes on a private network: `app`, `db-primary`,
   `db-standby`. Only `app` gets a public address.
2. On `db-primary`: `docker compose -f docker-compose.db.yml up -d`, then
   create the replication role and the application role.
3. On `db-standby`: run `standby/setup-standby.sh`. It takes a base backup
   from the primary and starts following. Confirm with the query in that
   script's header before going further.
4. On `app`: apply the migrations **in order** (see the repository README),
   then `docker compose -f docker-compose.app.yml up -d`.
5. Point Cloudflare at `app`. Nothing else has a public address.
6. Set the single-instance workers. `RECONCILE_INTERVAL_SECONDS`,
   `DEPOSIT_RECONCILE_INTERVAL_SECONDS`, `CRYPTO_RECONCILE_INTERVAL_SECONDS`
   and `GIFTCARD_RELEASE_INTERVAL_SECONDS` must be set on **exactly one**
   instance. Running them everywhere is safe for the ledger — advisory locks
   serialise the sweeps — and rude to every provider.

## Failing over

`standby/promote.sh`, and read its header first. Promotion is not reversible
without a rebuild, and promoting while the old primary is still writing gives
two databases that both believe they are authoritative — which for a ledger
means two divergent sets of postings and no way to say which is real.
