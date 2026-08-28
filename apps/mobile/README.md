# Running the mobile app

You do **not** need a USB cable. Expo serves the app over your Wi-Fi and the
phone scans a QR code. A cable is the fallback for when the network will not
cooperate, not the normal path.

What you do need is the API reachable from the phone — which is the part that
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

Install **Expo Go** on the phone, from the Play Store.

**The app targets Expo SDK 54.** Expo Go ships one SDK version at a time and
refuses a project built for a different one — which is the whole of the "it
will not open on my phone" symptom, and it says so in small type on a screen
nobody reads. If the store's Expo Go is newer than 54, the SDK here is what
has to move; there is no way to make an older project run in a newer Expo Go.

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

**3. Start Expo, pointed at that address.**

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=http://192.168.1.20:3100 npx expo start
```

Scan the QR code with the camera. If the phone and laptop are on networks that
cannot see each other — guest Wi-Fi, or a VPN on the laptop — add `--tunnel`,
which routes through Expo's servers and is slower but works from anywhere.

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

If Expo Go misbehaves on the biometric path specifically, a **development
build** removes the ambiguity — that is the case where the cable is genuinely
useful:

```bash
npx expo run:android    # phone plugged in, USB debugging on
```

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

# Installing a built APK on an Android phone

For testing the app on a phone with no laptop attached to it. The APK is built
by the **Android APK** workflow in GitHub Actions, because building one needs
the Android SDK and the SDK is only distributed from `dl.google.com` — a host
many sandboxed environments cannot reach at all. A GitHub runner has the whole
toolchain already.

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
| `api_url` | the address from step 1, e.g. `http://192.168.1.20:3100` |
| `variant` | `release` — it bundles the JavaScript and runs on its own. `debug` needs a Metro server on your machine. |

It takes about ten minutes.

## 3. Install it

Open the finished run, download the APK from **Artifacts**, and open the file on
the phone. Android will ask you to allow installs from your browser or files
app; that prompt is normal for anything not from the Play Store.

The APK is signed with Android's standard **debug key**, which ships in Expo's
template. That is deliberate for a test build: the signature is identical on
every machine and every run, so a new build installs over the old one instead of
being refused. It is also a publicly known key, so this APK must never be what
goes to the Play Store — a real release needs its own keystore.

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
