import { useState } from 'react';
import { Linking, Share, Text, TextInput, View } from 'react-native';
import { formatAmount, nationalPhone, paymentLinkFor } from '@xetral/client';
import type { Deposit } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, FormError, Loading, Panel } from '@/ui';
import { useLoad, useSubmit, useXetral } from '@/hooks';
import { webOrigin } from '@/session';
import { font, radius, space, useStyles, useTheme } from '@/theme';

/**
 * Adding money, and WHAT IS AND IS NOT GATED ON VERIFICATION.
 *
 * This screen used to be a wall: unverified, it returned `VerifyPrompt` and
 * NOTHING ELSE — on the screen somebody opens in order to put money in. It
 * read as "you may not deposit until you verify", which is not true and is the
 * worst thing it could have said.
 *
 * WHAT IS ACTUALLY TRUE: an unverified account may hold and move ₦50,000 a
 * day. That is tier 0 in `029_kyc_tiers.seed.sql`, it has been the policy
 * since that migration landed, and nothing showed it to anybody. It is now the
 * first thing on the page, read from `/v1/kyc/limits` so it is the customer's
 * real ceiling rather than a number typed into a screen.
 *
 * WHAT GENUINELY IS GATED: a dedicated Nigerian account number is a BANK
 * ACCOUNT ISSUED IN A PERSON'S NAME. The provider will not create one without
 * a registered customer and Nigerian regulation does not permit an
 * unidentified one — the same `provider_customers` mapping that gates cards.
 * That is a fact about the rail rather than a policy this screen chose, so it
 * names the one thing that needs verifying and why.
 *
 * The deposit history is shown either way: a customer whose transfer has not
 * arrived needs it more than a verified one does.
 *
 * Idempotent by construction on the server — one live account per customer per
 * currency, so opening this repeatedly returns the SAME number rather than
 * issuing another. That matters: a customer saves it as a bank beneficiary and
 * pays into it for years, so a second one would silently split their deposits.
 */
export default function AddMoney() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { busy, error: issueError, code: issueCode, run } = useSubmit();

  /*
   * READ, don't issue — the same correction as the web's. This called
   * `fundingAccount()`, which asks Bitnob and opens a bank account, merely to
   * display a number: every visit to this screen opened an account as a side
   * effect of being looked at, and it was survivable only because issuing is
   * idempotent. Opening one is a BUTTON now, which is what it is.
   */
  const [topUp, setTopUp] = useState('');
  const account = useLoad(() => client.existingFundingAccount(), [client]);
  const deposits = useLoad<readonly Deposit[]>(() => client.deposits(), [client]);

  /*
   * WHAT SOMEBODY HERE CAN ACTUALLY FUND WITH — data, not a `switch`.
   *
   * This screen offered one thing: Activate account, which issues a Nigerian
   * NUBAN. So a customer in Accra opened the page they go to in order to put
   * money in and was offered a bank account they cannot pay into. 051 puts
   * the answer on the country row, and it is an ARRAY because a country can
   * have both — the day Paystack issues dedicated accounts in Ghana an
   * operator adds one entry and this screen offers it on the next load.
   *
   * Falls back to NOTHING rather than to a NUBAN. Offering nothing for a
   * moment is a blank space; offering the wrong rail is a customer sending
   * money into the void.
   */
  const session = useLoad(() => client.currentSession(), [client]);
  const countries = useLoad(() => client.session.countries(), [client]);
  const here = countries.data?.find((c) => c.code === session.data?.country);
  const funding = here?.funding_methods ?? [];
  /*
   * THE ACTIVATE BUTTON IS OFFERED EVERYWHERE NOW — the web's decision, and
   * the same reason. It was gated on `virtual_account`, so a customer in Ghana
   * was never offered an account at all. What the gate protected against is a
   * button that fails; what it caused is a screen that cannot even try. A
   * refusal from the provider is RELAYED with its own reason, which an
   * operator can act on, where a hidden button is a silence nobody can.
   */
  const usesMobileMoney = funding.includes('mobile_money');

  const has = account.data != null;

  return (
    <Shell back="/wallet" title="Add Money">
      <Panel title="Add Money">
        {account.loading && <Loading />}

        {account.data != null && (
          <>
            <View
              style={{
                marginTop: space.sm,
                padding: space.md,
                borderRadius: radius.md,
                backgroundColor: colors.surface2,
                gap: 4,
              }}
            >
              {/*
                THE NAME ON TOP, INSIDE THE SAME BOX AS THE NUMBER.

                It was a line of prose UNDER the box, which splits the three
                things a customer copies into their banking app across two
                containers and puts the one they are asked for FIRST last. A
                beneficiary is a name, a bank and a number, read together.
              */}
              <Text style={styles.muted} selectable>
                {account.data.account_name}
              </Text>
              <Text style={[styles.amount, { fontSize: 22 }]} selectable>
                {account.data.account_number}
              </Text>
              <Text style={styles.muted}>{account.data.bank_name}</Text>
            </View>

            <Text style={styles.hint}>Transfer money to fund your wallet</Text>

            {account.data.status !== 'active' && (
              <Text style={styles.hint}>
                Your account is still being activated. It will start accepting transfers
                shortly.
              </Text>
            )}
          </>
        )}

        {/*
          NO ACCOUNT YET — one button, and NO VERIFICATION GATE IN FRONT OF IT.

          This sent an unverified customer to /kyc first, on the reasoning
          that "regulation does not permit an unidentified account". That is a
          statement about BITNOB, which will not issue one without a verified
          BVN. CBN's tiered KYC permits a tier 1 account on a name and a phone
          number, capped — and `029_kyc_tiers.seed.sql` has capped tier 0 at
          ₦50,000 a day since it landed, so the platform enforced the ceiling
          and refused the account it is for.

          The requirement now lives in the Bitnob adapter, where it is true.
          The default rail opens an account from what signup already holds.
        */}
        {!account.loading && !has && (
          /*
            EACH PIECE IN ITS OWN ROW, WITH ROOM AROUND IT — the web's
            `.activate`, and the same reason. These were three siblings of a
            Panel whose spacing is set for the fields of a form, so the
            primary action on the screen a customer opens in order to put
            money in sat hard against a line of text either side of it.
          */
          <View style={{ gap: space.lg, marginTop: space.md }}>
            {/* NOT "your naira account" — see the web screen. The account is
                the one for the customer's own country. */}
            <Text style={[styles.h2, { marginBottom: 0 }]}>
              Your account is ready. Get it below.
            </Text>
            <Button
              label={busy ? 'Activating…' : 'Activate Account'}
              icon="arrowRight"
              busy={busy}
              onPress={() =>
                void run(async () => {
                  await client.fundingAccount();
                  account.reload();
                  return 'Your account is open.';
                })
              }
            />
            <FormError error={issueError} code={issueCode} />
          </View>
        )}

        {/*
          MOBILE MONEY, AS A TOP-UP THAT ACTUALLY MOVES MONEY — the web's,
          and the same reasoning.

          THIS SCREEN USED TO LIST THREE THINGS AND OFFER NONE OF THEM. It
          said money reaches your wallet "these ways today" and then named
          another Xetral customer, a payment link and crypto — three routes
          that are all somebody ELSE paying you. A customer who opened Add
          Money in order to put their OWN money in was given a reading list.

          What was missing was not a button, it was a rail: Paystack's mobile
          money is a CHARGE CHANNEL rather than an account we can issue, so
          there was nothing to "link". A charge is what the payment link
          already is, so this is the same checkout with the customer as their
          own payer.

          THE MOMO NUMBER IS TYPED ON PAYSTACK'S PAGE, not here. They ask for
          it, send the prompt to the handset and confirm it; asking on this
          screen would be collecting a credential we cannot verify.
        */}
        {!account.loading && usesMobileMoney && (
          <View style={{ gap: space.md, marginTop: space.md }}>
            <Text style={[styles.h2, { marginBottom: 0 }]}>
              Top up from mobile money{here === undefined ? '' : ` in ${here.name}`}
            </Text>

            <Text style={styles.label}>Amount ({here?.currency ?? ''})</Text>
            <TextInput
              style={styles.input}
              value={topUp}
              onChangeText={setTopUp}
              // `decimal-pad`, and the value stays TEXT: money is a string on
              // this platform from end to end.
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.text3}
            />

            <Button
              label={busy ? 'Opening…' : 'Continue'}
              icon="arrowRight"
              busy={busy}
              disabled={topUp.trim() === ''}
              onPress={() =>
                void run(async () => {
                  const { authorization_url } = await client.topUp(topUp.trim());
                  // Paystack's own page, in the system browser. It renders
                  // mobile money, bank and card for this country, which is why
                  // no payment detail passes through the app.
                  await Linking.openURL(authorization_url);
                  return undefined;
                })
              }
            />

          </View>
        )}

        <FormError error={account.error} code={account.code} />
      </Panel>

      <RequestPayment />

      {/*
        MONEY RECEIVED, ONLY WHEN THERE IS SOME. It was a second panel with an
        empty state on a screen whose job is to get money IN, so the commonest
        view was two boxes with one of them saying nothing. The history is not
        clutter — a customer whose transfer has not arrived needs it more than
        anybody — so it is removed exactly when it has nothing to say.
      */}
      {(deposits.data?.length ?? 0) > 0 && (
        <Panel title="Money received">
          {(deposits.data ?? []).map((d) => (
            <View
              key={d.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: space.sm,
                paddingVertical: space.sm,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontFamily: font.sansSemi }}>
                  {d.sender_name ?? 'Bank transfer'}
                </Text>
                <Text style={styles.muted}>{new Date(d.created_at).toLocaleString()}</Text>
              </View>
              <Text style={styles.amount}>{formatAmount(d.amount, d.currency)}</Text>
            </View>
          ))}

          <FormError error={deposits.error} code={deposits.code} />
        </Panel>
      )}
    </Shell>
  );
}

/**
 * REQUEST PAYMENT — its own section, under the account, on the screen whose
 * whole subject is money arriving.
 *
 * It was on the settings screen, filed under the account beside the
 * transaction PIN, which is where somebody goes to CHANGE something rather
 * than where they go when they need to be paid.
 *
 * SHARE RATHER THAN COPY, on the phone. A clipboard copy is the web's answer
 * because a browser has nowhere to send a link; a handset has a share sheet
 * that puts it straight into the message somebody was about to type, which is
 * where these actually go. The value is on screen and selectable either way,
 * because a Copy button beside an em dash is a button that copies nothing.
 */
function RequestPayment() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const profile = useLoad(() => client.profile(), [client]);
  // Their own dialling code, so it can come OFF the number.
  const session = useLoad(() => client.currentSession(), [client]);
  const countries = useLoad(() => client.session.countries(), [client]);
  const here = countries.data?.find((c) => c.code === session.data?.country);

  const phone = profile.data?.phone ?? null;
  const local = nationalPhone(phone, here?.dial_code);
  /*
   * THE ORIGIN THIS BUILD ALREADY TALKS TO, as the fallback for a link the API
   * could not build.
   *
   * With `APP_BASE_URL` unset the server returns no link, and this panel used
   * to print "No link yet — this deployment has no public address set." to a
   * customer, on the screen they opened in order to ASK TO BE PAID. That is an
   * operator's problem rendered where a customer is standing, and the address
   * was already compiled into the app. Configuration still WINS when it is
   * set: an operator naming a canonical origin has said which one a shared
   * link should carry.
   */
  const slug = profile.data?.slug ?? null;
  const link =
    profile.data?.link ??
    (slug !== null && webOrigin() !== '' ? paymentLinkFor(webOrigin(), slug) : null);

  const box = {
    marginTop: space.xs,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
  } as const;

  return (
    <Panel title="Request payment">
      {profile.loading && <Loading />}

      {profile.data !== undefined && (
        <>
          <Text style={styles.muted}>My Xetral-to-Xetral number</Text>
          {/* THE LOCAL NUMBER, WITHOUT THE COUNTRY CODE. This one is for
              another XETRAL customer, and the Send screen puts a dialling-code
              picker in front of its phone field — the sender picks the country
              and types the national digits. So the national form is exactly
              what gets typed in, and a country code beside it is a prefix
              somebody would type twice. What is shared is what is shown. */}
          <View style={box}>
            <Text style={[styles.amount, { fontSize: 18 }]} selectable>
              {local || 'Not set'}
            </Text>
          </View>
          <Button
            label="Copy my number"
            icon="copy"
            quiet
            disabled={local === ''}
            onPress={() => {
              if (local === '') return;
              // Silent on failure: a dismissed share sheet rejects on iOS,
              // which is somebody changing their mind rather than an error.
              void Share.share({ message: local }).catch(() => undefined);
            }}
          />

          <Text style={[styles.muted, { marginTop: space.sm }]}>
            Share your link to accept payment globally.
          </Text>
          <View style={box}>
            <Text style={[styles.amount, { fontSize: 14 }]} selectable>
              {link ?? 'Not set'}
            </Text>
          </View>
          <Button
            label="Copy payment link"
            icon="copy"
            quiet
            disabled={link === null}
            onPress={() => {
              if (link === null) return;
              void Share.share({ message: link }).catch(() => undefined);
            }}
          />
        </>
      )}

      <FormError error={profile.error} code={profile.code} />
    </Panel>
  );
}
