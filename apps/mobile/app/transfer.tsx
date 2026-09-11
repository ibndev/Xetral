import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { e164, exponentFor, formatAmount, isValidAmount, sendableFor } from '@xetral/client';
import { codeOf } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Field, FormError, Loading, Panel, Segmented, Toast } from '@/ui';
import { Select } from '@/select';
import { Icon } from '@/icon';
import { CountryMark } from '@/currency-mark';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { radius, useStyles, useTheme } from '@/theme';

/** Zero, written the way this currency writes it — "0.00" for naira,
 *  "0.000000" for USDT. The API sends major units, so the string differs. */
const isZero = (amount: string): boolean => /^-?0(\.0+)?$/.test(amount);

export default function Transfer() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { busy, error, code, done, run, clear } = useSubmit();

  /**
   * One key per attempt at THIS transfer, fixed when the screen mounts.
   *
   * A phone on a patchy connection is where double-sends actually happen: the
   * request succeeds, the response never arrives, the customer taps again.
   * Generating this inside the handler would defeat the entire guard.
   */
  const attempt = useIdempotencyKey();

  const [recipient, setRecipient] = useState('');
  /*
   * THE RECIPIENT'S DIALLING CODE IS THE RECIPIENT'S COUNTRY.
   *
   * A Xetral-to-Xetral payment is addressed by phone number, and the picker
   * in front of the field does two jobs: it builds the E.164 string the
   * server stores, so a sender can type the number the way they have it
   * saved; and it says WHERE THE MONEY IS GOING with no lookup at all. An
   * endpoint answering "which country is this number in?" would answer
   * differently for a number that belongs to a customer, which is a way to
   * enumerate the customer base one request at a time.
   */
  /*
   * THE COUNTRY CODE, NOT THE DIALLING CODE. They are not interchangeable:
   * the United States and Canada share +1, so a picker keyed on the dialling
   * code has two entries with one value and `find()` returns whichever came
   * first — the customer selects Canada and the screen says United States.
   */
  const [recipientCountry, setRecipientCountryCode] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');

  /*
   * WHERE THE MONEY IS GOING, and this is the half the screen was missing.
   *
   * Sending has only ever meant sending to another Xetral customer. Money
   * arrives through a dedicated account number and the only ways out were a
   * card, a bill or crypto — a customer could not pay their landlord.
   *
   * Two destinations on ONE screen rather than two, because the question is
   * the same one and only the shape of the answer differs. It also keeps the
   * amount, the currency and the PIN step in one place rather than in two
   * copies that drift — which is the web app's argument too, and these two
   * screens are held to it by `parity.test.ts`.
   */
  const [destination, setDestination] = useState<'xetral' | 'bank'>('xetral');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');

  /*
   * THE NAME THE BANK HOLDS, fetched before the customer confirms.
   *
   * The one control a bank payout has that a Xetral transfer does not need:
   * an account number that passes every format check can still belong to a
   * stranger, and the bank's own answer is the only claim about the
   * beneficiary that does not come from the sender.
   *
   * Shown, and NOT sent. The server looks it up again for itself, because
   * anything this app can send is something a stolen session can send.
   */
  const [beneficiary, setBeneficiary] = useState<string | undefined>(undefined);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);
  /* A Mobile Money wallet has no name enquiry on any of these rails — see the
   * web Send screen, which records why this is its own state rather than a
   * failure, and why it must never become an echo of what the sender typed. */
  const [nameUnavailable, setNameUnavailable] = useState(false);

  const [amount, setAmount] = useState('');
  /*
   * EMPTY UNTIL THE SESSION LOADS, then resolved rather than stored — the
   * same fix, for the same reason, as the web Send screen. It was 'NGN', so
   * every customer's picker opened on naira: a customer in Accra was shown
   * "You have no NGN" on the screen they opened in order to pay somebody.
   */
  const [currency, setCurrency] = useState('');
  const [pin, setPin] = useState('');

  /*
   * WHAT MAY BE SENT, NOT WHAT IS HELD.
   *
   * This list came from the customer's own balances, which reads as sensible
   * and asks the wrong question: a customer holding only naira was offered
   * exactly one option, so the picker looked broken, and anything that
   * happened to appear as a balance became a transfer option nothing had
   * decided to offer. `TRANSFER_CURRENCIES` is the decision, shared with the
   * web app and checked against the API's own enum by the build.
   *
   * Balances are still loaded, to show what is behind each choice.
   */
  const balances = useLoad(() => client.balances(), [client]);
  const held = new Map((balances.data ?? []).map((b) => [b.currency, b.spendable]));


  /*
   * THE PIN IS ASKED ABOUT BEFORE THE FORM, and WHO is asked before that.
   *
   * Both were discovered at the end: a customer with no transaction PIN filled
   * in a recipient, an amount and a PIN box before being told the PIN box was
   * never going to work; and "recipient email" was the only way to name
   * somebody, which is the identifier people are least willing to share.
   */
  const session = useLoad(() => client.currentSession(), [client]);

  /*
   * THEIR OWN LOCAL CURRENCY, not every country's. See the web's Send screen
   * for the argument: `TRANSFER_CURRENCIES` is what the API accepts, and
   * showing a Nigerian the cedi and shilling options gives them two choices
   * that answer `insufficient_funds` with nothing on screen saying which.
   */
  const offered = sendableFor(session.data?.home_currency, [...held.keys()]);

  /*
   * Bank payouts are a per-country rail, so the country comes from the
   * customer rather than a picker. Nigeria is the fallback for an account
   * opened before 040, which is what those accounts are.
   */
  const homeCountry = session.data?.country ?? 'NG';

  /*
   * HOW MONEY LEAVES WHERE THIS CUSTOMER IS — data, not a `switch`.
   *
   * The bank option offered a Nigerian bank list to everybody. In Ghana and
   * Kenya money moves to a mobile money wallet on a phone number, so a
   * customer in Accra was being offered a product their money cannot reach.
   * 046 puts the answer on the country row, which is where 040 says a fact
   * about a country belongs. 'bank' is the fallback: conservative, and what
   * Nigeria needs.
   */
  const countries = useLoad(() => client.session.countries(), [client]);
  /*
   * FROM THE SESSION FIRST — the API reads `payout_method` off the customer's
   * own country row, and it is what Add Money already personalises on.
   * Deriving it a second time from the public country list is one more thing
   * that has to have loaded before the answer is right, and while it has not
   * the fallback is 'bank' — which offered a customer in Accra a bank account
   * form for money that moves on a phone number.
   */
  const mobileMoney =
    (session.data?.payout_method ??
      countries.data?.find((c) => c.code === homeCountry)?.payout_method ??
      'bank') === 'mobile_money';

  /* Loaded only when the bank tab is open: it is a provider call behind our
   * API, and a customer who never opens the tab never pays for it. */
  const banks = useLoad(
    async () => (destination === 'bank' ? client.payoutBanks(homeCountry) : []),
    [client, destination, homeCountry],
  );

  /*
   * WHERE THE MONEY IS GOING, and what a local payout must be in.
   *
   * A local payout IS its currency — money to a Nigerian bank is naira, to a
   * Ghanaian wallet is cedis — so that side has no picker and the rail
   * decides. Xetral-to-Xetral is the international half and keeps the choice.
   */
  /*
   * THEIR OWN COUNTRY UNTIL THEY SAY OTHERWISE. The picker opened on a
   * placeholder, so the commonest payment on the platform — somebody paying a
   * neighbour — began by asking the customer to find their own country in a
   * list. Resolved rather than seeded into state so it follows the session
   * the moment it loads.
   */
  const recipientPlace = countries.data?.find(
    (c) => c.code === (recipientCountry === '' ? session.data?.country : recipientCountry),
  );
  const recipientCurrency = recipientPlace?.currency;
  const homeCurrency = session.data?.home_currency ?? 'NGN';
  const sendCurrency =
    destination === 'bank' ? homeCurrency : currency === '' ? homeCurrency : currency;

  /* Arrived from a payment link? Then the recipient is already named and must
   * not be asked for again — a link names one Xetral customer, which is what
   * 039 built it for. Everybody else pays by number. */
  const payee =
    recipient !== '' ? recipient : e164(recipientPlace?.dial_code ?? '', recipientPhone);

  const converting =
    destination === 'xetral' &&
    recipientCurrency !== undefined &&
    recipientCurrency !== sendCurrency;

  /*
   * THE RATE AND THE FIGURE, from the server rather than from arithmetic here.
   *
   * `/v1/fx/quote` reads the same published policy the conversion itself
   * will use, so what the customer sees is the rate they get. An unpublished
   * pair is REFUSED rather than quoted from a default, and saying so before
   * the PIN is far better than after it.
   */
  // An empty box asks for one unit, which is enough to draw the rate line
  // before anything is typed. COMPUTED OUT HERE so it can be both the
  // dependency and the thing the answer is checked against.
  const forAmount =
    amount === '' || !isValidAmount(amount, exponentFor(sendCurrency)) ? '1' : amount;

  const quote = useLoad(async () => {
    if (!converting || recipientCurrency === undefined) return undefined;
    /*
     * THE REASON IS KEPT — see the web screen. Swallowing it made every
     * failure read as "we do not trade this pair", which was FALSE for the one
     * that happened: the API's currency list had been left behind by three
     * migrations and refused GHS before reading any price.
     *
     * STAMPED WITH WHAT IT IS A QUOTE FOR. See `priced` below.
     */
    return { forAmount, ...(await client.fxQuote(sendCurrency, recipientCurrency, forAmount)) };
  }, [client, converting, recipientCurrency, sendCurrency, forAmount]);

  /*
   * THE FIGURE ONLY COUNTS WHEN IT IS A FIGURE FOR THIS AMOUNT.
   *
   * `useLoad` keeps the last successful result while the next request is in
   * flight AND after one fails — right for a balance, wrong for a rate. Type
   * 25, clear it, type 20, and the "they receive" line went on showing what 25
   * converts to: correct arithmetic about an amount the customer had already
   * replaced, and a refusal in between pinned it there.
   *
   * So the answer carries the question, and one that does not match what is on
   * screen is not shown at all.
   */
  const priced = quote.data?.forAmount === forAmount ? quote.data : undefined;
  /* Only `pair_not_supported` means "we do not trade this" — the code an
   * unpublished `fx_spread_policies` row produces. Everything else is a
   * different problem and must not read as one about pricing. */
  const pairUnpriced = quote.code === 'pair_not_supported';

  // Against the currency actually being SENT. On the payout side there is no
  // picker and the rail decides, so checking the picked one would count
  // decimals for a currency this transfer is not in.
  const amountValid = amount === '' || isValidAmount(amount, exponentFor(sendCurrency));

  /*
   * HOW MANY DIGITS BEFORE IT IS WORTH ASKING, and it is NOT ten everywhere.
   *
   * Ten is a NUBAN. A Ghanaian MTN number and a Kenyan Safaricom number are
   * NINE national digits — `244123456`, `712345678` — so a floor of ten meant
   * the lookup never fired at all for a customer who typed their number
   * without the trunk zero. No request, so no `name_unavailable`, so the
   * Continue button stayed disabled with nothing on screen saying why.
   */
  const minimumDigits = mobileMoney ? 9 : 10;

  async function lookUp(code: string, number: string): Promise<void> {
    if (code === '' || number.length < minimumDigits) {
      setBeneficiary(undefined);
      setLookupFailed(false);
      setNameUnavailable(false);
      return;
    }
    setLookingUp(true);
    setLookupFailed(false);
    setNameUnavailable(false);
    try {
      const found = await client.lookupBankAccount({
        country: homeCountry,
        bankCode: code,
        accountNumber: number,
      });
      setBeneficiary(found.account_name);
    } catch (error: unknown) {
      setBeneficiary(undefined);
      // Only `name_unavailable` is told apart, and it says nothing about
      // which numbers exist — it is a fact about Mobile Money as a product.
      // Everything else stays indistinguishable, or the lookup becomes a way
      // to map which numbers are live at which bank one request at a time.
      if (codeOf(error) === 'name_unavailable') setNameUnavailable(true);
      else setLookupFailed(true);
    } finally {
      setLookingUp(false);
    }
  }
  /*
   * ONLY WHEN WE KNOW. `has_pin` is `boolean | null` and null means the server
   * could not tell — which must NOT route somebody into creating a PIN they
   * already have. That is exactly what happened when a failed query answered
   * `false`: a customer who had set one was sent back to set it again.
   *
   * Unknown falls through to the ordinary form, where the server's own
   * `pin_not_set` refusal decides — and that refusal already carries a link to
   * the right screen, so the worst case is one extra step rather than a loop.
   */
  const needsPin = session.data?.has_pin === false;
  /*
   * ONE FIELD, THEN A CONFIRM. Matching the web, and for the same two
   * reasons: the chooser's two answers led to the same input because the API
   * resolves a handle, an email, a phone number and a payment link from one
   * string; and a PIN answers "yes, this one", which cannot be asked before
   * the customer has seen what "this one" is.
   */
  const [stage, setStage] = useState<'details' | 'confirm'>('details');

  if (session.loading) {
    return (
      <Shell back="/wallet" title="Send money">
        <Loading />
      </Shell>
    );
  }

  if (needsPin) {
    return (
      <Shell back="/wallet" title="Send money">
        <Panel title="First, a transaction PIN" subtitle="It authorises every payment you make">
          <Text style={styles.lead}>
            A separate PIN approves money leaving your account. You set it once.
          </Text>
          <Button label="Set my transaction PIN" onPress={() => router.push('/settings')} />
        </Panel>
      </Shell>
    );
  }

  /*
   * THE CONFIRM STEP, inline rather than a component with eleven props.
   *
   * It reads the same state the details form writes, so there is nothing to
   * pass and nothing that can be passed out of date.
   */
  if (stage === 'confirm') {
    return (
      <Shell
        back="/wallet"
        title="Confirm"
        /*
          OVER the screen, not inside the scroll. The form resets itself on a
          success and the keyboard is closing at the same moment, so the
          inline line is easy to miss — and "did my ₦50,000 go?" is the one
          question this product must never leave open. The inline copy stays,
          so a refusal can still be re-read after this has gone.
        */
        overlay={
          <>
            <Toast message={done} tone="ok" onDone={clear} />
            <Toast message={error} tone="bad" onDone={clear} />
          </>
        }
      >
        <Panel title="Confirm" subtitle="Check this before you approve it">
          {/* For a XETRAL transfer, echoed exactly as typed rather than
              resolved to a name: resolving would be a lookup that says which
              handles and addresses exist, and this screen is reachable by
              anybody. For a BANK payout it is the opposite and deliberately
              so — the name comes from the bank, the sender did not author it,
              and it is the only thing between a transposed digit and money
              that cannot be recalled. */}
          {destination === 'bank' ? (
            <>
              <View style={styles.row}>
                <Text style={styles.muted}>To</Text>
                <Text style={styles.amount}>{beneficiary}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.muted}>Account</Text>
                <Text style={styles.amount}>
                  {accountNumber} ·{' '}
                  {banks.data?.find((bank) => bank.code === bankCode)?.name ?? ''}
                </Text>
              </View>
            </>
          ) : (
            <>
              <View style={styles.row}>
                <Text style={styles.muted}>To</Text>
                <Text style={styles.amount}>{payee}</Text>
              </View>
              {recipientPlace !== undefined && (
                <View style={styles.row}>
                  <Text style={styles.muted}>In</Text>
                  <Text style={styles.amount}>{recipientPlace.name}</Text>
                </View>
              )}
            </>
          )}
          <View style={styles.row}>
            <Text style={styles.muted}>Amount</Text>
            <Text style={styles.amount}>{formatAmount(amount || '0', sendCurrency)}</Text>
          </View>
          {/* THE LAST PLACE THE CONVERSION CAN BE CHECKED. Nothing new — the
              same quote, repeated where the decision is actually made. */}
          {converting && priced !== undefined && (
            <View style={styles.row}>
              <Text style={styles.muted}>They receive</Text>
              <Text style={styles.amount}>
                {formatAmount(priced.receives, recipientCurrency ?? sendCurrency)}
              </Text>
            </View>
          )}

          <Field
            label="Transaction PIN"
            secureTextEntry
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChangeText={setPin}
          />

          <Button
            label={`Send ${formatAmount(amount || '0', sendCurrency)}`}
            busy={busy}
            disabled={pin === ''}
            onPress={() =>
              void run(async () => {
                const result =
                  destination === 'bank'
                    ? await client
                        .payToBank({
                          country: homeCountry,
                          bankCode,
                          accountNumber,
                          amount,
                          // THE LOCAL CURRENCY, not a picked one. There is no
                          // picker on this side and the rail decides.
                          currency: homeCurrency,
                          pin,
                          idempotencyKey: attempt.key,
                        })
                        /*
                         * One shape for the success line below, so the two
                         * branches do not each grow a copy of the wording.
                         *
                         * `pending` IS THE HALF THAT WAS MISSING. A payout the
                         * provider never answered for stays `reserved` — held,
                         * not sent, and the sweep will ask — and this line
                         * said "Sent" for it. A payout that FAILED now arrives
                         * as a refusal rather than as a view, so it cannot
                         * reach this branch at all.
                         */
                        .then((p) => ({
                          amount: p.amount,
                          fee: p.fee,
                          currency: p.currency,
                          pending: p.status === 'reserved',
                        }))
                    : converting && recipientCurrency !== undefined
                      ? /*
                         * ACROSS CURRENCIES IS A REMITTANCE, NOT A TRANSFER.
                         *
                         * `remit` is ONE journal entry that converts and
                         * delivers — Phase 10's shape, because
                         * convert-then-send leaves a window where a crash
                         * strands the money in a wallet the sender never
                         * meant to hold. `transfer` here would have moved
                         * naira into a Ghanaian's naira wallet, which is
                         * money they cannot spend where they live.
                         */
                        await client
                          .remit({
                            from: sendCurrency,
                            to: recipientCurrency,
                            amount,
                            recipient: payee,
                            pin,
                            idempotencyKey: attempt.key,
                          })
                          .then((t) => ({
                            amount: t.amount,
                            fee: '0.00',
                            currency: t.from,
                            pending: false,
                          }))
                      : await client
                          .transfer({
                            recipient: payee,
                            amount,
                            currency: sendCurrency,
                            pin,
                            idempotencyKey: attempt.key,
                          })
                          .then((t) => ({ ...t, pending: false }));
                // The attempt is over, so the next Send is a new transfer and
                // needs a new key — reusing this one would have the server
                // replay this transfer and report success for money that
                // never moved.
                attempt.next();
                // Cleared straight away. A PIN authorises one instruction; it
                // is not a password to hold on to.
                setPin('');
                // Back to an empty form: leaving the review on screen invites
                // a second tap on money that has already moved.
                setStage('details');
                setAmount('');
                setRecipient('');
                setRecipientPhone('');
                setAccountNumber('');
                setBeneficiary(undefined);
                const moved = `${formatAmount(result.amount, result.currency)}${
                  result.fee === '0.00'
                    ? ''
                    : ` (fee ${formatAmount(result.fee, result.currency)})`
                }`;
                // NOT "Sent" for a payout still in the air. Saying it left
                // when the bank has not answered is the sentence that made a
                // stuck transfer read as a delivered one.
                return result.pending
                  ? `${moved} is on its way. We are waiting for the bank to confirm it.`
                  : `Sent ${moved}.`;
              })
            }
          />
          <Button
            label="Edit"
            quiet
            onPress={() => {
              setPin('');
              setStage('details');
            }}
          />

          <FormError error={error} code={code} />
          <Done message={done} />
        </Panel>
      </Shell>
    );
  }

  return (
    <Shell
      back="/wallet"
      title="Send money"
      /*
        OVER the screen, not inside the scroll. The form resets itself on a
        success and the keyboard is closing at the same moment, so the inline
        line is easy to miss — and "did my ₦50,000 go?" is the one question
        this product must never leave open. The inline copy stays, so a
        refusal can still be re-read after this has gone.
      */
      overlay={
        <>
          <Toast message={done} tone="ok" onDone={clear} />
          <Toast message={error} tone="bad" onDone={clear} />
        </>
      }
    >
      <Panel
        title="Send money"
        subtitle={
          mobileMoney
            ? 'Send to a Xetral account or Mobile Money number.'
            : 'Send to a Xetral account or bank account.'
        }
      >
        {/*
          TWO DESTINATIONS, TWO TABS — the web's control, on the phone.

          It was a `Select`, which is the right drawing for "which bank" and
          the wrong one here: a sheet over the form, two taps, to answer a
          question with two answers whose answer is then invisible except as a
          line of text. The two words are the question, so there is no caption
          above them.

          THE SECOND TAB SAYS "Mobile Money" WHERE THAT IS THE RAIL. 046 puts
          `payout_method` on the country because in Accra and Nairobi money
          does not move to a bank account, and a tab saying "Bank" over a
          Mobile Money form is the same product offered under the wrong name.
        */}
        <Segmented
          label="Where the money is going"
          value={destination}
          onChange={setDestination}
          options={[
            { value: 'xetral', label: 'Xetral' },
            { value: 'bank', label: mobileMoney ? 'Mobile Money' : 'Bank' },
          ]}
        />

        {destination === 'bank' ? (
          <>
            <Select
              label={mobileMoney ? 'Mobile Money provider' : 'Bank'}
              // Paystack returns upwards of a hundred Nigerian banks; finding
              // one by flicking through an alphabetical sheet is the customer
              // doing the computer's work.
              searchable
              searchPlaceholder={mobileMoney ? 'Search providers…' : 'Search banks…'}
              value={bankCode}
              onChange={(code) => {
                setBankCode(code);
                void lookUp(code, accountNumber);
              }}
              options={(banks.data ?? []).map((bank) => ({
                value: bank.code,
                label: bank.name,
              }))}
            />
            <Field
              label={mobileMoney ? 'Mobile Money number' : 'Account number'}
              inputMode="numeric"
              placeholder={mobileMoney ? '0244123456' : '0123456789'}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={20}
              value={accountNumber}
              onChangeText={(text) => {
                // Digits only, so a pasted number carrying spaces or dashes
                // does not fail a lookup that would otherwise have worked.
                const digits = text.replace(/[^0-9]/g, '');
                setAccountNumber(digits);
                void lookUp(bankCode, digits);
              }}
            />
            {/* THE ONLY THING ON THIS SCREEN THE SENDER DID NOT WRITE. */}
            {lookingUp && <Text style={styles.muted}>Checking the name…</Text>}
            {/*
              `styles.beneficiary`, not `styles.amount`. The amount style is
              the tabular mono face this screen uses for FIGURES, and a
              person's name set in it reads as a serial number. This is small,
              semibold and in the theme's own success colour — the same
              treatment the web screen gives it, and legible on both grounds.
            */}
            {beneficiary !== undefined && (
              <Text style={styles.beneficiary}>{beneficiary}</Text>
            )}
            {lookupFailed && (
              <Text style={styles.error}>
                {mobileMoney
                  ? 'We could not check that number. Check the provider and the number.'
                  : 'We could not find that account. Check the number and the bank.'}
              </Text>
            )}
            {nameUnavailable && (
              <Text style={styles.hint}>
                Mobile Money does not confirm names. Check the number and the provider
                carefully — a transfer cannot be recalled.
              </Text>
            )}
          </>
        ) : (
          /*
            THE PHONE NUMBER IS THE IDENTIFIER, and the picker in front of it
            does two jobs: it builds the E.164 string the server stores, so a
            customer can type the number the way they have it saved; and it
            says which COUNTRY the money is going to, which is what the rate
            line below reads. The second job is why it is a picker rather than
            a parsed free-text field — parsing would be a guess about somebody
            else's country, on a money path.

            The list says "Ghana" and the trigger says "+233", the same
            arrangement the signup form uses: a country's name in front of a
            phone number pushes the digits off the screen.
          */
          <View>
            <Text style={styles.label}>Recipient&apos;s phone number</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Select
                label="Country"
                variant="dial"
                value={recipientPlace?.code ?? ''}
                onChange={setRecipientCountryCode}
                placeholder="+—"
                renderMark={(code) => <CountryMark country={code} size={18} />}
                renderTrigger={(code) => (
                  <Text style={[styles.amount, { color: colors.text }]}>
                    +{(countries.data ?? []).find((c) => c.code === code)?.dial_code ?? ''}
                  </Text>
                )}
                options={(countries.data ?? []).map((c) => ({
                  value: c.code,
                  label: c.name,
                  hint: c.currency,
                }))}
              />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={recipientPhone}
                onChangeText={(text) => setRecipientPhone(text.replace(/[^0-9]/g, ''))}
                keyboardType="phone-pad"
                placeholder="8031234567"
                placeholderTextColor={colors.text3}
              />
            </View>
            <Text style={styles.hint}>
              {recipientPlace === undefined
                ? 'Choose the country their number is in.'
                : `Going to ${recipientPlace.name} — they receive ${recipientPlace.currency}.`}
            </Text>
          </View>
        )}

        {/*
          A CURRENCY PICKER ON THE XETRAL SIDE AND NONE ON THE PAYOUT SIDE.

          A local payout IS its currency: money to a Nigerian bank is naira,
          to a Ghanaian wallet is cedis, to a Kenyan one is shillings. A box
          offering anything else offered a choice the rail cannot honour, and
          the only outcomes were picking your own currency anyway or being
          refused after typing a PIN.
        */}
        {destination === 'bank' ? (
          <View style={styles.row}>
            <Text style={styles.muted}>Currency</Text>
            <Text style={styles.amount}>{homeCurrency}</Text>
          </View>
        ) : (
          <>
            <Select
              label="Currency"
              value={sendCurrency}
              onChange={setCurrency}
              options={offered.map((code) => ({
                value: code,
                label: code,
                // ALWAYS a figure, including a zero. Omitting the hint for a
                // currency with no balance made "you have none of this" look
                // identical to "we did not say" — and now that every currency
                // is offered rather than filtered, that difference is the
                // whole information the picker carries.
                hint: formatAmount(held.get(code) ?? '0', code),
              }))}
            />
            {/*
              THE RATE, UNDER THE BOX THAT DECIDES IT, BEFORE ANY AMOUNT.
              Sending naira to Ghana is two decisions at once — what to send
              and what it becomes — and the second was invisible until after
              the money had moved.
            */}
            {converting && (
              <Text style={styles.hint}>
                {quote.loading || (priced === undefined && quote.error === undefined)
                  ? 'Getting today\u2019s rate…'
                  : priced !== undefined
                    ? `1 ${sendCurrency} = ${priced.rate} ${recipientCurrency ?? ''} today.`
                    : pairUnpriced
                      ? `We cannot convert ${sendCurrency} to ${recipientCurrency ?? ''} yet.`
                      : (quote.error ?? 'We could not get a rate just now.')}
              </Text>
            )}
          </>
        )}

        {/*
          THE WAY OUT, on the screen where the dead end is. Sending cedis
          from a naira balance is the ordinary cross-border case and it needs
          a conversion first; without this the customer types an amount,
          proves a PIN and is told `insufficient_funds` — true, and silent
          about what to do.
        */}
        {isZero(held.get(sendCurrency) ?? '0') && (
          <Text style={styles.hint}>
            You have no {sendCurrency}. Convert some on the Convert screen
            first, then come back.
          </Text>
        )}

        <Field
          label="Amount"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChangeText={setAmount}
        />
        {/*
          WHAT THEY WILL ACTUALLY GET, under the box that decides it. The rate
          line answers "what is a naira worth"; this answers the question the
          sender is really asking, which is whether the person at the other
          end receives enough.
        */}
        {converting && amount !== '' && amountValid && (
          <Text style={styles.hint}>
            {quote.loading || (priced === undefined && quote.error === undefined)
              ? 'Working out what they receive…'
              : priced === undefined
                ? pairUnpriced
                  ? 'We cannot say what they would receive yet.'
                  : 'We could not work that out just now.'
                : `They receive about ${formatAmount(
                    priced.receives,
                    recipientCurrency ?? sendCurrency,
                  )}.`}
          </Text>
        )}
        {!amountValid && (
          // Caught by the form rather than by a 400 from a money-moving
          // endpoint — and the check counts decimals PER CURRENCY, so USDT
          // gets six and naira gets two.
          <Text style={styles.error}>
            Enter an amount with at most {exponentFor(sendCurrency)} decimal places.
          </Text>
        )}

        {/* NO TRANSACTION PIN HERE. It is asked on the confirm step below,
            once the customer can see what they are approving. */}
        <Button
          label="Review"
          disabled={
            amount === '' ||
            !amountValid ||
            // A payout cannot be reviewed without a name to review: a
            // confirmation screen that confirms nothing is worse than none,
            // because it will be read as having been checked.
            (destination === 'bank'
              ? // A Mobile Money wallet has no name to review — requiring one
                // would leave every customer in Accra and Nairobi with a
                // button that never enables.
                beneficiary === undefined && !nameUnavailable
              : payee === '')
          }
          onPress={() => setStage('confirm')}
        />

        <FormError error={error} code={code} />
        <Done message={done} />
      </Panel>
    </Shell>
  );
}
