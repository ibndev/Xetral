# Getting this onto an iPhone

Android needs nothing from you — the **Android APK** workflow builds and
publishes one, and you install it. iOS is different, and the difference is
Apple's, not this project's: **every binary that runs on a physical iPhone must
be signed by a paid Apple Developer account.** There is no sideloading
equivalent to an APK.

That gives two routes, and only one of them needs anything from you.

## Route A — the simulator. Free, today, no account

A simulator build is not signed for a device, so Apple requires nothing:

```bash
npx eas build --profile development --platform ios
```

`eas.json`'s `development` profile sets `ios.simulator: true`. The result is a
`.tar.gz` you unpack and drag onto a running simulator.

**It needs a Mac.** The iOS Simulator is macOS-only — there is no Linux or
Windows equivalent, and no CI runner substitutes for it. What it exercises is
every screen, the whole API surface and the navigation. What it *cannot*
exercise is Face ID against real hardware, the Keychain's
`WHEN_UNLOCKED_THIS_DEVICE_ONLY` behaviour, or the app-switcher screenshot the
cover in `screen-privacy.tsx` exists to prevent. Those are the three things
this app most needs a device for, which is why Route B exists.

## Route B — a real iPhone. Needs an Apple Developer account

**What I need from you:**

1. **An Apple Developer Program membership** — $99/year, at
   <https://developer.apple.com/programs/>. Enrolment as an *organisation*
   takes days and needs a D-U-N-S number; as an *individual* it is usually
   same-day. For a fintech that will eventually ship on the App Store, the
   organisation account is the one you want, so start it early — it is the
   longest-lead item here and nothing else is blocked by it.
2. **An Expo account**, free, at <https://expo.dev>. Then `npx eas login`.
3. **The UDID of each iPhone** that will run a build. `eas device:create` walks
   you through registering them; Apple allows 100 per year and removing one
   only frees the slot at renewal, so register the phones you mean to test on.

**Then:**

```bash
npx eas device:create                                  # once per phone
npx eas build --profile device --platform ios          # a signed development build
```

EAS handles the certificate and provisioning profile — you will be asked to
sign in to Apple once and it creates them. The build finishes as a link; open
it on the phone and install.

`distribution: internal` is what makes that link work without TestFlight.
TestFlight is the next step up and needs App Store Connect metadata,
an export-compliance answer, and a review for external testers — worth doing
before a public beta, not before you have seen the app run.

## What each profile in `eas.json` is for

| Profile | Android | iOS | Use |
|---|---|---|---|
| `development` | APK, dev client | **simulator** | Day-to-day, Metro on your machine |
| `device` | APK, dev client | **physical device** | Same, on a real iPhone. Needs the account |
| `preview` | APK | device | Standalone, JS bundled in — hand to a tester |
| `production` | **AAB** | device | Store submission. AAB because Play requires it |

`development` and `device` load JavaScript from Metro, exactly as the Android
development build does. `preview` and `production` carry it inside.

## The one thing to decide before any of this

`EXPO_PUBLIC_API_URL`, or `extra.apiUrl` in `app.json`, has to point at an
address the **phone** can reach over the internet — not the internal Docker
name the web app uses, and not `localhost`. Until the API has a public
hostname, an iOS build will install and open and every request will fail, in
exactly the way the Android preview build currently does.
