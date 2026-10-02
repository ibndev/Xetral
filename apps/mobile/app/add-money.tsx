import { useEffect, useRef, useState } from 'react';
import { Linking, Share, Text, TextInput, View } from 'react-native';
import {
  codeOf,
  exponentFor,
  formatAmount,
  isValidAmount,
  nationalPhone,
  paymentLinkFor,
} from '@xetral/client';
import type { MomoAccount, XetralClient, XetralCountry } from '@xetral/client';
import { MOMO_NETWORKS } from '@xetral/client';
import { Select } from '@/select';
import { Shell } from '@/shell';
import { AcctCard } from '@/acct-card';
import { AmountCard, Button, CurrencyPill, Done, FormError, Loading, Panel, Segmented } from '@/ui';
import { Icon } from '@/icon';
import { useLoad, useSubmit, useXetral } from '@/hooks';
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
  const { busy, error: issueError, code: issueCode, done: linked, run } = useSubmit();
  // Its own, as on the web: the account's refusal and the wallet form's are
  // different sentences about different things.
  const opener = useSubmit();

  /*
   * READ, don't issue — the same correction as the web's. This called
   * `fundingAccount()`, which asks Bitnob and opens a bank account, merely to
   * display a number: every visit to this screen opened an account as a side
   * effect of being looked at, and it was survivable only because issuing is
   * idempotent. It became a button, and then the button went too — see the
   * effect below, which is the web's.
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
  /* THE BUTTON IS OFFERED WHEREVER THE PLATFORM OPERATES, and the rail
     answers — see the web screen's comment. Gating it on `funding_methods`
     made the control depend on a MIGRATION rather than on the provider, so a
     deployment behind 072 showed no button at all with nothing saying why. */
  const usesVirtualAccount = true;

  const has = account.data != null;

  /* NO ACCOUNT YET, SO OPEN IT — no button and no verification asked; the
     web's effect and its reasoning. Registration opens it; this catches
     anybody who reached the screen without one, once per visit. */
  const [opening, setOpening] = useState<'idle' | 'opening' | 'done'>('idle');
  useEffect(() => {
    if (account.loading || account.data != null || account.error !== undefined) return;
    if (opening !== 'idle') return;
    setOpening('opening');
    void opener.run(async () => {
      try {
        await client.fundingAccount();
        account.reload();
        return undefined;
      } finally {
        setOpening('done');
      }
    });
  }, [account, client, opening, opener]);

  return (
    <Shell back="/wallet" title="Add Money">
      <Panel title="Add Money">
        {account.loading && <Loading />}

        {account.data != null && (
          <>
            {/*
              THE COMP'S ACCOUNT CARD, with a Copy button it did not have.

              The number was in the same muted box a balance uses, with no way
              to copy it — so the one string on this screen a customer has to
              get into their banking app was the one thing they had to retype
              by hand. A beneficiary is a NAME, a bank and a number, and they
              are read together, so all three sit in one panel.
            */}
            <AcctCard
              eyebrow={`Your Xetral ${account.data.currency} account`}
              value={account.data.account_number}
              share={account.data.account_number}
              sub={
                `${account.data.bank_name} · ${account.data.account_name} — transfers` +
                (account.data.status === 'active'
                  ? ' reflect instantly'
                  : ' will start arriving once it finishes activating')
              }
            />
          </>
        )}

        {/*
          NO ACCOUNT YET — AND NOTHING TO PRESS. It was an Activate Account
          button, and before that a gate to /kyc; both asked the customer to do
          our work. What is left is that it is happening, or why it did not.
          The lead is `styles.lead` at weight 600 — the web's `.activate-lead`,
          not the 19pt section heading that once made the phone's copy larger
          than the web's on the same screen.
        */}
        {/* THE BANK PARTNER'S QUESTION, ASKED — the web's panel and its
            reasoning: Paystack will not open this business's account numbers
            until it has matched a BVN to a bank account, and nothing but
            these three values changes that answer. */}
        {!account.loading &&
          !has &&
          opening === 'done' &&
          (opener.code === 'account_identity_required' ||
            opener.code === 'account_identity_failed' ||
            opener.code === 'account_issue_pending') && (
            <IdentifyForAccount client={client} start={opener.code} onOpened={() => account.reload()} />
          )}

        {/* A READ THAT FAILED IS NOT AN ACCOUNT BEING OPENED — the web's
            panel. It said "Setting up your account number…" over the very
            error that meant nothing was being set up. */}
        {!account.loading && !has && account.error !== undefined && (
          <View style={{ gap: space.sm, marginTop: space.md }}>
            <Text style={[styles.lead, { marginBottom: 0, fontFamily: font.sansSemi, color: colors.text }]}>
              We could not check your account number.
            </Text>
            <FormError error={account.error} code={account.code} />
            <Button label="Try again" quiet onPress={account.reload} />
          </View>
        )}

        {!account.loading &&
          !has &&
          account.error === undefined &&
          usesVirtualAccount &&
          !(
            opening === 'done' &&
            (opener.code === 'account_identity_required' ||
              opener.code === 'account_identity_failed' ||
              opener.code === 'account_issue_pending')
          ) && (
          <View style={{ gap: space.sm, marginTop: space.md }}>
            <Text style={[styles.lead, { marginBottom: 0, fontFamily: font.sansSemi, color: colors.text }]}>
              {opening !== 'done'
                ? 'Setting up your account number…'
                : 'Your account number is not ready yet.'}
            </Text>
            {opening === 'done' && (
              <>
                <FormError error={opener.error} code={opener.code} />
                <Text style={[styles.muted, { marginBottom: 0 }]}>
                  We will try again the next time you open this screen.
                </Text>
              </>
            )}
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
        {!account.loading && usesMobileMoney && <FormError error={issueError} code={issueCode} />}
        {/* What linking or removing did. It was returned and never drawn. */}
        {!account.loading && usesMobileMoney && linked !== undefined && <Done message={linked} />}
      </Panel>

      {!account.loading && (
        <PayIn currency={here?.currency ?? session.data?.home_currency ?? 'NGN'} client={client} />
      )}

      {/*
        AND ASKING TO BE PAID IS A DIFFERENT SCREEN — `/request`.

        The two identifiers a customer shares lived at the bottom of this
        screen because this is where money arriving is the subject, which is
        true and was not enough: the home screen's Request action pointed HERE,
        so two of its four actions led to one screen, and somebody who tapped
        Request landed on a heading that said Add Money.
      */}

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
 * THE BVN AND A BANK ACCOUNT ON IT — the web's component, field for field.
 * See `apps/web/src/app/add-money/page.tsx`: three values Paystack matches
 * itself, then a visible wait while it assigns the number, asking again every
 * eight seconds for two minutes.
 */
function IdentifyForAccount({
  client,
  start,
  onOpened,
}: {
  readonly client: XetralClient;
  readonly start: string | undefined;
  readonly onOpened: () => void;
}) {
  const styles = useStyles();
  const colors = useTheme();
  const [mode, setMode] = useState<'form' | 'pending' | 'slow'>(
    start === 'account_issue_pending' ? 'pending' : 'form',
  );
  const [failed, setFailed] = useState(start === 'account_identity_failed');
  /*
   * WHETHER THE CUSTOMER GAVE ANYTHING. "Pending" also means the account is
   * still being asked for in the background with nothing from them — the
   * server tries the bank partner again for about fifteen minutes before it
   * offers this form — and "confirming your details" would be a sentence
   * about details they never gave.
   */
  const [submitted, setSubmitted] = useState(false);
  const [bvn, setBvn] = useState('');
  const [bank, setBank] = useState('');
  const [number, setNumber] = useState('');
  const { busy, error, code, run } = useSubmit();
  const banks = useLoad(
    () => (mode === 'form' ? client.identityBanks() : Promise.resolve([])),
    [client, mode],
  );

  const polls = useRef(0);
  const opened = useRef(onOpened);
  opened.current = onOpened;
  useEffect(() => {
    if (mode !== 'pending') return;
    polls.current = 0;
    const timer = setInterval(() => {
      polls.current += 1;
      if (polls.current > 15) {
        clearInterval(timer);
        setMode('slow');
        return;
      }
      client.fundingAccount().then(
        () => {
          clearInterval(timer);
          opened.current();
        },
        (cause: unknown) => {
          const refused = codeOf(cause);
          if (refused === 'account_identity_failed' || refused === 'account_identity_required') {
            clearInterval(timer);
            setFailed(refused === 'account_identity_failed');
            setMode('form');
          }
        },
      );
    }, 8000);
    return () => clearInterval(timer);
  }, [mode, client]);

  const lead = [styles.lead, { marginBottom: 0, fontFamily: font.sansSemi, color: colors.text }];

  if (mode !== 'form') {
    return (
      <View
        accessibilityLiveRegion="polite"
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: space.sm,
          marginTop: space.md,
          padding: space.md,
          borderRadius: radius.lg,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.edge,
        }}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.irisTint,
          }}
        >
          <Icon name={mode === 'slow' ? 'clock' : 'shield'} size={20} color={colors.irisText} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={lead}>
            {submitted
              ? mode === 'slow'
                ? 'Still confirming your details'
                : 'Confirming your details with the bank'
              : mode === 'slow'
                ? 'Still setting up your account number'
                : 'Setting up your account number'}
          </Text>
          <Text style={[styles.hint, { marginTop: 0 }]}>
            {mode === 'slow'
              ? 'This is taking longer than usual. Your account number will be here the next time you open this screen.'
              : submitted
                ? 'Your account number usually arrives within a minute. It will appear here — you can stay or come back.'
                : 'Our bank partner is opening it now. It usually takes a minute or two and will appear here — you can stay or come back.'}
          </Text>
        </View>
      </View>
    );
  }

  const bvnOk = /^[0-9]{11}$/.test(bvn);
  const numberOk = /^[0-9]{10}$/.test(number);
  const ready = bvnOk && numberOk && bank !== '';

  return (
    <View style={{ gap: space.sm, marginTop: space.md }}>
      <View style={{ gap: 4 }}>
        <Text style={lead}>Confirm it’s you to get your account number</Text>
      </View>

      {failed && error === undefined && (
        <FormError
          error="Those details did not match. Check your BVN, bank and account number, and try again."
          code="account_identity_failed"
        />
      )}

      <Text style={styles.label}>BVN</Text>
      <TextInput
        style={styles.input}
        value={bvn}
        onChangeText={(t) => setBvn(t.replace(/[^0-9]/g, '').slice(0, 11))}
        keyboardType="number-pad"
        maxLength={11}
        autoComplete="off"
        placeholder="11 digits"
        placeholderTextColor={colors.text3}
        accessibilityLabel="BVN"
      />

      <Text style={styles.label}>Bank</Text>
      <Select
        label="Bank"
        value={bank}
        onChange={setBank}
        searchable
        searchPlaceholder="Search banks"
        placeholder={banks.loading ? 'Loading banks…' : 'Choose your bank'}
        options={(banks.data ?? []).map((b) => ({ value: b.code, label: b.name }))}
      />

      <Text style={styles.label}>Account number</Text>
      <TextInput
        style={styles.input}
        value={number}
        onChangeText={(t) => setNumber(t.replace(/[^0-9]/g, '').slice(0, 10))}
        keyboardType="number-pad"
        maxLength={10}
        autoComplete="off"
        placeholder="10 digits, held on the same BVN"
        placeholderTextColor={colors.text3}
        accessibilityLabel="Account number"
      />

      <View style={{ marginTop: space.xs }}>
        <Button
          label={
            busy
              ? 'Sending…'
              : !bvnOk
                ? 'Enter your 11-digit BVN'
                : bank === ''
                  ? 'Choose your bank'
                  : !numberOk
                    ? 'Enter your 10-digit account number'
                    : 'Get my account number'
          }
          busy={busy}
          disabled={!ready}
          onPress={() =>
            void run(async () => {
              try {
                await client.identifyForAccount({ bvn, bankCode: bank, accountNumber: number });
                onOpened();
              } catch (cause) {
                if (codeOf(cause) === 'account_issue_pending') {
                  setBvn('');
                  setSubmitted(true);
                  setMode('pending');
                  return undefined;
                }
                throw cause;
              }
              return undefined;
            })
          }
        />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="lock" size={14} color={colors.text2} />
        <Text style={[styles.hint, { marginTop: 0, flex: 1 }]}>
          Xetral keeps only the last four digits.
        </Text>
      </View>
      <FormError error={error ?? banks.error} code={code ?? banks.code} />
    </View>
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

/**
 * DEBIT CARD OR USSD — the web's panel, control for control. See
 * `apps/web/src/app/add-money/page.tsx`: the hosted checkout with the
 * customer as their own payer, opened on the method they pressed. The card is
 * typed on the provider's page, never here. USSD is naira only.
 */
function PayIn({ currency, client }: { readonly currency: string; readonly client: XetralClient }) {
  const styles = useStyles();
  const colors = useTheme();
  const [method, setMethod] = useState<'card' | 'ussd'>('card');
  const [amount, setAmount] = useState('');
  const { busy, error, code, run } = useSubmit();
  const ussd = currency === 'NGN';
  const chosen = ussd ? method : 'card';
  const valid =
    amount.trim() !== '' &&
    isValidAmount(amount, exponentFor(currency)) &&
    !/^0+(\.0+)?$/.test(amount.trim());

  return (
    <Panel title={ussd ? 'Pay in by card or USSD' : 'Pay in by card'}>
      {ussd && (
        <Segmented
          label="How you pay"
          value={method}
          onChange={setMethod}
          options={[
            { value: 'card', label: 'Debit card' },
            { value: 'ussd', label: 'USSD' },
          ]}
        />
      )}
      <AmountCard>
        <Text style={styles.label}>Amount</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <CurrencyPill>
            <Text style={{ fontFamily: font.sansSemi, color: colors.text }}>{currency}</Text>
          </CurrencyPill>
          <TextInput
            value={amount}
            onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))}
            placeholder="0"
            placeholderTextColor={colors.text3}
            keyboardType="decimal-pad"
            accessibilityLabel={`Amount in ${currency}`}
            style={{ flex: 1, fontFamily: font.numBold, fontSize: 26, color: colors.text, padding: 0 }}
          />
        </View>
      </AmountCard>
      <View style={{ marginTop: space.md }}>
        <Button
          label={
            valid
              ? `Pay ${formatAmount(amount.trim(), currency)} ${chosen === 'ussd' ? 'by USSD' : 'by card'}`
              : 'Enter an amount'
          }
          busy={busy}
          disabled={!valid}
          onPress={() =>
            void run(async () => {
              const session = await client.topUp(amount.trim(), chosen);
              // The provider's own page, in the browser. Nothing about a card
              // passes through this app.
              await Linking.openURL(session.authorization_url);
              return undefined;
            })
          }
        />
      </View>
      <Text style={[styles.hint, { marginTop: space.xs }]}>
        {chosen === 'ussd'
          ? 'You will get a short code to dial from the phone linked to your bank.'
          : 'You enter your card on a secure page. Xetral never sees your card details.'}
      </Text>
      <FormError error={error} code={code} />
    </Panel>
  );
}

