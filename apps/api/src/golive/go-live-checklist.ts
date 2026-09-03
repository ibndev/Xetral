/**
 * WHAT AN OPERATOR MUST DO BEFORE THIS TAKES REAL MONEY — as data, not prose.
 *
 * THE GAP THIS CLOSES. Every phase that shipped a control ended with a
 * paragraph beginning "Before going live, an operator must:" — there are six
 * of them in `docs/PHASES.md` alone, and more scattered through `CLAUDE.md`,
 * `deploy/README.md` and the header comments of individual migrations. Each
 * one is correct. Together they are not a checklist, because nothing lists
 * them, nothing orders them, and nothing notices when a new one is written or
 * an old one stops being true.
 *
 * A prerequisite list nobody has assembled is one somebody will half-follow.
 * That would be survivable if the misses were loud — but the worst of them are
 * SILENT BY CONSTRUCTION. `NOTIFICATION_INTERVAL_SECONDS` unset means outbox
 * rows accumulate, the API keeps answering "check your email", and nothing is
 * ever sent. `RISK_MONITOR_INTERVAL_SECONDS` unset means the compliance queue
 * is empty, which looks exactly like a quiet week.
 *
 * SO IT IS A TABLE, AND A TEST READS IT. `go-live.test.ts` compares this list
 * against `config.ts`, `009_admin.seed.sql` and
 * `026_provider_credentials.seed.sql` IN BOTH DIRECTIONS: a setting the code
 * reads and this file does not name fails the build, and so does an entry here
 * for something that no longer exists. That is the same shape as
 * `route-coverage.test.ts` and `retention_coverage`, and it is here for the
 * same reason — a list of what somebody thought of is exactly the artifact
 * whose gaps are invisible.
 *
 * `scripts/preflight.mjs` reads this same table against a running deployment.
 * The document, the check and the script cannot describe different systems,
 * because there is only one of them.
 */

/**
 * HOW THE MISS PRESENTS, which is the only ordering that helps somebody
 * working through this under time pressure.
 *
 * The categories are ordered by how much you have to know to catch the
 * failure yourself, cheapest first.
 */
export type Failure =
  /** The process exits at startup and names what is missing. */
  | 'refuses-to-boot'
  /** The flow refuses at the first customer request, with a code. */
  | 'refuses-the-first-request'
  /** Nothing errors and nothing happens. These are the dangerous ones. */
  | 'silent'
  /**
   * It works, on a number nobody chose. A default is a decision made by
   * whoever wrote the migration, applied to somebody else's business — a
   * reporting threshold, a fee, a ceiling, a tax rate.
   */
  | 'wrong-by-default'
  /**
   * NOTHING TO DO, and that is recorded rather than left out.
   *
   * The shipped default is deliberate and defensible, so an operator who
   * never touches it has not made a mistake. This category exists because
   * the coverage test demands every setting be CLASSIFIED — and without a
   * way to say "considered, nothing needed", the honest thing to do with a
   * defensible default would be to leave it off the list, which is how the
   * list stops being complete. Same shape as `attention_sources` requiring a
   * rationale for calling a view `internal`.
   */
  | 'default-is-deliberate';

export interface Item {
  /** The environment variable, `platform_settings` key, or action. */
  readonly name: string;
  readonly kind: 'env' | 'setting' | 'credential' | 'action';
  readonly failure: Failure;
  /**
   * What happens if this is missed. Written as a consequence, never as a
   * restatement of the name — "the outbox fills and nothing is sent", not
   * "notifications are not configured".
   */
  readonly ifMissed: string;
  /**
   * True when exactly one instance may set it. Every one of these is a worker
   * interval, and `docker-compose.app.yml` does it by blanking them on `api`
   * and setting them on `worker`.
   */
  readonly singleInstance?: boolean;
  /** The flow that stops working. Undefined means the whole platform. */
  readonly flow?: string;
}

/**
 * The environment. Every variable `config.ts` reads appears here exactly once.
 *
 * A DEFAULT IS NOT ABSENCE. Most of these have one and the platform runs
 * without them; what the `failure` column records is what that default costs.
 * The rate-limit ceilings are the honest example — the shipped numbers are
 * defensible and an operator who never touches them has not made a mistake,
 * so they are `wrong-by-default` only where the right number is specific to
 * this business.
 */
export const ENVIRONMENT: readonly Item[] = [
  // ---- refuses to boot -------------------------------------------------
  {
    name: 'XETRAL_ENVIRONMENT',
    kind: 'env',
    failure: 'refuses-to-boot',
    ifMissed:
      'no default is safe enough to have: staging falling back to production ' +
      'is merely strict, production falling back to staging relaxes the guards ' +
      'protecting real customers.',
  },
  {
    name: 'DATABASE_URL',
    kind: 'env',
    failure: 'refuses-to-boot',
    ifMissed: 'there is no database: nothing to read, nothing to write, no ledger.',
  },
  {
    name: 'ACCESS_TOKEN_KEYS',
    kind: 'env',
    failure: 'refuses-to-boot',
    ifMissed:
      'nothing can sign an access token, so nobody can sign in — not a '  +
      'customer and not an administrator.',
  },
  {
    name: 'ACCESS_TOKEN_CURRENT_VERSION',
    kind: 'env',
    failure: 'refuses-to-boot',
    ifMissed:
      'the keyring holds keys and cannot say which one to sign with, so no '  +
      'access token can be issued.',
  },
  {
    name: 'ENCRYPTION_KEYS',
    kind: 'env',
    failure: 'refuses-to-boot',
    ifMissed:
      'every sealed value — BVNs, card codes, delivery payloads, the outbox ' +
      'body — is unwritable and unreadable. Must be set together with its ' +
      'current version or the config refuses both.',
  },
  {
    name: 'ENCRYPTION_CURRENT_VERSION',
    kind: 'env',
    failure: 'refuses-to-boot',
    ifMissed:
      'the same, for sealing: an envelope carries a key version so keys can be '  +
      'rotated, and there is nothing to stamp on a new one.',
  },
  {
    name: 'KYC_BLIND_INDEX_KEY',
    kind: 'env',
    failure: 'refuses-to-boot',
    ifMissed:
      'one person can open several accounts, and every per-customer control ' +
      'in the system assumes they cannot. SEPARATE from the encryption ' +
      'keyring on purpose: a blind index can have exactly one live key, and ' +
      'rotating it means recomputing every fingerprint.',
  },
  {
    name: 'APP_BASE_URL',
    kind: 'env',
    failure: 'silent',
    ifMissed:
      'password reset emails have no link to put in them, and a customer is ' +
      'shown their @handle with no payment link. It refuses a non-https ' +
      'value rather than accepting one, because a reset link is a bearer ' +
      'token — but it does not refuse ABSENCE, which is the state a fresh ' +
      'deployment is in.',
    flow: 'password reset, payment links',
  },
  {
    name: 'ADMIN_BOOTSTRAP_EMAIL',
    kind: 'env',
    failure: 'silent',
    ifMissed:
      'the operations dashboard cannot be opened by anyone, and the only way ' +
      'in is an INSERT typed at a production psql prompt. Every staff role is ' +
      'granted through a staff route, so the FIRST grant is the one the ' +
      'dashboard cannot make. Set this to an address that has already ' +
      'registered, restart once, then UNSET it — it is inert as soon as an ' +
      'administrator exists, but a variable nobody needs is a variable nobody ' +
      'reviews.',
    flow: 'the operations dashboard',
  },
];

/**
 * THE WORKERS. Every one of these is a scheduled job that does not exist
 * unless an interval is set, and every one of them fails by doing nothing.
 *
 * They go on EXACTLY ONE INSTANCE — `docker-compose.app.yml` does this by
 * blanking them on `api` and setting them on `worker`. Duplicate sweeps are
 * mostly safe (an advisory lock serialises them, and the ledger's idempotency
 * key makes a repeated posting a replay), but asking a provider about the same
 * purchase from four processes is rate-limited at best.
 */
export const WORKERS: readonly Item[] = [
  {
    name: 'NOTIFICATION_INTERVAL_SECONDS',
    kind: 'env',
    failure: 'silent',
    singleInstance: true,
    flow: 'every email',
    ifMissed:
      'THE WORST MISS IN THIS FILE. Outbox rows accumulate, the API goes on ' +
      'answering "check your email", and nothing is ever sent — including the ' +
      'password reset a locked-out customer is waiting on. Nothing errors, ' +
      'because writing the row succeeded.',
  },
  {
    name: 'RISK_MONITOR_INTERVAL_SECONDS',
    kind: 'env',
    failure: 'silent',
    singleInstance: true,
    flow: 'transaction monitoring',
    ifMissed:
      'the compliance queue is empty, which looks exactly like a quiet week. ' +
      'It has a default on the worker for that reason; this entry is about ' +
      'the instance actually running one.',
  },
  {
    name: 'RETENTION_INTERVAL_SECONDS',
    kind: 'env',
    failure: 'silent',
    singleInstance: true,
    flow: 'data retention',
    ifMissed:
      'personal data is kept past the period the published privacy notice ' +
      'quotes. The notice is rendered from the schema, so the page keeps ' +
      'making a promise nothing is keeping.',
  },
  {
    name: 'RECONCILE_INTERVAL_SECONDS',
    kind: 'env',
    failure: 'silent',
    singleInstance: true,
    flow: 'bills, eSIM, numbers',
    ifMissed:
      'a purchase whose provider call timed out stays `reserved` for ever: ' +
      "the customer's money is held against an outcome nobody will ever look " +
      'up.',
  },
  {
    name: 'RECONCILE_GRACE_SECONDS',
    kind: 'env',
    failure: 'default-is-deliberate',
    flow: 'bills, eSIM, numbers',
    ifMissed:
      'how long a reserved purchase is left alone before the sweep asks about ' +
      'it. Zero is meaningful and permitted.',
  },
  {
    name: 'RECONCILE_STALE_SECONDS',
    kind: 'env',
    failure: 'wrong-by-default',
    flow: 'bills, eSIM, numbers',
    ifMissed:
      'when a held purchase stops being retried and is escalated to a person. ' +
      'By then both remaining answers can be the wrong one, so the number is a ' +
      'judgement about your support cover, not a technical constant.',
  },
  {
    name: 'DEPOSIT_RECONCILE_INTERVAL_SECONDS',
    kind: 'env',
    failure: 'silent',
    singleInstance: true,
    flow: 'NGN funding',
    ifMissed:
      'a lost deposit webhook is money a customer really transferred that ' +
      'never reaches a balance, with nothing retrying. Waiting does not help ' +
      '— the sweep is what ASKS.',
  },
  {
    name: 'CRYPTO_RECONCILE_INTERVAL_SECONDS',
    kind: 'env',
    failure: 'silent',
    singleInstance: true,
    flow: 'crypto',
    ifMissed: 'a withdrawal nobody answered for stays reserved and the money stays held.',
  },
  {
    name: 'CRYPTO_DEPOSIT_RECONCILE_INTERVAL_SECONDS',
    kind: 'env',
    failure: 'silent',
    singleInstance: true,
    flow: 'crypto',
    ifMissed:
      'a deposit that is on a chain never becomes a balance. Withdrawals had ' +
      'a sweep from the day they shipped and deposits did not, which is the ' +
      'Tier 1 finding this closed.',
  },
  {
    name: 'GIFTCARD_RELEASE_INTERVAL_SECONDS',
    kind: 'env',
    failure: 'silent',
    singleInstance: true,
    flow: 'gift cards',
    ifMissed:
      'customers are paid and can never spend it: the hold matures and ' +
      'nothing moves it to the wallet. Bootstrap warns loudly when gift cards ' +
      'are on and nobody is releasing holds.',
  },
  {
    name: 'BALANCE_RECONCILE_INTERVAL_SECONDS',
    kind: 'env',
    failure: 'silent',
    singleInstance: true,
    flow: 'reconciliation',
    ifMissed:
      "the ledger and the provider's own figures are never compared, and the " +
      'stuck-card-hold check rides on this sweep — so a settlement webhook ' +
      'that never arrived stays invisible to everything else in the system.',
  },
  {
    name: 'ERROR_ALERT_INTERVAL_SECONDS',
    kind: 'env',
    failure: 'silent',
    singleInstance: true,
    flow: 'error alerting',
    ifMissed:
      'errors are recorded and nobody is told. The table fills; the alert that ' +
      'would have named a new fingerprint never goes out.',
  },
];

/**
 * The providers. Each refuses its own flow at the first request, with a code —
 * loud, and confined to what it configures.
 *
 * A KEY MAY ALSO BE PASTED INTO `/admin/credentials`, and the database is
 * authoritative when it is. These entries are the environment fallback, which
 * is what a fresh deployment has before anybody has opened the dashboard.
 */
export const PROVIDERS: readonly Item[] = [
  {
    name: 'BITNOB_BASE_URL',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'cards, NGN funding, crypto, FX',
    ifMissed:
      'four flows refuse at the first request: cards, naira funding, crypto and '  +
      'FX all speak to one provider and there is no host to call.',
  },
  {
    name: 'BITNOB_CLIENT_ID',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'cards, NGN funding, crypto, FX',
    ifMissed:
      'the same four flows refuse. Bitnob v2 SIGNS each request rather than ' +
      'bearing a token, so it needs an id AND a secret; the old ' +
      'BITNOB_API_KEY is neither and is not read. A value pasted into ' +
      '`/admin/credentials` overrides this one, with five seconds of cache.',
  },
  {
    name: 'BITNOB_CLIENT_SECRET',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'cards, NGN funding, crypto, FX',
    ifMissed:
      'the same four flows refuse. THIS VALUE ALSO SELECTS THE ENVIRONMENT: ' +
      'sandbox and production share one host and differ only in the secret ' +
      'signed with, so a sandbox secret here means no real card is ever ' +
      'issued and a live one on staging means every test card is real. On ' +
      'staging the API asks `/api/whoami` before its first request and ' +
      'refuses a live account.',
  },
  {
    name: 'PAYSTACK_SECRET_KEY',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'naira funding',
    ifMissed:
      'no customer can be issued a naira account number and no deposit can '  +
      'be verified. ONE value does both: it authorises calls AND verifies '  +
      'webhooks, because Paystack signs an inbound event with the same key it '  +
      'authenticates an outbound call with — so there is deliberately no '  +
      'separate webhook secret to forget. sk_test_ or sk_live_ decides '  +
      'whether the money is real.',
  },
  {
    name: 'PAYSTACK_BASE_URL',
    kind: 'env',
    failure: 'default-is-deliberate',
    flow: 'naira funding',
    ifMissed:
      'defaults to https://api.paystack.co, which is the only host Paystack '  +
      'serves. Present so a proxy or a recording fixture can be pointed at '  +
      'instead, not because the default is in doubt.',
  },
  {
    name: 'PAYSTACK_PREFERRED_BANK',
    kind: 'env',
    failure: 'wrong-by-default',
    flow: 'naira funding',
    ifMissed:
      'Paystack chooses the issuing bank. Usually fine, and worth setting '  +
      'deliberately: test integrations issue Titan accounts and live ones are '  +
      'usually Wema, and a business enabled for one and not the other gets a '  +
      'refusal at the moment a customer asks for an account. The stored '  +
      'setting `paystack_preferred_bank` overrides this.',
  },
  {
    name: 'BITNOB_WEBHOOK_SECRET',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'cards, NGN funding, crypto',
    ifMissed:
      'every inbound webhook answers 401 — including the deposit webhook, ' +
      'which is the only event in the system that creates money.',
  },
  {
    name: 'WEBHOOK_BASE_URL',
    kind: 'env',
    // Not `silent`: nothing here breaks if it is unset. The dashboard says so
    // and shows the paths instead, so an operator sees a partial answer rather
    // than a wrong one. What it costs is that somebody has to work the address
    // out — which is how the wrong one gets pasted into Bitnob.
    failure: 'refuses-the-first-request',
    flow: 'cards, NGN funding, crypto',
    ifMissed:
      '`/admin/credentials` shows webhook PATHS without a host, so the URL ' +
      'given to Bitnob is guessed. It must be the API origin: the web app ' +
      'proxy drops `x-bitnob-signature`, so every event through it answers 401.',
  },
  {
    name: 'BITNOB_NGN_AMOUNT_UNIT',
    kind: 'env',
    failure: 'wrong-by-default',
    flow: 'NGN funding',
    ifMissed:
      'CONFIRM THIS AGAINST THE FIRST REAL DEPOSIT. It defaults to `kobo`, and ' +
      'a factor-of-100 misread blows `DEPOSIT_CEILING_KOBO` — so a wrong value ' +
      'puts the first deposit in suspense rather than in somebody\'s balance, ' +
      'which is recoverable. Reading it too SMALL is not caught, by design.',
  },
  {
    name: 'VTPASS_BASE_URL',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'airtime, data, bills',
    ifMissed:
      'the catalogue loads and every purchase refuses: there is no host to send '  +
      'the order to.',
  },
  {
    name: 'VTPASS_API_KEY',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'airtime, data, bills',
    ifMissed:
      'airtime, data and utility purchases refuse; the customer sees the '  +
      'catalogue and cannot buy from it.',
  },
  {
    name: 'VTPASS_SECRET_KEY',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'airtime, data, bills',
    ifMissed: 'VTpass signs with this; without it every purchase is rejected.',
  },
  {
    name: 'VTPASS_PUBLIC_KEY',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'airtime, data, bills',
    ifMissed: 'the read paths (catalogue, verification) are refused.',
  },
  {
    name: 'AIRALO_BASE_URL',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'eSIM',
    ifMissed:
      'eSIM routes refuse. Airalo is the only provider for them, so the whole '  +
      'product is unavailable rather than degraded.',
  },
  {
    name: 'AIRALO_CLIENT_ID',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'eSIM',
    ifMissed:
      'the OAuth2 token exchange has no client to identify, so every eSIM '  +
      'request fails before it is sent.',
  },
  {
    name: 'AIRALO_CLIENT_SECRET',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'eSIM',
    ifMissed:
      'it is both the OAuth2 secret and the HMAC-SHA512 key every request body ' +
      'is signed with.',
  },
  {
    name: 'TWILIO_BASE_URL',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'virtual numbers',
    ifMissed:
      'number routes refuse. Twilio is the only provider for them.',
  },
  {
    name: 'TWILIO_ACCOUNT_SID',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'virtual numbers',
    ifMissed:
      'the account half of Twilio\'s Basic auth; without it every call is '  +
      'rejected as unauthenticated.',
  },
  {
    name: 'TWILIO_AUTH_TOKEN',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'virtual numbers',
    ifMissed:
      'the password half of that Basic auth. Rotating it at Twilio without '  +
      'setting it here takes the flow down silently.',
  },
  {
    name: 'TWILIO_NUMBER_PRICE_CENTS',
    kind: 'env',
    failure: 'refuses-the-first-request',
    flow: 'virtual numbers',
    ifMissed:
      'A NUMBER IS PRICED BY US, NOT BY TWILIO. An instance that has not set ' +
      'this cannot sell a number, deliberately — there is no default, because ' +
      'a default price is a price nobody chose.',
  },
  {
    name: 'RESEND_API_KEY',
    kind: 'env',
    failure: 'silent',
    flow: 'every email',
    ifMissed:
      'ENQUEUEING STILL SUCCEEDS. `available` asks whether a message can be ' +
      'written (a keyring); `deliverable` asks whether anything will send it. ' +
      'Password reset asked the first and told locked-out customers to check ' +
      'an inbox nothing would reach.',
  },
  {
    name: 'NOTIFICATION_FROM',
    kind: 'env',
    failure: 'silent',
    flow: 'every email',
    ifMissed:
      'the provider has no sender to put on the message, so every send is '  +
      'rejected and the outbox row is retried for ever.',
  },
  {
    name: 'NOTIFICATION_REPLY_TO',
    kind: 'env',
    failure: 'default-is-deliberate',
    flow: 'every email',
    ifMissed: 'replies go to the From address. Set it if that is not a mailbox anybody reads.',
  },
  {
    name: 'NOTIFICATION_ALLOWLIST',
    kind: 'env',
    failure: 'default-is-deliberate',
    flow: 'every email',
    ifMissed:
      'STAGING ONLY, and EMPTY MEANS NOBODY — which is the safe direction. A ' +
      'staging database restored from production holds every real address, and ' +
      'a message to an address outside the list is ABANDONED rather than ' +
      'retried, because waiting will not make it allowed.',
  },
  {
    name: 'OPERATIONS_EMAIL',
    kind: 'env',
    failure: 'silent',
    flow: 'error alerting',
    ifMissed: 'error alerts are composed and have nowhere to go.',
  },
];

/**
 * The edge, and the things that are about how this instance is deployed.
 */
export const DEPLOYMENT: readonly Item[] = [
  {
    name: 'REDIS_URL',
    kind: 'env',
    failure: 'silent',
    ifMissed:
      'the rate limiter falls back to in-process, so each instance keeps its ' +
      'own count and the effective ceiling is multiplied by however many are ' +
      'running. Correct for one box only; bootstrap logs a warning.',
  },
  {
    name: 'TRUST_PROXY_HOPS',
    kind: 'env',
    failure: 'wrong-by-default',
    ifMissed:
      'how many proxies in front of this are trusted to have set ' +
      '`x-forwarded-for`. Too high and a client can spoof its own address past ' +
      'the limiter; too low and every customer behind the edge is one client. ' +
      'It must match the actual topology, which the default cannot know.',
  },
  {
    name: 'METRICS_TOKEN',
    kind: 'env',
    failure: 'silent',
    ifMissed:
      '`/metrics` answers 404, not 401 — with no token there is nothing to ' +
      'authorise against, and answering 401 would confirm to a prober that the ' +
      'endpoint exists. So monitoring is simply absent, and the absence looks ' +
      'like a routing problem.',
  },
  {
    name: 'ACCESS_TOKEN_TTL_SECONDS',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed:
      'fifteen minutes, and the number is small because a signed access token ' +
      'CANNOT BE REVOKED MID-LIFE. Raising it is a security decision, not a ' +
      'tuning one.',
  },
  {
    name: 'REFRESH_TOKEN_TTL_SECONDS',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed: 'how long a device stays signed in without using the app.',
  },
  {
    name: 'PASSWORD_RESET_TTL_MINUTES',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed: 'thirty minutes. A reset link is a bearer token; longer is a longer window.',
  },
  {
    name: 'LOGIN_RATE_LIMIT_PER_IDENTIFIER',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed:
      'ten per window per account. This is the bucket NAT does not blur, and ' +
      'it is what makes credential stuffing spread across identifiers instead.',
  },
  {
    name: 'LOGIN_RATE_LIMIT_PER_IP',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed:
      'thirty per window per address. Deliberately loose: Nigerian carriers put ' +
      'whole subscriber pools behind a handful of addresses.',
  },
  {
    name: 'LOGIN_RATE_LIMIT_WINDOW_SECONDS',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed: 'fifteen minutes, shared by both login buckets.',
  },
  {
    name: 'PASSWORD_RESET_RATE_LIMIT_PER_IDENTIFIER',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed:
      'three an hour. Far tighter than login, and on its OWN bucket: each ' +
      'accepted request mails somebody who did not ask for it.',
  },
  {
    name: 'PASSWORD_RESET_RATE_LIMIT_PER_IP',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed:
      'fifteen an hour per address — looser, because a shared carrier address ' +
      'carries many customers who each get three.',
  },
  {
    name: 'PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed: 'one hour, shared by both reset buckets.',
  },
  {
    name: 'REQUEST_RATE_LIMIT_WINDOW_SECONDS',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed: 'one minute, shared by every request class below.',
  },
  {
    name: 'REQUEST_RATE_LIMIT_PUBLIC',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed: 'the class an unauthenticated request falls into, keyed on address.',
  },
  {
    name: 'REQUEST_RATE_LIMIT_READ',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed: 'keyed per CUSTOMER, not per address. A screen opening fires several at once.',
  },
  {
    name: 'REQUEST_RATE_LIMIT_WRITE',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed:
      'per customer. Everything that changes state and is not money — setting ' +
      'a PIN, raising a dispute, enrolling a device.',
  },
  {
    name: 'REQUEST_RATE_LIMIT_MONEY',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed:
      'the tightest class, deliberately: a stolen session emptying an account ' +
      'looks exactly like a burst of transfers.',
  },
  {
    name: 'REQUEST_RATE_LIMIT_STAFF',
    kind: 'env',
    failure: 'default-is-deliberate',
    ifMissed:
      "higher than a customer's, because refusing a reviewer mid-queue is how a " +
      'backlog becomes a shared login.',
  },
  {
    name: 'DEPOSIT_CEILING_KOBO',
    kind: 'env',
    failure: 'wrong-by-default',
    flow: 'NGN funding',
    ifMissed:
      'the largest deposit that will be CREDITED rather than held in suspense. ' +
      'Asymmetric on purpose — it catches over-crediting, which is spent before ' +
      'anyone notices; under-crediting surfaces as a complaint within the hour. ' +
      'Set it to a figure that reflects what your customers actually send.',
  },
  {
    name: 'TRANSFER_FEE_BASIS_POINTS',
    kind: 'env',
    failure: 'wrong-by-default',
    ifMissed:
      'the ENVIRONMENT FALLBACK for the fee. `platform_settings` is ' +
      'authoritative, so setting this and restarting appears to do nothing — ' +
      'bootstrap names every environment value the database is overriding, ' +
      'because that failure is otherwise silent and infuriating.',
  },
  {
    name: 'GIFT_CARDS_ENABLED',
    kind: 'env',
    failure: 'default-is-deliberate',
    flow: 'gift cards',
    ifMissed:
      'FALSE, and it ships that way on purpose. Gift cards need BOTH this and ' +
      'the stored setting: it is the one flow that pays out against a bearer ' +
      'instrument nobody can verify at the moment of payment.',
  },
  {
    name: 'GIFT_CARD_HOLD_DAYS',
    kind: 'env',
    failure: 'wrong-by-default',
    flow: 'gift cards',
    ifMissed:
      'the hold is the only control still standing once a card is approved. ' +
      'Enforced by the DATABASE clock in two places so a skewed worker cannot ' +
      'shorten it.',
  },
  {
    name: 'CRYPTO_CONFIRMATIONS_*',
    kind: 'env',
    failure: 'wrong-by-default',
    flow: 'crypto',
    ifMissed:
      'PER CHAIN, one variable per network. The defaults are deliberately ' +
      'conservative and lowering one is a decision about how much reorg risk to ' +
      'accept. Stored per deposit row, so raising it later cannot un-confirm ' +
      'money already spent.',
  },
];

/**
 * `platform_settings`. THE DATABASE IS AUTHORITATIVE and the environment is a
 * fallback for the moments before the table can be read — which is what lets
 * an operator change a fee, or switch a flow off during an incident, without a
 * deploy.
 *
 * Bounds are CHECKs rather than form validation, so `1500` typed where basis
 * points were meant is refused whether it arrives through the dashboard, a
 * script, or psql at three in the morning.
 *
 * Most of these ship with a defensible default and are marked as such. The
 * ones that are `wrong-by-default` are the figures that are a statement about
 * YOUR business or about Nigerian law, which no migration can know.
 */
export const SETTINGS: readonly Item[] = [
  // ---- money somebody must decide --------------------------------------
  {
    name: 'transfer_fee_basis_points',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'DEFAULTS TO ZERO, deliberately: a fee nobody configured is money taken ' +
      'from a customer because of a default. Capped at 500 by CHECK.',
  },
  {
    name: 'card_issuance_fee_cents',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'WHAT A CARD COSTS, in US CENTS — 200 is $2.00, and it is the figure the ' +
      'onboarding screen shows. It is charged as a card_creation entry against ' +
      'the customer\'s USD wallet and split for VAT, so this is a price rather ' +
      'than a label: setting it to 0 issues cards free and the screen says so. ' +
      'Bounded 0..2000 by CHECK, which is what refuses a figure typed in ' +
      'dollars.',
  },
  {
    name: 'transfer_daily_limit_kobo',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'the daily ceiling, in KOBO and NAIRA ONLY. It ships EQUAL to the NGN ' +
      'reporting threshold, so out of the box no single transfer can reach ' +
      'that threshold — moving either is a deliberate act.',
  },
  {
    name: 'vat_basis_points',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'NOT TAX ADVICE. The rate a Nigerian company charges on a service, taken ' +
      'out of the fee as a LIABILITY rather than revenue. Review it against ' +
      'what is currently in force.',
  },
  {
    name: 'vat_inclusive',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'SHIPS ON, because inclusive VAT is a BOOKING correction: the customer ' +
      'pays what they always paid and we stop calling all of it revenue. ' +
      'Leaving it off means knowingly recording a wrong number.',
  },
  {
    name: 'transfer_levy_enabled',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'SHIPS OFF, and the asymmetry with VAT is the point: a levy CHANGES WHAT ' +
      'A CUSTOMER IS CHARGED, so the machinery ships complete and the decision ' +
      'does not ship at all.',
  },
  {
    name: 'transfer_levy_kobo',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'the flat levy, in kobo, NAIRA ONLY — it is published in kobo and is a '  +
      'statement about naira. Meaningless until the switch above is on.',
  },
  {
    name: 'transfer_levy_threshold_kobo',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'the transfer size at which the levy starts applying. Below it, nothing '  +
      'is charged and no row is written.',
  },
  {
    name: 'deposit_ceiling_kobo',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'the stored twin of `DEPOSIT_CEILING_KOBO`. The database wins, so setting '  +
      'only the environment variable appears to do nothing.',
  },
  {
    name: 'purchase_daily_limit_kobo',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed: 'the daily ceiling across bills, airtime, data, eSIM and numbers, in kobo.',
  },
  {
    name: 'fx_daily_limit_kobo',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed: 'the daily ceiling on conversion and remittance, in kobo, naira only.',
  },
  {
    name: 'giftcard_daily_limit_kobo',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed: 'the daily ceiling on gift card payouts, in kobo, naira only.',
  },
  {
    name: 'crypto_daily_limit_usdt_minor',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'PER CURRENCY, because an amount carries units. A kobo figure applied to ' +
      'USDT because both are integers is the same mistake as adding kobo to cents.',
  },
  {
    name: 'crypto_daily_limit_btc_minor',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'the same, in satoshis. BTC has EIGHT decimal places, so a figure copied '  +
      'from the USDT row is out by a factor of a hundred.',
  },
  {
    name: 'card_daily_spend_limit_cents',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed: 'the daily ceiling on card authorizations, in CENTS — cards are dollar-denominated.',
  },

  // ---- the kill switches -----------------------------------------------
  {
    name: 'registration_enabled',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'on. Switching it off stops new accounts during an incident without '  +
      'touching anybody already signed up.',
  },
  {
    name: 'cards_enabled',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'a real switch, read on every card route rather than a row nothing '  +
      'consults. Off means off, immediately.',
  },
  {
    name: 'card_issuance_provider_cost_cents',
    kind: 'setting',
    failure: 'wrong-by-default',
    flow: 'USD cards',
    ifMissed:
      'the shipped 100 is the commonly quoted issuer charge and is a starting '  +
      'point, not a verified contract term. It is booked as a provider cost '  +
      'against the balance held with the issuer, so a wrong figure makes the '  +
      'margin on a card wrong AND puts `provider_float` out of step with what '  +
      'the issuer says it holds — which the balance reconciliation reports as '  +
      'drift. Set it to what the issuer actually bills.',
  },
  {
    name: 'payout_provider',
    kind: 'setting',
    failure: 'default-is-deliberate',
    flow: 'bank payouts',
    ifMissed:
      'defaults to `paystack`, which is the rail this deployment already '  +
      'holds a credential for. It is SEPARATE from `funding_provider` '  +
      'because a business can be approved for dedicated accounts and not yet '  +
      'for transfers — so check the transfers product is live before sending '  +
      'money out. Payouts already sent keep being read from the rail that '  +
      'sent them.',
  },
  {
    name: 'funding_provider',
    kind: 'setting',
    failure: 'default-is-deliberate',
    flow: 'naira funding',
    ifMissed:
      'defaults to `paystack`, which opens an account from a name and an '  +
      'email address. `bitnob` is the alternative and REFUSES anybody without '  +
      'a verified BVN, so switching to it while customers are unverified '  +
      'stops new accounts being opened. Accounts already issued keep working '  +
      'either way — a number is permanent and its bank has it saved.',
  },
  {
    name: 'paystack_preferred_bank',
    kind: 'setting',
    failure: 'wrong-by-default',
    flow: 'naira funding',
    ifMissed:
      'blank, so Paystack chooses. See PAYSTACK_PREFERRED_BANK: a bank the '  +
      'integration is not enabled for is refused at the moment a customer '  +
      'asks for an account, not at boot.',
  },
  {
    name: 'payouts_enabled',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'sending money to a bank. On by default like the other rails, because ' +
      'the money is the customer\'s own and the overdraft guard refuses it ' +
      'when it is not — unlike gift cards, nothing here pays out against an ' +
      'instrument that cannot be verified. Off refuses NEW payouts; ones ' +
      'already sent keep settling, because money that has left is still ' +
      'recorded.',
  },
  {
    name: 'crypto_enabled',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'a real switch. It was a row NOTHING READ until Tier 1 — an operator ' +
      'could switch crypto off, watch the dashboard confirm it, and withdrawals ' +
      'would keep going out.',
  },
  {
    name: 'fx_enabled',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed: 'a real switch over conversion and remittance, proved by a test that flips it.',
  },
  {
    name: 'bills_enabled',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'one switch over VTpass, Airalo and Twilio together — so a bad afternoon '  +
      'at any of them can be stopped in one action.',
  },
  {
    name: 'gift_cards_enabled',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'the stored half of the pair. BOTH this and `GIFT_CARDS_ENABLED` must be ' +
      'on, and either being off means off — so an incident can be stopped from ' +
      'the dashboard in seconds.',
  },
  {
    name: 'risk_monitoring_enabled',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'on. Switching it off stops the sweep writing signals, which looks '  +
      'exactly like a quiet week — so it is a switch to use deliberately.',
  },

  // ---- fraud and velocity ----------------------------------------------
  {
    name: 'transfer_count_hourly',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'A COUNT CARRIES NO UNITS, so it applies in EVERY currency — unlike the ' +
      'daily kobo ceiling, which is a statement about naira alone.',
  },
  {
    name: 'transfer_new_recipients_daily',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'how many strangers a customer may pay in a Lagos day. This is the shape ' +
      'a takeover actually has: several ordinary transfers to people they have ' +
      'never paid, each fitting under the ceiling.',
  },
  {
    name: 'fx_count_hourly',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed: 'how many conversions an hour, in any currency, before a customer is refused.',
  },
  {
    name: 'giftcard_count_hourly',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed: 'how many gift card submissions an hour before a customer is refused.',
  },
  {
    name: 'crypto_withdrawal_count_hourly',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'withdrawals an hour. On-chain sends are unrecallable, so this is the '  +
      'ceiling that matters most.',
  },
  {
    name: 'card_hourly_authorization_limit',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'authorizations an hour before the card is frozen. A card authorization '  +
      'has already happened when we hear about it, so only the next one can be '  +
      'stopped.',
  },
  {
    name: 'card_decline_burst_threshold',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'how many consecutive declines look like somebody testing a stolen card '  +
      'rather than a customer mistyping a limit.',
  },
  {
    name: 'card_duplicate_window_seconds',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'how close two identical charges must be to count as a duplicate rather '  +
      'than a customer buying the same thing twice.',
  },
  {
    name: 'card_freeze_on_duplicate',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed: 'whether a duplicate freezes the card. Freezing stops spending, not looking.',
  },
  {
    name: 'card_freeze_on_insufficient_funds',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed: 'whether a run of declines for want of funds freezes the card.',
  },
  {
    name: 'card_hold_window_days',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'SIXTEEN, deliberately longer than fourteen. Bitnob settles up to 7–14 ' +
      'BUSINESS days out, so a shorter window is a false alarm every fortnight ' +
      '— and an alert people learn to ignore is worse than none.',
  },

  // ---- monitoring ------------------------------------------------------
  {
    name: 'risk_case_auto_open_signals',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'how many open signals on one customer make the sweep open a case. '  +
      'Noticing the pattern otherwise means somebody sorting the queue and '  +
      'counting, which is the work nobody does at four in the afternoon.',
  },
  {
    name: 'risk_case_deadline_hours',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      "a REGULATOR'S reporting window, not a courtesy. The deadline is the " +
      'database\'s clock and cannot be supplied or moved.',
  },
  {
    name: 'risk_structuring_count',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'how many just-under-threshold transfers look like somebody deliberately '  +
      'staying under a reporting line.',
  },
  {
    name: 'risk_passthrough_percent',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'how much of what came in has to go straight back out to count as '  +
      'pass-through. `notable_minor` is the floor that stops an account moving '  +
      'small sums firing this daily.',
  },
  {
    name: 'risk_crypto_fast_out_hours',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'how quickly a deposit leaving again on a chain is worth a look. Crypto '  +
      'out is the leg that cannot be recalled.',
  },
  {
    name: 'risk_dormant_days',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed: 'how long an account must be silent for sudden activity on it to be notable.',
  },
  {
    name: 'provider_degraded_percent',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'the failure rate that reads as ill health. A REJECTION IS NOT ILL ' +
      'HEALTH and is excluded — an alert firing on every declined card is one ' +
      'people mute.',
  },
  {
    name: 'provider_degraded_minimum_calls',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'what stops a quiet endpoint reading as an outage. One failure out of one ' +
      'is a 100% failure rate and says nothing.',
  },
  {
    name: 'provider_health_window_minutes',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'how far back the failure rate is measured. Too short and one bad minute '  +
      'reads as an outage.',
  },
  {
    name: 'balance_tolerance_minor',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      "how far our figure and the provider's may differ before it is reported " +
      'as drift rather than as timing.',
  },
  {
    name: 'reconcile_stale_hours',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'when a held purchase stops being retried and is escalated to a person '  +
      'instead. The stored twin of `RECONCILE_STALE_SECONDS`.',
  },

  // ---- customers, disputes, data ---------------------------------------
  {
    name: 'dispute_window_days',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'how long after a transaction a customer may say "I did not do this". '  +
      'The deadline is the database\'s clock and cannot be moved.',
  },
  {
    name: 'dispute_resolution_hours',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      "how long we have to answer. The database's clock; a process that can " +
      'push its own deadline out has no deadline.',
  },
  {
    name: 'data_request_response_days',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'CAPPED AT 30 by CHECK, so the setting can only be used to answer FASTER. ' +
      'A deadline an operator can extend is not a deadline.',
  },
  {
    name: 'giftcard_hold_days',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'the stored twin of `GIFT_CARD_HOLD_DAYS`, and the one the database clock '  +
      'enforces against.',
  },
  {
    name: 'support_email',
    kind: 'setting',
    failure: 'wrong-by-default',
    ifMissed:
      'the address customers are given. A default here is a mailbox nobody ' +
      'reads, quoted to somebody with a problem.',
  },

  // ---- retention periods -----------------------------------------------
  {
    name: 'retention_notifications_days',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'the published privacy notice is RENDERED FROM THIS. A test fails the ' +
      'build if the page quotes a period the sweep does not read — so changing ' +
      'one means changing what customers are told.',
  },
  {
    name: 'retention_tokens_days',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed: 'quoted on the privacy notice. A LIVE token is never deleted, at any age.',
  },
  {
    name: 'retention_error_events_days',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed: 'quoted on the published privacy notice, which is rendered from this schema.'
  },
  {
    name: 'retention_card_declines_days',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'quoted on the published privacy notice. Declines are the evidence a ' +
      'customer disputing a charge needs.',
  },
  {
    name: 'retention_sign_in_events_days',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'read by BOTH the sweep and 024\'s trigger, so the two cannot disagree ' +
      'about which rows are still evidence of a takeover.',
  },
  {
    name: 'retention_totp_steps_hours',
    kind: 'setting',
    failure: 'default-is-deliberate',
    ifMissed:
      'the one relaxation of an append-only rule, and only past the window in ' +
      'which a code could still be presented.',
  },
];

/**
 * The credential slots in `provider_credential_slots`.
 *
 * A CREDENTIAL GOES IN AND NEVER COMES BACK OUT over HTTP — there is no
 * endpoint that returns one, not sealed, not masked. These entries name what
 * must be filled, never what it should contain.
 *
 * `in_use = FALSE` marks a slot documented AHEAD of its adapter. The key is
 * stored safely and read by nothing, and both the API and the dashboard say
 * so, because a filled box on an operations screen reads as "this is running".
 */
export const CREDENTIALS: readonly Item[] = [
  {
    name: 'bitnob.api_key',
    kind: 'credential',
    failure: 'refuses-the-first-request',
    flow: 'cards, NGN funding, crypto, FX',
    ifMissed: 'the database overrides the environment when set; five seconds of cache.',
  },
  {
    name: 'bitnob.webhook_secret',
    kind: 'credential',
    failure: 'refuses-the-first-request',
    flow: 'cards, NGN funding, crypto',
    ifMissed:
      'HMAC-SHA512, hex, in `x-bitnob-signature`. Without it every webhook is '  +
      'unverifiable and answers 401 — including the one that creates money.',
  },
  {
    name: 'vtpass.api_key',
    kind: 'credential',
    failure: 'refuses-the-first-request',
    flow: 'airtime, data, bills',
    ifMissed: 'the stored twin of `VTPASS_API_KEY`; the database wins when both are set.',
  },
  {
    name: 'vtpass.secret_key',
    kind: 'credential',
    failure: 'refuses-the-first-request',
    flow: 'airtime, data, bills',
    ifMissed: 'the stored twin of `VTPASS_SECRET_KEY`; the database wins when both are set.',
  },
  {
    name: 'vtpass.public_key',
    kind: 'credential',
    failure: 'refuses-the-first-request',
    flow: 'airtime, data, bills',
    ifMissed: 'the stored twin of `VTPASS_PUBLIC_KEY`; the database wins when both are set.',
  },
  {
    name: 'airalo.client_secret',
    kind: 'credential',
    failure: 'refuses-the-first-request',
    flow: 'eSIM',
    ifMissed:
      'both the OAuth2 secret and the HMAC key every Airalo body is signed with.',
  },
  {
    name: 'twilio.auth_token',
    kind: 'credential',
    failure: 'refuses-the-first-request',
    flow: 'virtual numbers',
    ifMissed: 'the stored twin of `TWILIO_AUTH_TOKEN`; the database wins when both are set.',
  },
  {
    name: 'resend.api_key',
    kind: 'credential',
    failure: 'silent',
    flow: 'every email',
    ifMissed:
      'enqueueing still succeeds and nothing sends. `available` is not '  +
      '`deliverable`.',
  },
  {
    name: 'dojah.app_id',
    kind: 'credential',
    failure: 'default-is-deliberate',
    flow: 'KYC',
    ifMissed:
      'NOT IN USE: documented ahead of its adapter. Nothing reads it, KYC ' +
      'approval is a person reading documents, and filling it in changes ' +
      'nothing until an adapter exists.',
  },
  {
    name: 'dojah.secret_key',
    kind: 'credential',
    failure: 'default-is-deliberate',
    flow: 'KYC',
    ifMissed: 'not in use: stored safely, read by nothing, until an adapter exists.',
  },
  {
    name: 'dojah.webhook_secret',
    kind: 'credential',
    failure: 'default-is-deliberate',
    flow: 'KYC',
    ifMissed: 'not in use: stored safely, read by nothing, until an adapter exists.',
  },
];

/**
 * The things that are not a variable anywhere: people, published prices, and
 * words a lawyer has to have read.
 *
 * These are the entries with no automated check at all, which is precisely why
 * they need writing down — a missing environment variable eventually announces
 * itself, and "nobody was granted `dispute_reviewer`" announces itself as a
 * queue nobody works.
 */
export const ACTIONS: readonly Item[] = [
  {
    name: 'grant `admin` to a real person',
    kind: 'action',
    failure: 'refuses-the-first-request',
    ifMissed:
      'THE FIRST GRANT IS AN INSERT, because there is no admin yet to make it ' +
      'through the dashboard. Every narrower role is granted from the ' +
      'dashboard afterwards. Without this the entire operations surface is ' +
      'unreachable by anybody.',
  },
  {
    name: 'enrol a staff second factor',
    kind: 'action',
    failure: 'refuses-the-first-request',
    ifMissed:
      'TOTP is required on EVERY staff route, reads included — gating only the ' +
      'acting half would leave the customer database behind one password. A ' +
      'CONFIRMED secret cannot be swapped in place.',
  },
  {
    name: 'grant `giftcard_reviewer`',
    kind: 'action',
    failure: 'silent',
    flow: 'gift cards',
    ifMissed:
      'every payout is approved by a human and there is no auto-approval path, ' +
      'so submissions queue and nobody can act on them.',
  },
  {
    name: 'grant `dispute_reviewer`',
    kind: 'action',
    failure: 'silent',
    flow: 'disputes',
    ifMissed:
      'its OWN role, not the gift card reviewer\'s. Disputes are raised and ' +
      'nobody can resolve them, while the clock the database keeps runs down.',
  },
  {
    name: 'publish an FX spread policy per pair AND DIRECTION',
    kind: 'action',
    failure: 'refuses-the-first-request',
    flow: 'FX',
    ifMissed:
      'AN UNPUBLISHED PAIR IS REFUSED, never quoted from a default — right, and ' +
      'it means a fresh deployment converts nothing. EACH DIRECTION IS SEPARATE: ' +
      'a rate is a ratio and "minor units per major unit" collapses one way, so ' +
      'NGN→USD and USD→NGN are two policies. `published_prices` is where an ' +
      'operator sees the one they forgot.',
  },
  {
    name: 'publish gift card rate cards',
    kind: 'action',
    failure: 'refuses-the-first-request',
    flow: 'gift cards',
    ifMissed:
      'worse than FX: the flag can be switched on and the first customer quote ' +
      '404s. Two live bands may not overlap, by EXCLUDE constraint.',
  },
  {
    name: 'set `large_value_minor` in `risk_thresholds`',
    kind: 'action',
    failure: 'wrong-by-default',
    flow: 'transaction monitoring',
    ifMissed:
      'A REGULATORY FIGURE, and the seeded one is a STARTING POINT. It must be ' +
      'what the NFIU currently requires — a programme running on a number ' +
      'somebody copied from a migration is a finding.',
  },
  {
    name: 'review `risk_currency_coverage`',
    kind: 'action',
    failure: 'refuses-to-boot',
    flow: 'transaction monitoring',
    ifMissed:
      'a currency the ledger holds and the rules do not watch. The invariant ' +
      'suite fails on one, because unmonitored has to be a visible state.',
  },
  {
    name: 'replace the bracketed fields in the legal pages',
    kind: 'action',
    failure: 'wrong-by-default',
    ifMissed:
      'SIX placeholders across `terms/page.tsx` and `privacy/page.tsx` — the ' +
      'registered company name (twice), the registered address, the DPO ' +
      'address (twice) and the NDPC registration reference. A privacy notice ' +
      'promising rights in the name of `[registered company name]` is a ' +
      'commitment already being broken, in writing, on the page a regulator ' +
      'reads first.',
  },
  {
    name: 'have the terms reviewed by a Nigerian lawyer',
    kind: 'action',
    failure: 'wrong-by-default',
    ifMissed: 'nothing here is legal advice, and the pages say so.',
  },
  {
    name: 'run a restore drill',
    kind: 'action',
    failure: 'silent',
    ifMissed:
      'AN UNTESTED BACKUP IS A HOPE WITH A CRON ENTRY. `restore-drill.sh` does ' +
      'not stop at "Postgres started" — a truncated copy starts perfectly and ' +
      'is missing a week. It runs `verify-restore.sql`, which asks whether every ' +
      'entry still sums to zero per currency.',
  },
  {
    name: 'confirm the standby is streaming',
    kind: 'action',
    failure: 'silent',
    ifMissed:
      'REPLICATION IS NOT BACKUP and a standby that stopped replicating looks ' +
      'exactly like one that did not, until you need it.',
  },
  {
    name: 'rotate every credential used during testing',
    kind: 'action',
    failure: 'silent',
    ifMissed:
      'a sandbox key pasted into a terminal, a chat window or a CI log is a ' +
      'key somebody else has. Rotation is a person\'s decision and nothing ' +
      'here can detect the need for it.',
  },
];

/** Everything, in the order an operator should work through it. */
export const CHECKLIST: readonly Item[] = [
  ...ENVIRONMENT,
  ...PROVIDERS,
  ...WORKERS,
  ...DEPLOYMENT,
  ...SETTINGS,
  ...CREDENTIALS,
  ...ACTIONS,
];

/** The ones whose absence nothing will ever tell you about. */
export function silentMisses(): readonly Item[] {
  return CHECKLIST.filter((item) => item.failure === 'silent');
}

/** The ones that must go on exactly one instance. */
export function singleInstanceWorkers(): readonly Item[] {
  return CHECKLIST.filter((item) => item.singleInstance === true);
}
