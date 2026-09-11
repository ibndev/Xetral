import { useState } from 'react';
import { Linking, Share, Text, TextInput, View } from 'react-native';
import { formatAmount, nationalPhone, paymentLinkFor } from '@xetral/client';
import type { MomoAccount, XetralClient, XetralCountry } from '@xetral/client';
import { MOMO_NETWORKS } from '@xetral/client';
import { Select } from '@/select';
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
  const account = useLoad(() => client.existingFundingAccount(), [client]);
  /* The linked wallet. Its own load: 063 is a later migration and a deployment
   * without it must show the link form rather than fail the screen. */
  const momo = useLoad(() => client.linkedMomo(), [client]);

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
  /*
   * WHERE AN ACCOUNT NUMBER IS ACTUALLY A PRODUCT — see the web screen.
   * Flutterwave issues dedicated numbers in NGN only, so in Accra and Nairobi
   * Activate could never succeed and answered "try again shortly" about
   * something permanent. Falls back to TRUE while the country list loads.
   */
  const usesVirtualAccount = countries.data === undefined || funding.includes('virtual_account');

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
        {!account.loading && !has && usesVirtualAccount && (
          /*
            EACH PIECE IN ITS OWN ROW, WITH ROOM AROUND IT — the web's
            `.activate`, and the same reason. These were three siblings of a
            Panel whose spacing is set for the fields of a form, so the
            primary action on the screen a customer opens in order to put
            money in sat hard against a line of text either side of it.
          */
          <View style={{ gap: space.lg, marginTop: space.md }}>
            {/*
              NOT "your naira account" — see the web screen. The account is the
              one for the customer's own country.

              AND NOT `h2`, which is what it was. `h2` is 19pt display bold —
              a SECTION HEADING — and this is a statement above a button. The
              web draws the same line as `.activate-lead`: 15px, weight 600.
              Using the heading style made the phone's copy visibly larger than
              the web's on the same screen, which is what "the text under the
              title is too big" was reporting.
            */}
            <Text style={[styles.lead, { marginBottom: 0, fontFamily: font.sansSemi, color: colors.text }]}>
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
          LINKING A MOBILE MONEY WALLET — the web's panel, same reasoning.

          IT ASKED FOR AN AMOUNT, which starts a one-off charge and leaves
          nothing behind. So the Send screen asked for a wallet number again
          every time and nothing on the account recorded which wallet belongs
          to this customer. A linked number both funds and receives, which is
          how a mobile money account works everywhere it is used.

          IT DOES NOT CLAIM TO VERIFY THE HOLDER, and says so on screen. There
          is no name enquiry on this rail — 043 records `name_unavailable` as
          its own refusal — so the number is linked now and confirmed by the
          first payment that arrives from it.
        */}
        {!account.loading && usesMobileMoney && (
          <LinkMomo
            country={here}
            linked={momo.data ?? null}
            busy={busy}
            onDone={() => momo.reload()}
            run={run}
            client={client}
          />
        )}

        <FormError error={account.error} code={account.code} />
      </Panel>

      <RequestPayment />

      {/*
        THE DEPOSIT HISTORY IS NOT HERE. Add Money answers "how do I put money
        in"; what has already arrived is a question about the past, and the
        Activity screen lists every movement with a filter per currency. A
        second, shorter copy here is a list that disagrees with that one the
        moment either grows a rule the other does not have.
      */}
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
          <Text style={styles.muted}>Share to a Xetral user &amp; get paid</Text>
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

/**
 * LINKING A MOBILE MONEY WALLET — the web's component, screen for screen.
 *
 * See `apps/web/src/app/add-money/page.tsx` for why this replaced an amount
 * field: a one-off charge leaves nothing behind, so the Send screen asked for
 * a wallet number again every time and nothing recorded which wallet belongs
 * to this customer.
 */
function LinkMomo({
  country,
  linked,
  busy,
  onDone,
  run,
  client,
}: {
  readonly country: XetralCountry | undefined;
  readonly linked: MomoAccount | null;
  readonly busy: boolean;
  readonly onDone: () => void;
  readonly run: (work: () => Promise<string | undefined>) => void;
  readonly client: XetralClient;
}) {
  const styles = useStyles();
  const colors = useTheme();
  const networks = MOMO_NETWORKS[country?.code ?? ''] ?? [];
  const [network, setNetwork] = useState(networks[0]?.code ?? '');
  const [number, setNumber] = useState('');
  const [pin, setPin] = useState('');

  if (linked !== null) {
    return (
      <View style={{ gap: space.sm, marginTop: space.md }}>
        <Text style={[styles.lead, { marginBottom: 0, fontFamily: font.sansSemi, color: colors.text }]}>
          Your mobile money wallet
        </Text>
        <Text style={styles.amount}>{linked.msisdn}</Text>
        <Text style={styles.hint}>
          {linked.network} ·{' '}
          {linked.status === 'verified'
            ? 'Confirmed — money can be sent to this wallet.'
            : 'Not yet confirmed. It will be, the first time you add money from it.'}
        </Text>

        <Text style={styles.label}>Transaction PIN</Text>
        <TextInput
          style={styles.input}
          value={pin}
          onChangeText={setPin}
          keyboardType="number-pad"
          secureTextEntry
          placeholder="••••"
          placeholderTextColor={colors.text3}
        />
        <Button
          label={busy ? 'Removing…' : 'Remove this wallet'}
          quiet
          busy={busy}
          disabled={pin === ''}
          onPress={() =>
            void run(async () => {
              await client.unlinkMomo(pin);
              setPin('');
              onDone();
              return 'That wallet is no longer linked.';
            })
          }
        />
      </View>
    );
  }

  return (
    /*
      A FORM'S RHYTHM, NOT A PANEL'S. `space.md` between every field is the
      spacing a statement-and-a-button panel wants; with four fields in it,
      most of a handset screen sits empty between "Mobile money number" and
      "Transaction PIN" — which is what was reported. `space.sm` is what the
      other forms in this app use between a label and the next field.
    */
    <View style={{ gap: space.sm, marginTop: space.md }}>
      <Text style={[styles.lead, { marginBottom: 0, fontFamily: font.sansSemi, color: colors.text }]}>
        Link your mobile money{country === undefined ? '' : ` in ${country.name}`}
      </Text>
      <Text style={styles.label}>Network</Text>
      <Select
        label="Network"
        value={network}
        onChange={setNetwork}
        options={networks.map((n) => ({ value: n.code, label: n.name }))}
      />

      {/* THE DIAL CODE IS DRAWN, NOT ASKED FOR — it comes from the country
          already on the account, so there is one place a country is stated.
          The number is normalised to E.164 server-side. */}
      <Text style={styles.label}>Mobile money number</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text style={[styles.amount, { color: colors.text2 }]}>+{country?.dial_code ?? ''}</Text>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={number}
          onChangeText={setNumber}
          keyboardType="number-pad"
          placeholder="0244123456"
          placeholderTextColor={colors.text3}
        />
      </View>

      <Text style={styles.label}>Transaction PIN</Text>
      <TextInput
        style={styles.input}
        value={pin}
        onChangeText={setPin}
        keyboardType="number-pad"
        secureTextEntry
        placeholder="••••"
        placeholderTextColor={colors.text3}
      />

      <Button
        label={busy ? 'Linking…' : 'Link Momo'}
        icon="arrowRight"
        busy={busy}
        disabled={network === '' || number.trim() === '' || pin === ''}
        onPress={() =>
          void run(async () => {
            await client.linkMomo({ network, number: number.trim(), transactionPin: pin });
            setNumber('');
            setPin('');
            onDone();
            return 'Your mobile money wallet is linked.';
          })
        }
      />
    </View>
  );
}
