# Getting this onto an iPhone, and into the App Store — with no Mac

Every binary that runs on a physical iPhone is signed by a paid Apple Developer
account, and building one needs macOS. **EAS Build is the Mac**: `eas build`
runs from Windows or Linux, uploads the project, and Expo's macOS workers
compile and sign it. Nothing below needs a Mac.

## Once

1. **An Apple Developer Program membership** — $99/year at
   <https://developer.apple.com/programs/>. As an *organisation* it needs a
   D-U-N-S number and takes days; for a fintech shipping to the App Store that
   is the account you want, so start it first. Everything else waits on it.
2. **An Expo account** (free, <https://expo.dev>), then from `apps/mobile`:

   ```bash
   npx eas login
   npx eas init            # writes extra.eas.projectId into app.json — commit it
   ```

   `eas init` is also what push notifications need (see `CLAUDE.md`,
   "Telling customers something").
3. **Credentials.** The first `eas build --platform ios` asks you to sign in to
   Apple and creates the distribution certificate and provisioning profiles
   itself, stored on EAS. There is no keychain to manage and nothing to put in
   this repository.

## Testing on your iPhone

### Quickest: Expo Go

```bash
npm run start:go            # same Wi-Fi as the phone
npm run start:go:tunnel     # phone on mobile data, or a different network
```

Scan the QR code with the Camera app. **Expo Go only runs the one SDK version
it was built for**, and it moves forward with the App Store. When it says the
project is incompatible, that is not something to fix here — use the
development build below, which is this app's own binary and never goes stale.
Expo Go also cannot show the Face ID prompt with our wording, or receive push.

`start:go` used to be plain `expo start`, which — because `expo-dev-client` is
installed — serves a *development build*, so Expo Go was shown a QR code for an
app it does not have. It passes `--go` now.

### The real thing: an internal build

```bash
npx eas device:create       # once per iPhone — registers its UDID with Apple
npm run build:ios:device    # development build: your phone + `npm start` on your PC
npm run build:ios:internal  # standalone build: the JavaScript is inside
```

`distribution: internal` is **ad hoc** provisioning: the build finishes as a
link, you open it on a registered iPhone, and it installs — no TestFlight, no
review. Apple allows 100 devices a year; removing one frees the slot only at
renewal, so register the phones you mean to test on. A phone registered after
a build needs a new build.

## Submitting to the App Store

```bash
npm run build:ios           # production profile, then uploads to App Store Connect
```

`--auto-submit` runs `eas submit` after the build. The first time, it asks for
your Apple ID and offers to create the app record in App Store Connect; after
that it goes to **TestFlight**, and you release it to review from App Store
Connect. `npm run submit:ios` re-uploads a finished build on its own.

Build numbers are counted on EAS (`appVersionSource: remote`,
`autoIncrement`), so two uploads can never share one — Apple refuses a repeat.

**Two questions App Store Connect asks that only you can answer:**

- **Export compliance.** Every build shows "Missing Compliance" until it is
  answered. The app uses HTTPS and the iOS Keychain only; if you are
  satisfied that is exempt, set `ios.config.usesNonExemptEncryption: false`
  in `app.json` and it stops asking. It is a legal declaration, so it is
  yours to make, not a default in this file.
- **App Privacy.** The data types collected — name, email, phone, financial
  info, identifiers — must match what `/legal/privacy` says.

## Which profile is which

| Profile | iOS | Use |
|---|---|---|
| `development` | simulator | Needs a Mac to run. Not for you |
| `device` | iPhone, dev client | Replaces Expo Go; loads JS from `npm start` |
| `ios-internal` | iPhone, standalone | Hand to a tester. Registered devices only |
| `preview` | iPhone, standalone | The same on iOS; also builds the Android APK |
| `production` | App Store | TestFlight, then review |

## Before any of it

`extra.apiUrl` in `app.json` is `https://app.xetral.com/api/x`, and it is
compiled in — see `api-url.test.ts`. A standalone build pointed anywhere else
installs, opens and fails every request.
