#!/usr/bin/env bash
#
# WHAT THE GENERATED MANIFEST ASKS FOR, asserted in both directions.
#
# ONE SCRIPT, CALLED BY BOTH WORKFLOWS, AND THE SECOND COPY IS WHY.
# `mobile-apk.yml` had this check written out and `mobile-aab.yml` had a
# hand-written second version of "the same" check. It was not the same: it
# grepped for the permission NAME and failed on finding one.
#
# `android.blockedPermissions` DOES NOT DELETE THE LINE. It rewrites it as
#
#     <uses-permission android:name="…SYSTEM_ALERT_WINDOW" tools:node="remove"/>
#
# and the manifest merger strips it at BUILD time. So the name is still in the
# file, which is correct, and the AAB workflow reported all three as failures
# on a build that was doing exactly the right thing — on its first ever run,
# against a bundle nobody could then upload.
#
# The same argument the fulfilment port makes about three hand-written contract
# suites, and the two rate-limit backends about two: copies drift into testing
# different things while both look green. This is the one place the rule lives.
#
# AND IT WAS READING THE WRONG FILE, WHICH IS THE LARGER HALF.
# `android/app/src/main/AndroidManifest.xml` is the app's OWN manifest — seven
# permissions. The APK ships THIRTEEN. The other nine are merged in from the
# manifests of the native modules, at build time, and this script could not see
# one of them: `READ_MEDIA_IMAGES` arrived with `expo-notifications`, and a
# banking app that can read your photos is the first line a Play reviewer and a
# customer both read on the install screen.
#
# So it runs TWICE: once on the source manifest, where a blocked permission is
# still a line marked `tools:node="remove"`, and once on the MERGED manifest
# after the build, where the merger has stripped those lines and added
# everybody else's. That is the AAB signing check's own rule — interrogate the
# artifact, not the configuration that produced it — applied to the thing a
# customer is actually shown.
set -euo pipefail

# `--merged` rather than a path, because WHERE the merger writes its output
# moves with the Android Gradle plugin, and two workflows each carrying their
# own `find` is the second copy this script exists to be instead of.
if [ "${1:-}" = '--merged' ]; then
  manifest=$(find apps/mobile/android/app/build/intermediates/merged_manifests \
             -name AndroidManifest.xml 2>/dev/null | head -1)
  if [ -z "$manifest" ]; then
    # NOT A PASS. A check that silently does nothing when it cannot find its
    # input is the reconciliation check that reported through a SELECT and
    # exited zero — and this is the run where the permission list is decided.
    echo "::error::no merged manifest under android/app/build/intermediates."
    echo "          It is written by the build, so this step must run AFTER"
    echo "          gradle. If the AGP output path moved, fix it here once."
    exit 1
  fi
else
  manifest=${1:-apps/mobile/android/app/src/main/AndroidManifest.xml}
fi

if [ ! -f "$manifest" ]; then
  echo "::error::no manifest at $manifest — did prebuild run?"
  exit 1
fi
echo "reading $manifest"

fail=0

# Expo's android TEMPLATE ships these three, and no package in this repo asks
# for any of them — so no diff ever showed them. "Display over other apps" on a
# banking app is a permission a customer can see and reasonably refuse to
# install over.
#
# READ_MEDIA_IMAGES is the fourth and it arrived differently: not from the
# template but from `expo-notifications`, which wants it to put a picture in a
# notification. This app sends none. Blocking it costs nothing this app uses
# and removes a line that reads, correctly, as "this app can see my photos".
for perm in SYSTEM_ALERT_WINDOW READ_EXTERNAL_STORAGE WRITE_EXTERNAL_STORAGE \
            READ_MEDIA_IMAGES; do
  line=$(grep "permission.$perm" "$manifest" || true)
  if [ -z "$line" ]; then
    echo "ok: $perm is absent"
  elif echo "$line" | grep -q 'tools:node="remove"'; then
    echo "ok: $perm is marked for removal"
  else
    echo "::error::$perm would ship and nothing uses it"
    fail=1
  fi
done

# THE OTHER DIRECTION, and it is the half a name-only grep cannot do. A typo in
# `blockedPermissions` marks something the app NEEDS for removal — the line is
# still present, so "is it in the file?" says yes — and the result presents as
# "Face ID does not work on Android".
for perm in INTERNET USE_BIOMETRIC; do
  if grep "permission.$perm" "$manifest" | grep -q 'tools:node="remove"'; then
    echo "::error::$perm is blocked, and the app needs it"
    fail=1
  elif grep -q "permission.$perm" "$manifest"; then
    echo "ok: $perm is requested"
  else
    echo "::error::$perm is missing from the manifest"
    fail=1
  fi
done


# AND THE THIRD DIRECTION: NOTHING THE APP DID NOT ASK FOR.
#
# The two loops above name permissions somebody already thought of, which is
# exactly the gap 036 records about `admin_work_queue` — an incomplete list
# that looks complete is trusted. Adding `expo-notifications` pulled VIBRATE
# into the manifest, and no check anywhere would have said so; the next module
# could pull in something a customer reads on the install screen and refuses
# over.
#
# So every permission is compared against a list, and one that is not on it
# fails the build. The fix when that happens is to decide — add it here with a
# reason, or block it in `app.json` — which is the point.
#
# The second group is what the MERGED manifest adds, and every one of them
# shipped in an APK before anything here had an opinion about it:
#
#   ACCESS_NETWORK_STATE     react-native, to tell an offline failure from a
#                            server one rather than retrying into nothing
#   POST_NOTIFICATIONS       expo-notifications; Android 13+ asks the customer
#   RECEIVE_BOOT_COMPLETED   expo-notifications, to survive a restart
#   WAKE_LOCK                expo-notifications, to wake the screen for one
#   BIND_JOB_SERVICE         the scheduler expo-notifications uses
#   READ_APP_BADGE           the unread count on the launcher icon
#   DETECT_SCREEN_CAPTURE    expo-screen-capture — the module that stops the
#                            app switcher photographing a balance
#   DUMP                     react-native's debug tooling. Signature-level, so
#                            Android never grants it to an app like this one
#
# Listed rather than tolerated: a module added later that pulls in something
# else fails the build, and the fix is to decide — a reason here, or a line in
# `app.json`. That is 036's argument about `admin_work_queue`, in a manifest.
known="INTERNET USE_BIOMETRIC USE_FINGERPRINT VIBRATE \
       SYSTEM_ALERT_WINDOW READ_EXTERNAL_STORAGE WRITE_EXTERNAL_STORAGE \
       READ_MEDIA_IMAGES \
       ACCESS_NETWORK_STATE POST_NOTIFICATIONS RECEIVE_BOOT_COMPLETED \
       WAKE_LOCK BIND_JOB_SERVICE READ_APP_BADGE DETECT_SCREEN_CAPTURE DUMP"

for perm in $(grep -o 'android:name="android.permission.[A-Z_]*"' "$manifest" \
              | sed 's/.*permission\.//; s/"//' | sort -u); do
  case " $known " in
    *" $perm "*) ;;
    *)
      echo "::error::$perm is in the manifest and nothing here decided it should be."
      echo "          A native module pulled it in. Either add it to \$known in"
      echo "          this script with a reason, or block it in app.json."
      fail=1
      ;;
  esac
done

exit $fail
