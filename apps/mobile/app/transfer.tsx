import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import {
  currencyName,
  exponentFor,
  formatAmount,
  isValidAmount,
  sendableFor,
} from '@xetral/client';
import type {
  Recipient,
  RecipientKind,
  RecipientResolution,
  XetralCountry,
} from '@xetral/client';
import { Shell } from '@/shell';
import { AmountCard, Button, Field, FormError, Loading, Panel, Toast } from '@/ui';
import { Select } from '@/select';
import { Icon } from '@/icon';
import { CurrencyMark } from '@/currency-mark';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { font, radius, space, useStyles, useTheme } from '@/theme';

/**
 * SENDING MONEY, AS ONE FLOW — the web's screen, on a handset.
 *
 * IT WAS THREE PRODUCTS UNDER ONE HEADING. The screen opened with a
 * `Segmented` asking "Xetral or Mobile Money?" — a question about OUR PLUMBING
 * put to somebody who only wants to pay a person — and each answer led to a
 * different form, a different set of fields and a different endpoint. A
 * customer who picked wrong got a dead end rather than a redirect.
 *
 * Four steps now, each asking one thing:
 *
 *   who       the people already paid, so the second payment costs a tap
 *   currency  what the recipient RECEIVES, which decides everything after it
 *   details   the country is read off the currency, and the rail is a list of
 *             networks with the Xetral account among them
 *   amount    what leaves, what lands, and what it costs
 *
 * THE RAIL IS A ROW IN A LIST RATHER THAN A TAB ACROSS THE TOP. That is the
 * whole of the unification: "how does this reach them" is one question with
 * several answers, and an internal Xetral transfer is one of the answers
 * rather than a separate product — so a customer who does not know whether
 * their friend has an account picks from one list and finds out.
 *
 * The two apps are held to the same route list by `parity.test.ts` and to the
 * same answer about whether a payout is reviewable by `momo-send.test.ts`.
 */
type Step = 'who' | 'currency' | 'details' | 'amount';

export default function Transfer() {
  const client = useXetral();
  const params = useLocalSearchParams<{ to?: string }>();

  const session = useLoad(() => client.currentSession(), [client]);
  const wallets = useLoad(() => client.balances(), [client]);
  const saved = useLoad(() => client.recipients(), [client]);
  const countries = useLoad(() => client.session.countries(), [client]);

  /*
   * ARRIVED FROM A PAYMENT LINK, which skips straight past the address book.
   *
   * `/pay/<x>` sends somebody here with the identifier in `to`. They have
   * already been told who they are paying, so asking them to pick from a list
   * they have never seen would be a step backwards — the flow opens on the
   * details screen with the number filled in.
   */
  const arrivedWith = typeof params.to === 'string' ? params.to : '';
  const [step, setStep] = useState<Step>(arrivedWith === '' ? 'who' : 'details');

  /** The recipient being paid — chosen from the list, or built by the flow. */
  const [chosen, setChosen] = useState<Recipient | undefined>(undefined);
  const [draft, setDraft] = useState<RecipientResolution | undefined>(undefined);

  /** What the RECIPIENT receives. Chosen on step two and read by every step
   *  after it, because it decides the country, the rail and the conversion. */
  const [receive, setReceive] = useState('');

  const [sent, setSent] = useState<string | undefined>(undefined);

  const home = session.data?.home_currency ?? 'NGN';

  const back = (): void => {
    if (step === 'amount') setStep('details');
    else if (step === 'details') setStep(arrivedWith === '' ? 'currency' : 'who');
    else if (step === 'currency') setStep('who');
  };

  return (
    <Shell
      title="Send"
      /* The chevron is the Shell's on the FIRST step, where back means leaving
         the flow — every step after it has its own, because back there means
         one step, not the wallet. Spread rather than `undefined`, which
         `exactOptionalPropertyTypes` refuses for an optional prop: an absent
         property and one holding `undefined` are different things here. */
      {...(step === 'who' ? { back: '/wallet' } : {})}
      overlay={<Toast message={sent} tone="ok" onDone={() => setSent(undefined)} />}
    >
      {step !== 'who' && (
        <Pressable
          onPress={back}
          android_ripple={null}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          style={{
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: space.xs,
          }}
        >
          <BackChevron />
        </Pressable>
      )}

      {step === 'who' && (
        <ChooseRecipient
          recipients={saved.data ?? []}
          loading={saved.loading}
          onPick={(recipient) => {
            setChosen(recipient);
            setDraft(undefined);
            setReceive(recipient.currency);
            setStep('amount');
          }}
          onRemove={async (id) => {
            await client.removeRecipient(id);
            saved.reload();
          }}
          onNew={() => {
            setChosen(undefined);
            setDraft(undefined);
            setStep('currency');
          }}
        />
      )}

      {step === 'currency' && (
        <ChooseCurrency
          home={home}
          onPick={(currency) => {
            setReceive(currency);
            setStep('details');
          }}
        />
      )}

      {step === 'details' && (
        <RecipientDetails
          receive={receive === '' ? home : receive}
          countries={countries.data ?? []}
          initialDestination={arrivedWith}
          onReady={(resolution, recipient) => {
            setDraft(resolution);
            setChosen(recipient);
            setReceive(resolution.currency);
            saved.reload();
            setStep('amount');
          }}
        />
      )}

      {step === 'amount' && (draft !== undefined || chosen !== undefined) && (
        <SendAmount
          /* One of the two is always present at this point: a saved recipient
             carries everything a draft does, and a draft is what a new one
             becomes before it is saved. */
          to={chosen ?? toRecipient(draft as RecipientResolution)}
          balances={wallets.data ?? []}
          home={home}
          onSent={(message) => {
            setSent(message);
            saved.reload();
            wallets.reload();
            setStep('who');
          }}
        />
      )}
    </Shell>
  );
}

function BackChevron() {
  const colors = useTheme();
  return <Icon name="chevronLeft" size={20} color={colors.text2} />;
}

/* ------------------------------------------------------------------ step 1 */

/**
 * The people already paid.
 *
 * A SEND FLOW WHOSE FIRST STEP IS AN EMPTY FIELD makes every payment cost the
 * same typing as the first. The list is the difference between a product
 * somebody uses twice and one they use weekly — which is why it is the
 * opening screen rather than a convenience tucked behind the form.
 */
function ChooseRecipient({
  recipients,
  loading,
  onPick,
  onRemove,
  onNew,
}: {
  readonly recipients: readonly Recipient[];
  readonly loading: boolean;
  readonly onPick: (recipient: Recipient) => void;
  readonly onRemove: (id: string) => Promise<void>;
  readonly onNew: () => void;
}) {
  const styles = useStyles();
  const colors = useTheme();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<string | undefined>(undefined);

  /*
   * THE CHIPS ARE THE CURRENCIES THIS CUSTOMER ACTUALLY PAYS, not every
   * currency the platform offers. A filter for a currency nobody in the list
   * holds filters to nothing, which reads as a broken control rather than as
   * an empty result.
   */
  const currencies = useMemo(
    () => [...new Set(recipients.map((r) => r.currency))].sort(),
    [recipients],
  );

  const shown = recipients.filter((r) => {
    if (filter !== '' && r.currency !== filter) return false;
    if (query.trim() === '') return true;
    const needle = query.trim().toLowerCase();
    return (
      r.display_name.toLowerCase().includes(needle) ||
      r.destination.includes(needle.replace(/[^0-9]/g, '')) ||
      (r.rail_name ?? '').toLowerCase().includes(needle)
    );
  });

  return (
    <Panel bare title="Who do you want to send money to?">
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="Search by name or account details"
      />

      {currencies.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          /*
           * THE RAIL SCROLLS INSIDE ITSELF, for the reason the activity
           * filters do: a row of chips that does not fit makes the whole
           * screen scroll sideways, and wrapping moves them under the thumb as
           * the selection changes width.
           */
          contentContainerStyle={{ gap: 8, paddingVertical: space.sm }}
        >
          <Chip label="All" on={filter === ''} onPress={() => setFilter('')} />
          {currencies.map((currency) => (
            <Chip
              key={currency}
              label={currency}
              currency={currency}
              on={filter === currency}
              onPress={() => setFilter(currency)}
            />
          ))}
        </ScrollView>
      )}

      {loading && recipients.length === 0 ? (
        <Loading />
      ) : recipients.length === 0 ? (
        <Text style={styles.lead}>
          Nobody here yet. Add the first person you want to pay and they stay on
          this list.
        </Text>
      ) : (
        <View>
          {shown.map((r) => (
            <View key={r.id} style={styles.row}>
              <Pressable
                onPress={() => onPick(r)}
                android_ripple={null}
                accessibilityRole="button"
                accessibilityLabel={`Send to ${r.display_name}`}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 13 }}
              >
                <View
                  style={[
                    styles.rowIcon,
                    { width: 46, height: 46, borderRadius: 999, backgroundColor: colors.brand },
                  ]}
                >
                  <Text style={{ color: colors.onBrand, fontFamily: font.sansSemi, fontSize: 15 }}>
                    {initialsOf(r.display_name)}
                  </Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 15 }}>
                    {r.display_name}
                  </Text>
                  <Text style={styles.muted} numberOfLines={1}>
                    {r.rail_name ?? 'Xetral account'} &middot;&middot;&middot;
                    {r.destination.slice(-4)}
                  </Text>
                </View>
                <CurrencyMark currency={r.currency} size={18} />
              </Pressable>
              {/*
                REMOVING IS BEHIND A SECOND PRESS, not a swipe and not a
                one-tap icon. This list is tapped to SEND, so a destructive
                control beside the tap target is one thumb-width from deleting
                somebody's landlord.
              */}
              <Pressable
                onPress={() => setMenu(menu === r.id ? undefined : r.id)}
                android_ripple={null}
                accessibilityRole="button"
                accessibilityLabel={`More for ${r.display_name}`}
                hitSlop={8}
                style={{ width: 36, alignItems: 'flex-end' }}
              >
                <Icon name="menu" size={18} color={colors.text3} />
              </Pressable>
            </View>
          ))}
          {shown.length === 0 && (
            <Text style={styles.hint}>Nobody on this list matches that.</Text>
          )}
          {menu !== undefined && (
            <Button
              label="Remove this recipient"
              quiet
              onPress={() => {
                const id = menu;
                setMenu(undefined);
                void onRemove(id);
              }}
            />
          )}
        </View>
      )}

      <Button label="New recipient" icon="plus" quiet onPress={onNew} />
    </Panel>
  );
}

/** A currency filter. A `Pressable` rather than `Segmented`, because the list
 *  is as long as the customer's own address book rather than two fixed halves. */
function Chip({
  label,
  currency,
  on,
  onPress,
}: {
  readonly label: string;
  readonly currency?: string;
  readonly on: boolean;
  readonly onPress: () => void;
}) {
  const colors = useTheme();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={null}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 13,
        paddingVertical: 7,
        borderRadius: radius.pill,
        // Ink when selected, not paper — the correction `Segmented` already
        // records: two near-white pills distinguished by a slightly darker
        // label is a question a customer has to squint at.
        backgroundColor: on ? colors.brand : colors.field,
        borderColor: on ? colors.brand : colors.edgeStrong,
        borderWidth: 1,
      }}
    >
      {currency !== undefined && <CurrencyMark currency={currency} size={16} />}
      <Text
        style={{
          color: on ? colors.onBrand : colors.text2,
          fontFamily: font.sansSemi,
          fontSize: 13.5,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A search box with a glyph in it, which `Field` alone is not. */
function SearchField({
  value,
  onChange,
  placeholder,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder: string;
}) {
  const colors = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 13,
        marginTop: space.md,
        borderRadius: radius.md,
        backgroundColor: colors.field,
        borderColor: colors.edgeStrong,
        borderWidth: 1,
      }}
    >
      <Icon name="search" size={18} color={colors.text3} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.text3}
        autoCorrect={false}
        style={{
          flex: 1,
          minHeight: 50,
          color: colors.text,
          fontFamily: font.sans,
          fontSize: 16,
        }}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ step 2 */

/**
 * What the RECIPIENT receives.
 *
 * ASKED BEFORE THE NUMBER, and that order is the reason this flow can be one
 * flow. The currency decides the country, the country decides the rail, and
 * the rail decides whether a name can be looked up — so everything the details
 * screen needs to draw itself comes from this one answer. Asking for a number
 * first would mean guessing which of those it belonged to.
 */
function ChooseCurrency({
  home,
  onPick,
}: {
  readonly home: string;
  readonly onPick: (currency: string) => void;
}) {
  const styles = useStyles();
  const [query, setQuery] = useState('');

  /*
   * WHAT THIS PLATFORM CAN ACTUALLY DELIVER, from `sendableFor` — the same
   * list the old screen used. A picker offering a currency nothing can pay out
   * is a choice that fails three screens later, which 046 records as the
   * failure that reads to a customer as their own details being wrong.
   */
  const all = sendableFor(home);
  const needle = query.trim().toLowerCase();
  const matches = (code: string): boolean =>
    needle === '' ||
    code.toLowerCase().includes(needle) ||
    currencyName(code).toLowerCase().includes(needle);

  const favourites = all.filter((c) => (c === home || c === 'USD') && matches(c));
  const stablecoins = all.filter((c) => (c === 'USDT' || c === 'USDC') && matches(c));
  const rest = all
    .filter((c) => !favourites.includes(c) && !stablecoins.includes(c) && matches(c))
    .sort((a, b) => currencyName(a).localeCompare(currencyName(b)));

  return (
    <Panel bare title="What currency should your recipient receive?">
      <SearchField value={query} onChange={setQuery} placeholder="Search currency or country" />

      <CurrencyGroup heading="Favourites" codes={favourites} onPick={onPick} />
      <CurrencyGroup heading="Stablecoins" codes={stablecoins} onPick={onPick} />
      <CurrencyGroup heading="All currencies" codes={rest} onPick={onPick} />

      {favourites.length + stablecoins.length + rest.length === 0 && (
        <Text style={styles.hint}>No currency matches that.</Text>
      )}
    </Panel>
  );
}

function CurrencyGroup({
  heading,
  codes,
  onPick,
}: {
  readonly heading: string;
  readonly codes: readonly string[];
  readonly onPick: (currency: string) => void;
}) {
  const styles = useStyles();
  const colors = useTheme();
  if (codes.length === 0) return null;
  return (
    <View>
      <Text
        style={{
          color: colors.text2,
          fontFamily: font.sansSemi,
          fontSize: 12,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          marginTop: space.md,
        }}
      >
        {heading}
      </Text>
      {codes.map((code) => (
        <Pressable
          key={code}
          onPress={() => onPick(code)}
          android_ripple={null}
          accessibilityRole="button"
          style={styles.row}
        >
          <View style={styles.rowIcon}>
            <CurrencyMark currency={code} size={22} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 15 }}>
              {currencyName(code)}
            </Text>
            <Text style={styles.muted}>{code}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------------ step 3 */

/**
 * Where it lands, and who holds it.
 *
 * THE COUNTRY IS READ OFF THE CURRENCY AND CANNOT BE TYPED. Cedis land in
 * Ghana; offering a country picker here would let somebody select Kenya and
 * GHS and produce a destination no rail can reach. It is shown because a
 * customer should be able to SEE what was inferred, and it is not editable
 * because changing it means changing the currency, which is one step back.
 *
 * THE ACCOUNT NAME IS FETCHED, NEVER TYPED — where the rail can answer. That
 * is the whole of what "the momo details cannot be found" was: the adapter
 * matched a network code and refused before making the call, so a Ghanaian
 * number whose owner Flutterwave will name was reported as unfindable. Where
 * the rail genuinely has none — Kenya's M-PESA — the screen ASKS FOR A LABEL
 * rather than refusing, because a bare number in an address book is how
 * somebody pays the wrong person.
 */
function RecipientDetails({
  receive,
  countries,
  initialDestination,
  onReady,
}: {
  readonly receive: string;
  readonly countries: readonly XetralCountry[];
  readonly initialDestination: string;
  readonly onReady: (resolution: RecipientResolution, saved: Recipient | undefined) => void;
}) {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { busy, error, code, run } = useSubmit();

  const country = countries.find((c) => c.currency === receive);
  const [rail, setRail] = useState('');
  const [destination, setDestination] = useState(initialDestination.replace(/[^0-9]/g, ''));
  const [label, setLabel] = useState('');
  const [save, setSave] = useState(true);
  const [found, setFound] = useState<RecipientResolution | undefined>(undefined);

  const banks = useLoad(
    async () => (country === undefined ? [] : client.payoutBanks(country.code)),
    [country?.code],
  );

  /*
   * THE XETRAL ACCOUNT IS A ROW IN THE SAME LIST AS THE NETWORKS.
   *
   * That is the unification. "How does this reach them" is ONE question with
   * several answers, and an internal transfer is one of the answers rather
   * than a separate product behind a tab — so a customer who does not know
   * whether their friend has an account picks from one list and finds out. It
   * is first because it is instant and free, which is the answer most people
   * want when it applies.
   */
  const rails = [
    { value: 'xetral', label: 'Xetral account — instant, no fee' },
    ...(banks.data ?? []).map((bank) => ({ value: bank.code, label: bank.name })),
  ];

  const kind: RecipientKind =
    rail === 'xetral' ? 'xetral' : country?.payout_method === 'mobile_money' ? 'momo' : 'bank';

  const numberLabel =
    kind === 'bank' ? 'Account number' : kind === 'momo' ? 'Mobile Money number' : 'Phone number';

  /*
   * ENOUGH TYPED TO BE WORTH ASKING ABOUT, and the floor is PER RAIL.
   *
   * A Ghanaian MTN number and a Kenyan Safaricom number are NINE national
   * digits; a NUBAN is ten. A flat floor of ten meant the lookup never fired
   * for a customer who typed theirs without the trunk zero — so no request was
   * made, nothing came back, and the button stayed disabled with nothing on
   * screen saying why.
   *
   * ONE DEFINITION, read by the lookup AND by the button. Two copies of this
   * condition is exactly what made the old screen's button enable and do
   * nothing, and `momo-send.test.ts` fails the build on either re-deriving it.
   */
  const mobileMoney = kind !== 'bank';
  const minimumDigits = mobileMoney ? 9 : 10;
  const enough = destination.replace(/[^0-9]/g, '').length >= minimumDigits;

  async function look(): Promise<void> {
    if (!enough || rail === '') return;
    await run(async () => {
      const resolution = await client.resolveRecipient({
        kind,
        /*
         * THE COUNTRY GOES EVEN ON THE XETRAL BRANCH, and leaving it off is
         * what made `08031234567` resolve to nobody. A national number has no
         * country in it; this flow already fixed one at the currency step, so
         * the server normalises through THAT country's dialling code rather
         * than guessing the sender's.
         */
        ...(country === undefined ? {} : { country: country.code }),
        ...(kind === 'xetral' ? {} : { railCode: rail }),
        destination,
      });
      setFound(resolution);
      return undefined;
    });
  }

  const nameUnavailable = found !== undefined && found.resolved_name === null;
  const ready = found !== undefined && (found.resolved_name !== null || label.trim().length >= 2);

  return (
    <Panel
      bare
      title="Who are you sending to?"
      subtitle="Fill in the necessary details of your recipient"
    >
      <Text style={styles.label}>Recipient country</Text>
      {/*
        READ-ONLY AS TEXT, not as a disabled input. A disabled box reads as a
        bug — somebody taps it, nothing happens, and the screen has given them
        no way forward. A line of text is the same restriction stated as a
        fact.
      */}
      <View
        style={{
          backgroundColor: colors.field,
          borderRadius: radius.md,
          paddingHorizontal: 15,
          paddingVertical: 14,
        }}
      >
        <Text style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 15 }}>
          {country?.name ?? receive}
        </Text>
      </View>

      <Select
        label="Network"
        value={rail}
        onChange={(next) => {
          setRail(next);
          setFound(undefined);
        }}
        options={rails}
        placeholder="Network"
        searchable={rails.length > 6}
        searchPlaceholder="Search networks…"
      />

      <Field
        label={numberLabel}
        value={destination}
        onChangeText={(next) => {
          setDestination(next);
          setFound(undefined);
        }}
        onBlur={() => void look()}
        keyboardType="number-pad"
        placeholder={kind === 'bank' ? '0123456789' : '0553921133'}
        autoComplete="off"
      />

      {found?.resolved_name != null && (
        <View>
          <Text style={styles.label}>Account name</Text>
          {/*
            THE RAIL'S OWN ANSWER, and the only thing on this screen presented
            as confirmation. A name the SENDER typed shown here would be a
            confirmation screen that confirms nothing while looking exactly
            like one — 043's rule, and the reason the label below is a
            separate, differently worded field.
          */}
          <View
            style={{
              backgroundColor: colors.field,
              borderRadius: radius.md,
              paddingHorizontal: 15,
              paddingVertical: 14,
            }}
          >
            <Text style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 15 }}>
              {found.resolved_name}
            </Text>
          </View>
        </View>
      )}

      {nameUnavailable && (
        <Field
          label="Name this recipient"
          value={label}
          onChangeText={setLabel}
          placeholder="What you want to call them"
          maxLength={140}
          hint="This network cannot confirm the account name, so nobody has checked it. Give them a name you will recognise — and check the number."
        />
      )}

      <Pressable
        onPress={() => setSave(!save)}
        android_ripple={null}
        accessibilityRole="switch"
        accessibilityState={{ checked: save }}
        style={[styles.rowBetween, { marginTop: space.md }]}
      >
        <Text style={{ color: colors.text, fontFamily: font.sans, fontSize: 15 }}>
          Save as beneficiary
        </Text>
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 7,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: save ? colors.brand : colors.field,
            borderColor: save ? colors.brand : colors.edgeStrong,
            borderWidth: 1,
          }}
        >
          {save && <Icon name="check" size={15} color={colors.onBrand} />}
        </View>
      </Pressable>

      <FormError error={error} code={code} />

      <Button
        label={busy ? 'Checking…' : found === undefined ? 'Check details' : 'Continue'}
        busy={busy}
        disabled={rail === '' || !enough || (found !== undefined && !ready)}
        onPress={() => {
          if (found === undefined) {
            void look();
            return;
          }
          void run(async () => {
            const recipient = save
              ? await client.saveRecipient({
                  kind: found.kind,
                  /* `found.destination` is already the international form,
                     so re-resolving needs no country — but an empty one would
                     fail the two-character schema, which is why this checks
                     the value rather than the kind. */
                  ...(found.country === '' ? {} : { country: found.country }),
                  ...(found.rail_code === null ? {} : { railCode: found.rail_code }),
                  destination: found.destination,
                  ...(label.trim() === '' ? {} : { label: label.trim() }),
                })
              : undefined;
            onReady(found, recipient);
            return undefined;
          });
        }}
      />
    </Panel>
  );
}

/* ------------------------------------------------------------------ step 4 */

/**
 * What leaves, what lands, and what it costs.
 *
 * TWO CARDS RATHER THAN ONE FIELD, because a cross-border payment has two
 * amounts and a customer cares about the second. The old screen showed one box
 * and a line of text; here "they receive" is a figure in its own right, and
 * the currency on each side is a control rather than a label.
 */
function SendAmount({
  to,
  balances,
  home,
  onSent,
}: {
  readonly to: Recipient;
  readonly balances: readonly { currency: string; spendable: string }[];
  readonly home: string;
  readonly onSent: (message: string) => void;
}) {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { busy, error, code, run } = useSubmit();
  const { key, next } = useIdempotencyKey();

  const [sendCurrency, setSendCurrency] = useState(home);
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');

  const balance = balances.find((b) => b.currency === sendCurrency)?.spendable ?? '0';
  const sameCurrency = sendCurrency === to.currency;

  /*
   * A QUOTE CARRIES THE AMOUNT IT IS A QUOTE FOR.
   *
   * `useLoad` keeps the last successful result while the next request is in
   * flight and after one fails, which is right for a balance and wrong for a
   * rate: type 25, clear it, type 20, and "they receive" goes on showing what
   * 25 converts to — correct arithmetic about an amount the customer has
   * already replaced. Stamping the answer with the amount and rendering only
   * on a match is structural; a debounce is not, because the stale figure
   * comes back on the next refusal either way.
   */
  const quote = useLoad(
    async () => {
      if (sameCurrency || !isValidAmount(amount, exponentFor(sendCurrency))) return undefined;
      const got = await client.fxQuote(sendCurrency, to.currency, amount);
      return { forAmount: amount, ...got };
    },
    [sendCurrency, to.currency, amount, sameCurrency],
  );
  const lands = quote.data?.forAmount === amount ? quote.data : undefined;

  /*
   * NO `Number(amount)` HERE, and the absence is the rule rather than an
   * omission. `isValidAmount` already refuses a negative (its pattern starts
   * `^[0-9]+`) and already refuses zero (it demands a digit 1-9), so the
   * `> 0` this line used to carry was redundant AND was a float holding
   * money — caught by `.semgrep/xetral.yml`, which is what that rule is for.
   */
  const enough = isValidAmount(amount, exponentFor(sendCurrency));

  return (
    <Panel bare>
      <View style={[styles.row, { borderBottomWidth: 0, paddingTop: 0 }]}>
        <View
          style={[
            styles.rowIcon,
            { width: 46, height: 46, borderRadius: 999, backgroundColor: colors.brand },
          ]}
        >
          <Text style={{ color: colors.onBrand, fontFamily: font.sansSemi, fontSize: 15 }}>
            {initialsOf(to.display_name)}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 15 }}>
            {to.display_name}
          </Text>
          <Text style={styles.muted} numberOfLines={1}>
            {to.rail_name ?? 'Xetral account'} &middot; {to.destination}
          </Text>
        </View>
      </View>

      <Text style={styles.h1}>
        Send {to.currency} to {firstNameOf(to.display_name)}
      </Text>

      <AmountCard invalid={amount !== '' && !enough}>
        <Text style={styles.fieldLabel}>You send</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Select
            /* NOT EMPTY, even though the pill draws no caption: this string is
               the sheet's own heading and the screen reader's label, so a blank
               one leaves a sheet titled nothing and a control announced as
               ": NGN". */
            label="Currency you send"
            variant="pill"
            value={sendCurrency}
            onChange={setSendCurrency}
            options={balances.map((b) => ({ value: b.currency, label: b.currency }))}
            renderMark={(value) => <CurrencyMark currency={value} size={18} />}
          />
          <TextInput
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={colors.text3}
            accessibilityLabel="Amount to send"
            style={{
              flex: 1,
              textAlign: 'right',
              color: colors.text,
              fontFamily: font.displayBold,
              fontSize: 30,
              letterSpacing: -0.6,
              fontVariant: ['tabular-nums'],
            }}
          />
        </View>
        <Text style={styles.muted}>Balance: {formatAmount(balance, sendCurrency)}</Text>
        {amount !== '' && !enough && (
          <Text style={styles.error}>Enter an amount in {sendCurrency}.</Text>
        )}
      </AmountCard>

      <AmountCard>
        <Text style={styles.fieldLabel}>{firstNameOf(to.display_name)} receives</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: radius.pill,
              backgroundColor: colors.surfaceRaised,
              borderColor: colors.edge,
              borderWidth: 1,
            }}
          >
            <CurrencyMark currency={to.currency} size={18} />
            <Text style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 14 }}>
              {to.currency}
            </Text>
          </View>
          <Text
            style={{
              flex: 1,
              textAlign: 'right',
              color: colors.text,
              fontFamily: font.displayBold,
              fontSize: 30,
              letterSpacing: -0.6,
              fontVariant: ['tabular-nums'],
            }}
          >
            {sameCurrency
              ? formatAmount(amount === '' ? '0' : amount, to.currency)
              : lands === undefined
                ? '—'
                : formatAmount(lands.receives, to.currency)}
          </Text>
        </View>
        {!sameCurrency && lands !== undefined && (
          <Text style={styles.muted}>
            1 {sendCurrency} = {lands.rate} {to.currency}
          </Text>
        )}
      </AmountCard>

      <Field
        label="Transaction PIN"
        value={pin}
        onChangeText={setPin}
        secureTextEntry
        keyboardType="number-pad"
        maxLength={12}
      />

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 7,
          marginTop: space.md,
        }}
      >
        <Icon name="zap" size={15} color={colors.text3} />
        <Text style={styles.muted}>
          {to.kind === 'xetral' ? 'Arrives instantly' : 'Usually arrives within minutes'}
        </Text>
      </View>

      <FormError error={error} code={code} />

      <Button
        label={busy ? 'Sending…' : 'Continue'}
        busy={busy}
        disabled={!enough || pin === ''}
        onPress={() => {
          void run(async () => {
            /*
             * THREE PATHS, AND THE CUSTOMER CHOSE NONE OF THEM.
             *
             * A Xetral account in the same currency is a wallet transfer; in a
             * different one it is a REMITTANCE, which converts and pays in one
             * entry rather than leaving money in a wallet the sender never
             * meant to hold. Anything else leaves through a payout. The old
             * screen made this a tab; here it follows from the recipient and
             * the currency, which is the whole of the unification.
             */
            if (to.kind === 'xetral' && sameCurrency) {
              await client.transfer({
                recipient: to.destination,
                amount,
                currency: sendCurrency,
                pin,
                idempotencyKey: key,
              });
            } else if (to.kind === 'xetral') {
              await client.remit({
                from: sendCurrency,
                to: to.currency,
                amount,
                recipient: to.destination,
                pin,
                idempotencyKey: key,
              });
            } else {
              await client.payToBank({
                country: to.country,
                bankCode: to.rail_code ?? '',
                accountNumber: to.destination,
                amount,
                currency: to.currency,
                pin,
                idempotencyKey: key,
              });
            }
            next();
            setAmount('');
            setPin('');
            onSent(`Sent to ${to.display_name}.`);
            return undefined;
          });
        }}
      />
    </Panel>
  );
}

/* --------------------------------------------------------------- the small */

/** A draft, rendered by the same component a saved recipient is. */
function toRecipient(found: RecipientResolution): Recipient {
  return {
    id: '',
    kind: found.kind,
    country: found.country,
    currency: found.currency,
    rail_code: found.rail_code,
    rail_name: found.rail_name,
    destination: found.destination,
    display_name: found.resolved_name ?? found.destination,
    resolved_name: found.resolved_name,
    last_used_at: null,
    created_at: new Date().toISOString(),
  };
}

/**
 * Initials, for the disc beside a name.
 *
 * TWO LETTERS AT MOST. A name with five words produces five letters in a
 * 42-point circle, which renders as an illegible smudge rather than as an
 * avatar — and the point of the disc is to be recognisable at a glance.
 */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** "Send GHS to Rabi" reads better than the whole legal name, and the whole
 *  name is on the header directly above it. */
function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
