# Play Console — Data safety

What to tick, and why each answer is what it is.

**This is derived from the send path, not from a template.** Google's Data
safety form is a declaration, and a wrong one is enforceable against the
listing — an app removed for a mismatched declaration is removed for the
declaration, not for the behaviour. So every row below names the code that
makes it true, and the honest answer to several of them is "no", which a
generic fintech form would never have produced.

Last checked against `main` on 19 September 2026.

---

## The two answers most fintech apps get wrong, and ours

**There is no analytics SDK, no advertising SDK and no crash reporter in this
app.** `apps/mobile/package.json` has eighteen dependencies and every one is an
`expo-*` or `react-native-*` module with a named purpose. Nothing measures what
a customer does, nothing reports a crash to a third party, and there is no
advertising identifier. So the whole *App activity* section and the whole
*App info and performance* section are **not collected** — which is unusual
enough that a reviewer may look, and it will hold up.

**No identity document is collected.** `kyc_submissions` in `009_admin.sql` has
`full_name`, `date_of_birth`, `phone`, `address` and a sealed BVN — typed
fields. There is no upload column, no camera use and no file picker anywhere in
the app. *Photos and videos* and *Files and docs* are **not collected**.

---

## Data types

`Collected` means it reaches our servers. `Shared` means it reaches a third
party — Google counts a processor acting on our instructions as sharing when
the data physically leaves, so the processor table in the privacy notice is the
source for this column.

### Personal info

| Type | Collected | Shared | Required | Purposes | Why |
|---|---|---|---|---|---|
| Name | Yes | **Yes** | Required | Account management, App functionality, Fraud prevention and compliance | Sent to Paystack to open a naira account number; sent to Flutterwave as the named sender on a Kenyan M-PESA payout, which cross-border rules require |
| Email address | Yes | **Yes** | Required | Account management, App functionality | Sent to Brevo to deliver receipts, security alerts and reset codes; sent to Paystack when a customer opens an account number |
| User IDs | Yes | **Yes** | Required | Account management, App functionality | Bitnob receives an opaque reference that identifies the customer in their system only |
| Address | Yes | No | Required | Fraud prevention and compliance | Collected for identity verification and reviewed by our own staff. No provider receives it |
| Phone number | Yes | **Yes** | Required | Account management, App functionality, Fraud prevention and compliance | The Xetral-to-Xetral identifier. Sent to Paystack with the account opening; sent to Flutterwave in M-PESA sender metadata |
| Other info — date of birth, Bank Verification Number | Yes | No | Required | Fraud prevention and compliance | Required by Nigerian AML rules. The BVN is sealed with a key-versioned envelope and **no provider is ever sent it** — Paystack's `/customer/:code/identification`, the endpoint a BVN would go to, is declared in the endpoint table and called from nowhere |

Race, ethnicity, political or religious beliefs, sexual orientation: **not
collected.** Nothing in the schema could hold them.

### Financial info

| Type | Collected | Shared | Required | Purposes | Why |
|---|---|---|---|---|---|
| User payment info | Yes | **Yes** | Required | App functionality | The destination account or wallet number of a payout goes to the rail that sends it — Paystack, Flutterwave or Bitnob. The number being topped up goes to VTpass |
| Purchase history | Yes | No | Required | App functionality, Fraud prevention and compliance | The ledger. It is the record of what we owe a customer, and it is not shared as a history — each provider is told only about the one instruction it is carrying out |
| Other financial info — balances | Yes | No | Required | App functionality | Held in our own ledger |
| Credit score | No | — | — | — | Nothing here computes or requests one |

**Payment card numbers are not collected.** `003_cards.sql` has no column that
could hold one. A card reveal fetches the number from the issuer, returns it to
a customer who proved a PIN, and drops it; `card_reveals` records that it
happened and never what it showed.

### Device or other IDs

| Type | Collected | Shared | Required | Purposes | Why |
|---|---|---|---|---|---|
| Device or other IDs | Yes | **Yes** | **Optional** | App functionality | The Expo push token, sent to Expo's push service to deliver a notification. Optional because notifications are — declining the permission collects nothing. A device identifier is also recorded per sign-in so a customer can see and revoke their own sessions; that one is not shared |

### App activity, App info and performance, and everything else

| Section | Answer |
|---|---|
| App interactions, in-app search history, installed apps, other user-generated content | **Not collected** — no analytics SDK |
| Web browsing history | **Not collected** |
| Crash logs, diagnostics, other app performance data | **Not collected** — no crash reporter. Server-side error records store a route *pattern* and a fault fingerprint, deliberately never a customer id, so they are not user data |
| Photos and videos, files and docs, audio | **Not collected** |
| Messages — emails, SMS, in-app | **Not collected**. We *send* email; we never read a customer's mail |
| Contacts | **Not collected**. Saved recipients are typed in by the customer, not read from the address book |
| Location | **Not collected**. Cloudflare's `CF-IPCountry` gives a country for a sign-in alert. It is a country, not a location, and it is not derived from GPS or from the device |
| Health and fitness, Calendar | **Not collected** |

---

## Security practices

| Question | Answer | Evidence |
|---|---|---|
| Is data encrypted in transit? | **Yes** | HTTPS everywhere; HSTS on the API as well as the web app, because the phone talks to the API origin directly |
| Can users request that data be deleted? | **Yes** | `Settings → Your data → Ask us to erase it` in the app, and `hello@xetral.com`. A person decides and names what was deleted and what law requires us to keep |
| Have you committed to Google Play's Families policy? | Not applicable | Over-18 only, enforced by identity verification |
| Independent security review | Not yet | Declare only when one has been done |

### Account deletion URL

Google requires a **web** route as well as the in-app one, reachable without
installing the app:

```
https://app.xetral.com/legal/privacy#deleting-your-account
```

The *Deleting your account* section names both routes, says what is deleted and
what is kept, and says why — the five-year AML retention, and the email
tombstone that stops the same address quietly opening a second account.

---

## One thing to settle before submitting

**The APK ships nine permissions the app's own manifest never asks for**, and
they are merged in from library manifests at build time:

```
ACCESS_NETWORK_STATE   BIND_JOB_SERVICE   DETECT_SCREEN_CAPTURE
DUMP                   POST_NOTIFICATIONS READ_APP_BADGE
READ_MEDIA_IMAGES      RECEIVE_BOOT_COMPLETED   WAKE_LOCK
```

`assert-permissions.sh` reads `android/app/src/main/AndroidManifest.xml` — the
app's **source** manifest — so it cannot see any of them. That is the same
shape of gap the AAB signing check exists to close: interrogate the artifact,
not the configuration that produced it. The check should run against the
**merged** manifest after the build, and each of these decided.

Most are innocuous and expected for a notification-capable app.
**`READ_MEDIA_IMAGES` is the one worth a decision** before the first upload: it
arrives with `expo-notifications` for notification images, this app sends none,
and it is a permission a reviewer and a customer both read as "this app can see
my photos". Blocking it in `app.json` costs nothing this app uses.

Until it is decided, the Data safety answer is unaffected — no image is ever
read — but the install screen says otherwise, and that is a gap worth closing
rather than explaining.
