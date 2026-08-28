# What the mobile app gets wrong that a server cannot

A read of `apps/mobile` for the risks that are specific to a phone. The API's
guards apply equally to both clients and are not repeated here; what follows is
what changes because the code runs on hardware somebody else can pick up.

**This app has never been run on a device or a simulator from here.** It is
typechecked and configured rather than demonstrated, and everything below is a
reading of the source. Biometrics in particular cannot be exercised without
hardware. The findings are real; the fixes are unproven on a phone.

---

## Fixed

### The app switcher was writing balances to disk

Both platforms photograph the screen when the app leaves the foreground, so the
switcher has something to show, and **the picture goes to disk**. For this app
that picture is a customer's balance and their recent transactions, sitting in a
cache directory that a backup, a forensic tool, or whoever picks the phone up
can read without ever unlocking the app.

`src/screen-privacy.tsx` covers it, and the two platforms need different
answers:

- **Android** is told properly. `preventScreenCaptureAsync()` sets
  `FLAG_SECURE`, which blocks screenshots, blocks screen recording, and makes
  the switcher render a blank card.
- **iOS cannot block a screenshot at all** — there is no API, by Apple's
  deliberate design. What it can control is what is on screen when the snapshot
  is taken, so the UI is covered on `inactive`, which is the state the app
  switcher raises **before** `background`. Listening for `background` covers the
  screen after the picture has been taken, which is the off-by-one the test
  guards.

An opaque cover rather than a blur: a blurred balance is still a picture of the
shape of one, and the number of digits is what somebody glancing at a switcher
would read.

---

## Decisions not to build, with the reasoning

These are the things a mobile security review is expected to raise. Each is a
real control and each is declined for a stated reason, which is a different
thing from not having thought about it.

### Certificate pinning — no

The usual recommendation for a banking app, and the usual outcome is an app
that stops working.

Xetral sits behind Cloudflare, whose certificate rotates on a schedule nobody
here controls. A pin against the leaf breaks the app on every rotation; a pin
against the intermediate breaks it whenever Cloudflare changes CA; and both
failures look identical to a customer — every request fails, on an app that
cannot be fixed without a store release, on the day it happens.

What pinning defends against is a device that already trusts an attacker's CA:
a corporate MITM appliance, or malware with device-administrator rights. On a
device in that state the attacker can also read the screen and log the
keystrokes, so the transaction PIN is already theirs.

**If it is added**, it needs a backup pin, a pin-expiry date, and a
kill-switch — and it needs somebody who will remember it exists in eighteen
months.

### Root and jailbreak detection — no

Every check is a heuristic, every heuristic is defeated by a well-known Frida
module, and the arms race is not one a small team wins. Its honest value is
raising the cost for the least sophisticated attacker.

Where the effort goes instead is on the assumption that the device may be
compromised: the PIN is stored behind the OS's own authentication gate rather
than in application storage, the refresh token is `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
so a restored backup cannot resurrect a session on hardware the customer no
longer owns, and — the part that actually matters — **the server never trusts
the client's word for anything**. There is no endpoint that accepts "the user
passed Face ID" in place of a PIN, so a rooted device cannot ask for one.

### An in-app PIN keypad instead of the system keyboard — no

A custom keypad avoids the OS keyboard entirely, which is the argument for it.
The PIN fields already use `secureTextEntry`, which on both platforms disables
the predictive cache and the suggestion strip for that field, so what a custom
keypad buys is protection against a malicious third-party keyboard — a device
on which the customer has installed one and granted it full access.

That is a real threat and it is the same device state as the root case: on it,
a custom keypad's coordinates are readable too. It is not worth the accessibility
cost, which is paid by every customer rather than by the attacker.

---

## Already right, and worth stating so it is not undone

- **The PIN is stored behind the OS's gate, not in app storage.**
  `requireAuthentication: true` means the Keychain/Keystore refuses to return
  it without a face, a finger or the device passcode — the app never sees
  biometric data, only whether the OS agreed.
- **Biometrics unlock the PIN and do not replace it.** The unlocked PIN is sent
  to the server exactly as if typed, and `002_identity.sql` refuses enrolment
  for a user with no PIN. There is no endpoint anywhere that takes a claim
  about a face.
- **Signing out forgets the stored PIN.** Otherwise a face on that phone still
  unlocks the PIN of an account nobody is signed in to — precisely the case a
  customer handing over their device was guarding against.
- **Tokens are `WHEN_UNLOCKED_THIS_DEVICE_ONLY`**, so they are neither readable
  while the phone is locked nor restorable onto different hardware.
- **The session is a singleton**, because the single-flight refresh latch lives
  on the instance and a screen building its own would replay a refresh token —
  which the server correctly treats as theft and answers by revoking the whole
  device family.
- **Nothing is logged.** There is no `console.log` anywhere in `app/` or
  `src/`, which matters more here than on a server: on Android, logcat has
  historically been readable by other processes and is readable over `adb` by
  anyone with the phone and a cable.
- **Cleartext HTTP is refused except for the one host a debug build was
  compiled for**, and an `https` build adds no exception at all. See
  `plugins/with-lan-cleartext.js`, whose header records that the first version
  of it silently did nothing.

---

## Still open, and needs hardware

- **Run it.** Everything above is a reading. The screen cover in particular is
  a claim about `AppState` transition order that only a device can settle.
  What CI now settles is narrower and was previously not settled at all: the
  app config evaluates and Metro produces a bundle for both platforms. The
  SDK 54 upgrade found two failures that only that step can see — `app.json`
  named a config plugin the package does not ship, and `metro.config.js`
  disabled the module walk that a nested dependency needs — and neither is
  visible to the compiler or to a unit test.
- **Confirm the Android switcher is actually blank** with a release build, not
  a debug one — `FLAG_SECURE` behaviour has differed across OEM launchers.
- **Confirm the iOS cover paints before the snapshot.** If it does not, the
  remaining option is a native `applicationWillResignActive` overlay, which
  needs a config plugin rather than a React component.
