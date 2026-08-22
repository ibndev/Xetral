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

# Postgres 16, with the migrations applied IN ORDER.
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
         packages/ledger/sql/009_admin.seed.sql; do
  psql -d xetral -v ON_ERROR_STOP=1 -f "$f"
done
```

`009_admin.seed.sql` is not optional. Fees, ceilings, daily limits and the
feature flags are rows in `platform_settings`, and the API treats that table
as authoritative — without it every one of them falls back to a default the
app was not configured with.

Install **Expo Go** on the phone, from the Play Store.

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
