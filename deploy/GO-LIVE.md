# Before this takes real money

Every phase that shipped a control ended with a paragraph beginning
*"Before going live, an operator must:"*. There are six of them in
`docs/PHASES.md`, more in `CLAUDE.md`, and more again in the header comments
of individual migrations. Each is correct. Together they were not a checklist,
because nothing listed them, nothing ordered them, and nothing noticed when a
seventh was written.

**The list itself is not in this file.** It is
`apps/api/src/golive/go-live-checklist.ts`, as data, because a list in a
document is a list that drifts. `go-live.test.ts` compares it against
`config.ts` and every migration in both directions — a variable the code reads
that the checklist does not name fails the build, and so does an entry for
something that no longer exists.

This file is the part a person needs: what the categories mean, what order to
work in, and how to ask a running deployment what it is missing.

---

## Ask the deployment, don't guess

```
GET /v1/admin/readiness        # staff, role `admin`
```

Also on the dashboard. It reports every item on the checklist against **this
process**, and that qualification is the whole of its accuracy:

| state | meaning |
|---|---|
| `set` | nothing to do |
| `unset` | not set, and the checklist says what that costs. A row whose failure is `default-is-deliberate` is not a finding — the dashboard separates those out |
| `unset-here` | a worker interval, absent from this instance. Correct on the `api` container; a finding only if **no** instance has it |
| `not-observable` | a role granted to a person, a page a lawyer read, a restore that was rehearsed. Nothing inside the process can see these |

It **reports and never refuses**. A readiness check that could stop the API
starting would be a new way to take the platform down at 3am, and what
genuinely cannot be missing already refuses at boot in `config.ts`.

It carries **no secret and no value** — only whether something is set. An e2e
test asserts the response shape, because a readiness screen is exactly where
"just show the first four characters" gets added.

A provider credential counts as set whether it is in the database or in the
environment, because that is the precedence the system actually uses — the
database is authoritative and the environment is the fallback, which is what
lets a key be replaced during an incident without a deploy.

---

## The five categories, in the order they cost you

**1. `refuses-to-boot`** — the process exits and names what is missing. The
cheapest failures in the system; you cannot deploy past them.

**2. `refuses-the-first-request`** — the flow answers with an error code.
Loud, and confined to what it configures: no Bitnob key means cards, funding,
crypto and FX refuse, and transfers carry on.

**3. `silent`** — *these are the ones to work through first.* Nothing errors
and nothing happens. `NOTIFICATION_INTERVAL_SECONDS` unset means outbox rows
accumulate, the API keeps answering "check your email", and no message is ever
sent — including the password reset a locked-out customer is waiting on.
`RISK_MONITOR_INTERVAL_SECONDS` unset means the compliance queue is empty,
which looks exactly like a quiet week.

**4. `wrong-by-default`** — it works, on a number nobody chose. A reporting
threshold, a fee, a tax rate, a ceiling. The seeded value was written by
whoever wrote the migration, applied to somebody else's business.

**5. `default-is-deliberate`** — nothing to do, recorded so the list stays
complete. Without a way to say "considered, nothing needed", the honest thing
to do with a defensible default is leave it off — which is how a list stops
being a list.

---

## Order of work

1. **Boot it.** Category 1 is a deploy loop; get through it first.
2. **Grant `admin` to a real person.** The first grant is an `INSERT`, because
   there is no admin yet to make it through the dashboard. Enrol their second
   factor — TOTP is required on *every* staff route, reads included. See
   **[Getting into the dashboard the first time](#getting-into-the-dashboard-the-first-time)**
   below for the two statements and the screen.
3. **Open `/admin/readiness`** and work category 3, then category 4.
4. **Put the worker intervals on exactly one instance.**
   `docker-compose.app.yml` does this by blanking them on `api` and setting
   them on `worker`. Check `/admin/readiness` on *both* containers: the api
   should say `unset-here` and the worker `set`.
5. **Review every row in `platform_settings`**, at `/admin/settings`. Bounds
   are CHECKs, so a mistyped basis-point figure is refused however it arrives —
   but a *plausible* wrong number is not.
6. **Publish the prices**, at `/admin/prices`. An unpublished FX pair is
   refused rather than quoted from a default, so a fresh deployment converts
   nothing — and **each direction is separate**, because a rate is a ratio and
   "minor units per major unit" collapses one way round. `published_prices` is
   where you find the one you forgot.
7. **Grant the narrower roles** — `giftcard_reviewer`, `dispute_reviewer`,
   `compliance`, `finance`, `support` — from the dashboard.
8. **Set the regulatory figures.** `risk_thresholds.large_value_minor` must be
   what the NFIU currently requires; the seeded figure is a starting point, and
   a programme running on a number somebody copied from a migration is a
   finding. Neither it nor `vat_basis_points` is tax or legal advice.
9. **Replace the bracketed fields** in `apps/web/src/app/legal/` — company
   name, registered address, DPO address, NDPC reference — and have the terms
   read by a Nigerian lawyer. A privacy notice promising rights in the name of
   `[COMPANY]` is a commitment already being broken, in writing, on the page a
   regulator reads first.
10. **Rehearse a restore.** `deploy/standby/restore-drill.sh`. An untested
    backup is a hope with a cron entry, and a truncated copy starts perfectly.
11. **Rotate every credential used during testing.** A sandbox key pasted into
    a terminal, a chat window or a CI log is a key somebody else has.

---

## Getting into the dashboard the first time

**There are no seeded credentials, and there is no default account.** A
platform that shipped with one would ship with the same one everywhere, and the
first thing anybody would find is the last thing anybody would change. So the
operations dashboard has exactly as many users as you have created, which on a
fresh deployment is none.

Getting in is three steps, and the first is the only one that needs `psql` —
which is the point: the bootstrap is a deliberate act on the database host, not
something reachable from the internet.

**1. Register normally.** Open the app and create an account at `/signup`, with
the address the operator will really use. Staff are customers with roles; there
is no separate staff table to add somebody to.

**2. Grant `admin`, once, on the database.**

```sql
-- The one grant that cannot be made through the dashboard, because the
-- dashboard is what it unlocks. `granted_by` is the same row: the first
-- admin is, unavoidably, self-granted, and the audit trail says so rather
-- than pretending somebody else approved it.
INSERT INTO staff_roles (user_id, role, granted_by)
SELECT id, 'admin', id FROM users WHERE email = 'you@yourcompany.com';
```

Roles are read **fresh from the database on every request**, so this takes
effect on the next page load. There is no sign-out, no token to refresh, and —
equally — no fifteen-minute window in which a *revoked* role keeps working.

**3. Enrol a second factor**, at **`/admin/security`**. Every operations route
refuses with `totp_not_enrolled` until this is done, reads included: gating
only the acting half would leave the customer database behind one password.
The screen issues a secret, you add it to an authenticator app, and you type
one code to prove it works. **The secret is shown once.** Until you type that
code the enrolment is inert, so losing it before confirming costs nothing —
start again.

After that, grant the narrower roles from `/admin/staff`. Somebody answering
the phone needs `support`, not the ability to change the transfer fee.

### What a stranger sees at `/admin`

Nothing useful, deliberately. A visitor with no session is sent to sign-in; one
signed in without a role is told the dashboard exists and that they cannot use
it, and is not told which roles there are. The refusal that matters is the
server's — every `/v1/admin/` route checks a role on every request — and the
screen only avoids handing out a map of the operations surface to whoever asks.

---

## Two things the readiness check deliberately does not do

**It does not tell you a setting is *wrong*.** Every setting is seeded, so
"has a row" is true of all of them; what it detects is a setting that is
*missing*, which means a migration has not been applied. Deciding whether
₦500,000,000 is the right reporting threshold is category 4, and it is a
person's job.

**It does not speak for the deployment.** It reads the environment of the
process that answered. That is why the response names the instance, and why a
worker interval reads as `unset-here` rather than as a fault.
