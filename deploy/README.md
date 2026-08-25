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

## Staging

`docker-compose.staging.yml` and `.env.staging.example`. One box: API, web,
Postgres and Redis together, with sandbox providers.

It runs the same bundle, the same migrations, the same guard and the same
ledger as production, because a staging environment that differs in those
proves nothing. What it deliberately does NOT have is a standby, backups, or a
separate database node — there are no customer deposits here, so the reasoning
that makes production three machines has nothing to protect.

Two protections are worth knowing about because they are refusals, not
warnings:

**It cannot reach a live provider.** With `XETRAL_ENVIRONMENT=staging`, the
API refuses to start if `BITNOB_BASE_URL` or `VTPASS_BASE_URL` points at a
live host. Failing at boot costs a deploy; failing on the first card issue
spends a real customer's money and looks like a bug in staging. The mistake
this catches is a specific one — copying a production `.env` to get a box
working quickly — and it is made by people in a hurry, which is when nobody
reads carefully.

**It cannot email real customers.** A staging database is usually restored
from a production backup, because that is the only way to test against
realistic data. From that moment the outbox worker holds every real customer's
address and a queue of messages about transfers that never happened, and it
will send them. `NOTIFICATION_ALLOWLIST` is the set of addresses that may be
reached, matched by suffix; unset means nobody, which is the direction to be
wrong in.

`GET /health` names the environment, because staging and production are
identical in every visible respect — which is what makes staging worth having
and also what makes "which one am I looking at?" a question people get wrong
under pressure.

    curl -s localhost:3000/health
    {"status":"ok","environment":"staging","uptime_seconds":41}

Generate FRESH secrets. A staging box holding production's access-token key
can mint tokens the real API accepts; sharing the encryption key lets it open
production's sealed envelopes.

## Failing over

`standby/promote.sh`, and read its header first. Promotion is not reversible
without a rebuild, and promoting while the old primary is still writing gives
two databases that both believe they are authoritative — which for a ledger
means two divergent sets of postings and no way to say which is real.
