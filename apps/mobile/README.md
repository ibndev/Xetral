# Running the mobile app

**This app does not run in Expo Go, and cannot.** Expo Go ships one SDK version
at a time and contains only the native modules Expo chose — so a project on any
other SDK refuses to open, and one with its own native modules could never work
there at all. What replaces it is a **development build**: this app's own APK,
with `expo-dev-client` inside it, which you install once and then point at a
Metro server exactly the way Expo Go was pointed at one.

You still do **not** need a USB cable. The development build asks for the
address of your machine over the network, and everything after that — fast
refresh, the dev menu, reloading on save — behaves as it always did.

What you do need is the API reachable from the phone, which is the part that
actually catches people out, because a phone cannot reach `localhost`.

## Once, on your laptop

```bash
git clone https://github.com/ibndev/Xetral && cd Xetral
npm install

# Postgres 16, with the migrations applied IN ORDER. This list is the one in
# CLAUDE.md, which is where it is maintained — it had drifted to stopping at
# 019, and a database missing half the schema fails at the first request
# rather than at migration time.
createdb xetral
for f in packages/ledger/sql/001_ledger.sql \
         packages/identity/sql/002_identity.sql \
         packages/ledger/sql/003_cards.sql \
         packages/ledger/sql/004_purchases.sql \
         packages/ledger/sql/005_giftcards.sql \
         packages/ledger/sql/006_funding.sql \
         packages/ledger/sql/007_crypto.sql \
         packages/ledger/sql/008_fx.sql \
         packages/ledger/sql/009_admin.sql \
         packages/ledger/sql/009_admin.seed.sql \
         packages/ledger/sql/010_card_protection.sql \
         packages/ledger/sql/011_ledger_immutability.sql \
         packages/identity/sql/012_notifications.sql \
         packages/identity/sql/013_password_reset.sql \
         packages/identity/sql/014_staff_totp.sql \
         packages/ledger/sql/015_error_events.sql \
         packages/ledger/sql/016_card_reveals.sql \
         packages/ledger/sql/017_transfer_velocity.sql \
         packages/ledger/sql/018_disputes.sql \
         packages/ledger/sql/019_retention.sql \
         packages/ledger/sql/020_balance_reconciliation.sql \
         packages/ledger/sql/021_flow_velocity.sql \
         packages/ledger/sql/023_entry_status.sql \
         packages/ledger/sql/024_sign_in_events.sql \
         packages/ledger/sql/025_bvn_uniqueness.sql \
         packages/ledger/sql/026_provider_credentials.sql \
         packages/ledger/sql/026_provider_credentials.seed.sql \
         packages/ledger/sql/027_risk_signals.sql \
         packages/ledger/sql/027_risk_signals.seed.sql \
         packages/ledger/sql/028_risk_cases.sql \
         packages/ledger/sql/029_kyc_tiers.sql \
         packages/ledger/sql/029_kyc_tiers.seed.sql \
         packages/ledger/sql/030_card_lifecycle.sql \
         packages/ledger/sql/031_card_settlements.sql \
         packages/ledger/sql/032_tax.sql \
         packages/ledger/sql/033_consent.sql \
         packages/ledger/sql/033_consent.seed.sql \
         packages/ledger/sql/034_data_rights.sql \
         packages/ledger/sql/035_price_publication.sql \
         packages/ledger/sql/036_attention.sql \
         packages/ledger/sql/037_provider_health.sql \
         packages/ledger/sql/099_least_privilege.sql; do
  psql -d xetral -v ON_ERROR_STOP=1 -f "$f"
done
```

`009_admin.seed.sql` is not optional. Fees, ceilings, daily limits and the
feature flags are rows in `platform_settings`, and the API treats that table
as authoritative — without it every one of them falls back to a default the
app was not configured with.

## Once, on the phone: the development build

Build it in GitHub → **Actions** → **Android APK** → **Run workflow**, with
`variant` set to **development**. Leave `api_url` empty — the workflow refuses
it for this variant, because a development build's JavaScript is bundled by
Metro on your machine and the address comes from there. About ten minutes.

When it finishes, the run summary links to a **release page**. Open that link
on the phone, tap the `.apk`, and allow the install. Android warns about
anything not from the Play Store; that prompt is normal.

You only repeat this when the NATIVE side changes — a new Expo SDK, a new
package with native code, a change to `app.json`. Editing TypeScript never
needs a rebuild.

> The APK is signed with Android's standard **debug key**, which ships in
> Expo's template. That is deliberate here: the signature is identical on every
> machine and every run, so a new build installs over the old one instead of
> being refused. It is also a publicly known key, so this must never be what
> goes to the Play Store.

## Every time

**1. Find your laptop's address on the network.** This is the step that
matters — `localhost` on the phone means the phone.

```bash
# macOS
ipconfig getifaddr en0
# Linux
hostname -I | awk '{print $1}'
```

Say it prints `192.168.1.20`.

**2. Start the API, bound so the phone can reach it.**

```bash
npm run build --workspace @xetral/api

DATABASE_URL=postgres://localhost/xetral \
ACCESS_TOKEN_KEYS="v1:$(openssl rand -base64 32)" \
ACCESS_TOKEN_CURRENT_VERSION=v1 \
PORT=3100 \
node apps/api/dist/main.js
```

Check it from the phone's browser before going further:
`http://192.168.1.20:3100/v1/auth/session` should show
`{"error":"invalid_token"}`. If it times out, the laptop's firewall is blocking
port 3100 — that, not Expo, is the problem.

**3. Start Metro, pointed at that address.**

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.20:3100 npm start --workspace @xetral/mobile
```

`npm start` runs `expo start --dev-client`, which serves the development build
rather than Expo Go. Open **Xetral** on the phone and either scan the QR code
or type the Metro address into the launcher.

If the phone and laptop are on networks that cannot see each other — guest
Wi-Fi, or a VPN on the laptop — add `--tunnel`, which routes through Expo's
servers and is slower but works from anywhere.

`EXPO_PUBLIC_API_URL` is read **here**, not in the APK build: Metro inlines it
into the bundle it serves, so changing the API address is a matter of
restarting Metro rather than rebuilding anything.

**4. Create an account to sign in with.** There is no sign-up screen yet, so
seed one directly:

```bash
node scripts/seed-demo-user.mjs
```

It prints the email; the password is `a-long-enough-password` and the PIN is
`374915`.

## About biometrics specifically

`expo-secure-store` and `expo-local-authentication` are both bundled in Expo
Go, so **Face ID / fingerprint should work there**. If it does not, the reason
is almost always one of:

- **No fingerprint or face is enrolled on the phone.** The Security screen says
  so rather than showing a switch that throws.
- **`requireAuthentication: true` needs a device credential.** A phone with no
  screen lock at all cannot store the PIN behind a gate, and SecureStore fails
  the write. That is the correct behaviour: storing the PIN with nothing
  guarding it would be worse than not storing it.

This is one of the things a development build settles that Expo Go could not:
Expo Go carries its own copy of these modules, so a failure there was never
conclusively about this app. The development build contains exactly the native
code `app.json` asks for, so what it does is what a shipped build will do.

## What to actually try

1. Sign in.
2. **Wallet** — balances, with pending shown separately from spendable.
3. **Security** — turn on biometric unlock. It asks for your PIN and confirms
   it with the server before storing it.
4. **Send** — the "Send with fingerprint" button appears once enrolled. Watch
   what it does: the OS prompt unlocks your PIN and the app sends that PIN.
   Cancel the prompt and nothing is sent; the PIN field is still there to type
   into. That is the whole design — biometrics unlock the PIN, they do not
   replace it.
5. Sign out, then check the Security screen again. The stored PIN is gone.

---

# The other build: a standalone APK

The development build above needs Metro running. A **preview** build does not —
the JavaScript is inside it, so it installs and runs on its own. That is what
you hand to somebody who is not going to start a dev server.

Both come from the same **Android APK** workflow, which runs in GitHub Actions
because building an Android app needs the Android SDK and the SDK is only
distributed from `dl.google.com` — a host many sandboxed environments cannot
reach at all. A GitHub runner has the whole toolchain already.

| | development | preview |
|---|---|---|
| JavaScript comes from | Metro, on your machine | inside the APK |
| Needs a laptop running | yes | no |
| `api_url` input | refused — Metro decides | required, and baked in |
| Rebuild when TS changes | no | yes |
| What it replaces | Expo Go | a test flight |

The rest of this section is about **preview**.

## 1. Give the phone something to talk to

Do this first. It is the step that decides whether the APK is worth building,
because **the API address is compiled into the bundle** and cannot be changed
afterwards — `EXPO_PUBLIC_API_URL` is inlined by Metro at build time.

The address has to be one the PHONE can reach. `localhost` inside an APK is the
handset itself, and the workflow refuses that input rather than letting you find
out after installing.

Two ways that work:

**A laptop on the same Wi-Fi.** Find its address (`ipconfig getifaddr en0` on a
Mac, `hostname -I` on Linux) and start the API bound to every interface:

```bash
DATABASE_URL=postgres://localhost/xetral \
REDIS_URL=redis://localhost:6379 \
XETRAL_ENVIRONMENT=development \
ACCESS_TOKEN_KEYS="v1:$(openssl rand -base64 32)" \
ACCESS_TOKEN_CURRENT_VERSION=v1 \
PORT=3100 \
node apps/api/dist/main.js
```

There is no `HOST` to set: `app.listen(port)` binds every interface already,
which was checked rather than assumed — the API answers on the machine's LAN
address with nothing else configured.

Then the address is `http://192.168.x.x:3100`. **Open it from the phone's
browser before building**: `/health` should answer `{"status":"ok",...}`. If it
does not, the problem is a firewall on the laptop or a Wi-Fi network that
isolates clients from each other, and no APK will fix either.

**A tunnel**, if the phone is on mobile data or the Wi-Fi isolates clients.
`cloudflared tunnel --url http://localhost:3100` gives an `https://` address
that works anywhere.

> **Why the scheme matters.** Android has refused plaintext HTTP by default
> since Android 9. A release APK built against an `http://` address would
> install, open, render every screen — and fail every request, which looks
> exactly like a broken app. `plugins/with-lan-cleartext.js` adds an exception
> for the ONE host the build was made for, and for nothing else. An `https`
> build gets no exception at all.

## 2. Build it

In GitHub → **Actions** → **Android APK** → **Run workflow**:

| Input | What to put |
|---|---|
| `variant` | `preview` |
| `api_url` | the address from step 1, e.g. `http://192.168.1.20:3100` |
| `publish_release` | leave on, so the phone can download the file directly |

It takes about ten minutes.

## 3. Install it

The run summary links to a **release page**. Open that link on the phone and tap
the `.apk`.

That is a release asset rather than an Actions artifact, and the difference is
the whole reason it exists: an artifact is a **zip behind a login**, so getting
it onto a phone means signing in to GitHub in a mobile browser, downloading an
archive, finding something that will unpack it, and only then installing. A
release asset is the `.apk` itself. The artifact is still uploaded, as the
record and as the fallback.

Android will ask you to allow installs from your browser or files app; that
prompt is normal for anything not from the Play Store, and Play Protect will
warn once.

Both variants share one application id and one signing key, so **installing
either replaces the other** — you cannot have the development build and a
preview build on the phone at the same time.

## What you can exercise, and what you cannot

Working end to end against a local API: **register, sign in, set a transaction
PIN, verify it, biometric enrolment** (on a device with a fingerprint or face
enrolled — not on an emulator), **read balances, transfer between two accounts
you create, transaction history, daily and velocity limits, disputes, KYC
submission, the theme following the device**, and every error path.

Not working without provider credentials, and refusing clearly rather than
crashing: **cards, crypto, FX, bills and eSIMs, and NGN funding**. All of those
call Bitnob, VTpass, Airalo or Twilio, and the routes answer with a specific
code when the provider is unconfigured. Seeing that refusal IS the correct
behaviour to test.

**Email is silent** unless `RESEND_API_KEY` and `NOTIFICATION_FROM` are set, so
password reset will accept the request and send nothing. That is by design — the
endpoint answers 204 for every identifier so it cannot be used to discover who
has an account — but it means you cannot test the reset link without a provider.

To give an account money without a bank rail, post a funding entry directly
through the ledger; `scripts/seed-demo-user.mjs` does this.
