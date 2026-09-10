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
set -euo pipefail

manifest=${1:-apps/mobile/android/app/src/main/AndroidManifest.xml}
if [ ! -f "$manifest" ]; then
  echo "::error::no manifest at $manifest — did prebuild run?"
  exit 1
fi

fail=0

# Expo's android TEMPLATE ships these three, and no package in this repo asks
# for any of them — so no diff ever showed them. "Display over other apps" on a
# banking app is a permission a customer can see and reasonably refuse to
# install over.
for perm in SYSTEM_ALERT_WINDOW READ_EXTERNAL_STORAGE WRITE_EXTERNAL_STORAGE; do
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
known="INTERNET USE_BIOMETRIC USE_FINGERPRINT VIBRATE \
       SYSTEM_ALERT_WINDOW READ_EXTERNAL_STORAGE WRITE_EXTERNAL_STORAGE"

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
