import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  currencyName,
  exponentFor,
  formatAmount,
  isValidAmount,
  nationalDigits,
  networkLabel,
  phoneHint,
  sendableFor,
  symbolFor,
  SENT_TITLE,
  sentMessage,
} from '@xetral/client';
import type {
  Recipient,
  RecipientKind,
  RecipientResolution,
  XetralCountry,
} from '@xetral/client';
import { Shell } from '@/shell';
import { AmountCard, Button, Field, FormError, Loading, Panel } from '@/ui';
import { Select } from '@/select';
import { Icon } from '@/icon';
import { CurrencyMark } from '@/currency-mark';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { font, radius, space, useResolvedScheme, useStyles, useTheme } from '@/theme';
import type { Palette } from '@/theme';

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
type Step = 'who' | 'currency' | 'method' | 'details' | 'amount';

/**
 * HOW THE MONEY REACHES THEM, asked as its own step.
 *
 * IT USED TO BE A ROW IN THE NETWORK PICKER — "XETRAL" above MTN, Telecel and
 * AirtelTigo — which put two questions in one list. Choosing between "an
 * account on this app" and "a mobile money wallet" is choosing a PRODUCT;
 * choosing between MTN and Telecel is choosing a network, and collapsing them
 * made the first look like a fourth operator.
 */
type Method = 'xetral' | 'bank' | 'momo';

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
  /** How it reaches them — step three, and what the details form is FOR. */
  const [method, setMethod] = useState<Method>('xetral');

  /* WHAT WAS JUST SENT, held until the customer dismisses it. Cleared by the
     dialog's own button rather than by a timer: a confirmation that money left
     should not disappear because somebody looked away. */
  const [sent, setSent] = useState<
    { amount: string; currency: string; name: string } | undefined
  >(undefined);

  const home = session.data?.home_currency ?? 'NGN';

  const startNew = (): void => {
    setChosen(undefined);
    setDraft(undefined);
    setStep('currency');
  };

  const back = (): void => {
    if (step === 'amount') setStep('details');
    else if (step === 'details') setStep(arrivedWith === '' ? 'method' : 'who');
    else if (step === 'method') setStep('currency');
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
      overlay={
        <>
          {/*
            MONEY LEAVING DESERVES A DIALOG, not a toast that fades.

            A strip saying "Sent to Olawale" names no amount and removes
            itself after a few seconds, so a customer who looked away has no
            confirmation at all of the one action in this product that cannot
            be undone.
          */}
          {sent !== undefined && (
            <SentDialog
              amount={sent.amount}
              currency={sent.currency}
              name={sent.name}
              onClose={() => setSent(undefined)}
            />
          )}
          {/* BOTTOM RIGHT, ALWAYS — over the screen rather than at the end of
              the list, so it does not scroll away or cover the last row.
              THE WAY BACK SITS THERE TOO, on every step after the first: a
              chevron above the heading cost a band of empty space on a handset
              and sat at the one corner a thumb holding the phone cannot
              reach. */}
          {step === 'who' ? <NewRecipientPill onPress={startNew} /> : <FlowBack onPress={back} />}
        </>
      }
    >

      {step === 'who' && (
        <ChooseRecipient
          recipients={saved.data ?? []}
          home={home}
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
          onNew={startNew}
        />
      )}

      {step === 'currency' && (
        <ChooseCurrency
          home={home}
          onPick={(currency) => {
            setReceive(currency);
            setStep('method');
          }}
        />
      )}

      {step === 'method' && (
        <ChooseMethod
          receive={receive === '' ? home : receive}
          countries={countries.data ?? []}
          onPick={(picked) => {
            setMethod(picked);
            setStep('details');
          }}
        />
      )}

      {step === 'details' && (
        <RecipientDetails
          receive={receive === '' ? home : receive}
          method={method}
          countries={countries.data ?? []}
          initialDestination={arrivedWith}
          onReady={(resolution, recipient) => {
            setDraft(resolution);
            setChosen(recipient);
            /*
             * A XETRAL SEND KEEPS THE CURRENCY THE CUSTOMER CHOSE.
             *
             * The server answers a Xetral lookup with the RECIPIENT'S OWN
             * currency — a Ghanaian holds GHS — and this line overwrote the
             * answer given one step earlier on a screen headed "What currency
             * are you sending?". So somebody who chose naira and typed a
             * Ghanaian friend's number was quoted in cedis, with nothing
             * saying their choice had been discarded. A Xetral wallet is
             * multi-currency, so paying a Ghanaian in naira is an ordinary
             * transfer. Every other kind keeps the server's answer, where the
             * currency really is a fact about the destination.
             */
            setReceive(resolution.kind === 'xetral' ? receive : resolution.currency);
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
          /* WHAT THE RECIPIENT RECEIVES IS THE FLOW'S ANSWER, not the row's. */
          receiveCurrency={receive === '' ? home : receive}
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
  home,
  loading,
  onPick,
  onRemove,
  onNew,
}: {
  readonly recipients: readonly Recipient[];
  readonly home: string;
  readonly loading: boolean;
  readonly onPick: (recipient: Recipient) => void;
  readonly onRemove: (id: string) => Promise<void>;
  readonly onNew: () => void;
}) {
  const styles = useStyles();
  const sf = useSf();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<string | undefined>(undefined);
  /* THE RAIL STAYS ON ONE LINE. Five chips do not fit a 360px handset, so
     three are shown and the rest sit behind "More". */
  const [allChips, setAllChips] = useState(false);
  const CHIP_LIMIT = 3;

  /*
   * THE CHIPS ARE THE CURRENCIES THIS CUSTOMER ACTUALLY PAYS, not every
   * currency the platform offers. A filter for a currency nobody in the list
   * holds filters to nothing, which reads as a broken control rather than as
   * an empty result.
   */
  /* WHAT THIS PLATFORM CAN SEND — NGN, USD, GHS, KES and the stablecoins — not
     only the currencies already in the address book, which showed one chip to a
     customer with one payee and none to a customer with none. */
  const currencies = useMemo(() => {
    const used = new Set(recipients.map((r) => r.currency));
    const offered = sendableFor(home);
    return [...offered].sort((a, b) => {
      const byUse = Number(used.has(b)) - Number(used.has(a));
      return byUse !== 0 ? byUse : offered.indexOf(a) - offered.indexOf(b);
    });
  }, [recipients, home]);

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
          <Chip label="All" grid on={filter === ''} onPress={() => setFilter('')} />
          {(allChips ? currencies : currencies.slice(0, CHIP_LIMIT)).map((currency) => (
            <Chip
              key={currency}
              label={currency}
              currency={currency}
              on={filter === currency}
              onPress={() => setFilter(currency)}
            />
          ))}
          {!allChips && currencies.length > CHIP_LIMIT && (
            <Chip label="More" on={false} onPress={() => setAllChips(true)} />
          )}
        </ScrollView>
      )}

      {loading && recipients.length === 0 ? (
        <Loading />
      ) : recipients.length === 0 ? (
        <Text style={{ color: sf.muted, fontSize: 14, paddingVertical: 20 }}>
          Nobody here yet. Add the first person you want to pay and they stay on
          this list.
        </Text>
      ) : (
        <View>
          {/* "All recipients" — blue, per the mockup, over a hairline. */}
          <Text style={{ color: sf.accent, fontSize: 13, fontFamily: font.sansSemi, marginBottom: 8 }}>
            All recipients
          </Text>
          <View style={{ height: 1, backgroundColor: sf.divider }} />
          {shown.map((r) => (
            <View
              key={r.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
                paddingVertical: 16,
                borderBottomWidth: 1,
                borderBottomColor: sf.rowline,
              }}
            >
              <Pressable
                onPress={() => onPick(r)}
                android_ripple={null}
                accessibilityRole="button"
                accessibilityLabel={`Send to ${r.display_name}`}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14 }}
              >
                {/* 54px avatar with a 20px flag badge, bottom-left. */}
                <View style={{ width: 54, height: 54 }}>
                  <View
                    style={{
                      width: 54,
                      height: 54,
                      borderRadius: 27,
                      backgroundColor: sf.avatarBg,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: sf.avatarText, fontFamily: font.sansSemi, fontSize: 18 }}>
                      {initialsOf(r.display_name)}
                    </Text>
                  </View>
                  <View
                    style={{
                      position: 'absolute',
                      bottom: -2,
                      left: -2,
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      overflow: 'hidden',
                      borderWidth: 2,
                      borderColor: sf.bg,
                      backgroundColor: sf.bg,
                    }}
                  >
                    <CurrencyMark currency={r.currency} size={16} />
                  </View>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{ color: sf.text, fontFamily: font.sansSemi, fontSize: 15.5 }}
                    numberOfLines={1}
                  >
                    {r.display_name}
                  </Text>
                  <Text style={{ color: sf.muted, fontSize: 13 }} numberOfLines={1}>
                    {railLabelOf(r)} {'  |  '}&middot;&middot;&middot;
                    {r.destination.slice(-4)}
                  </Text>
                </View>
              </Pressable>
              {/*
                REMOVING IS BEHIND A SECOND PRESS. The three-dot menu is the
                mockup's; a destructive control beside the tap target is one
                thumb-width from deleting somebody's landlord.
              */}
              <Pressable
                onPress={() => setMenu(menu === r.id ? undefined : r.id)}
                android_ripple={null}
                accessibilityRole="button"
                accessibilityLabel={`More for ${r.display_name}`}
                hitSlop={8}
                style={{ width: 28, alignItems: 'center', gap: 3.5 }}
              >
                {[0, 1, 2].map((d) => (
                  <View
                    key={d}
                    style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: sf.dots }}
                  />
                ))}
              </Pressable>
            </View>
          ))}
          {shown.length === 0 && (
            <Text style={{ color: sf.muted, fontSize: 14, paddingVertical: 20 }}>
              Nobody on this list matches that.
            </Text>
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

    </Panel>
  );
}

/** A currency filter. A `Pressable` rather than `Segmented`, because the list
 *  is as long as the customer's own address book rather than two fixed halves. */
function Chip({
  label,
  currency,
  grid = false,
  on,
  onPress,
}: {
  readonly label: string;
  readonly currency?: string;
  readonly grid?: boolean;
  readonly on: boolean;
  readonly onPress: () => void;
}) {
  const sf = useSf();
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
        height: 38,
        paddingHorizontal: 14,
        borderRadius: 10,
        // The mockup's chip: a BLUE OUTLINE when selected, never a filled pill.
        backgroundColor: sf.chipBg,
        borderColor: on ? sf.accent : sf.chipBorder,
        borderWidth: on ? 2 : 1.5,
      }}
    >
      {grid && (
        <View style={{ width: 14, height: 14, flexDirection: 'row', flexWrap: 'wrap', gap: 3 }}>
          {[0, 1, 2, 3].map((d) => (
            <View
              key={d}
              style={{
                width: 5.5,
                height: 5.5,
                borderRadius: 1.2,
                backgroundColor: on ? sf.accent : sf.chipText,
              }}
            />
          ))}
        </View>
      )}
      {currency !== undefined && (
        <View style={{ width: 18, height: 18, borderRadius: 9, overflow: 'hidden' }}>
          <CurrencyMark currency={currency} size={18} />
        </View>
      )}
      <Text
        style={{
          color: on ? sf.accent : sf.chipText,
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
  const sfEmpty = useSf();
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

  /*
   * FAVOURITES ARE THE FOUR THIS PLATFORM OPERATES IN, in that order.
   *
   * The narrower rule put ONE row above the fold for a Nigerian and made every
   * corridor this product exists for — NGN to GHS, NGN to KES — something to
   * be found by scrolling the alphabetical tail. `sendableFor` still decides
   * what is offered; this only decides the order.
   */
  const FAVOURITE_ORDER = ['NGN', 'GHS', 'KES', 'USD'];
  const favourites = [...all]
    .filter((c) => FAVOURITE_ORDER.includes(c) && matches(c))
    .sort((a, b) => FAVOURITE_ORDER.indexOf(a) - FAVOURITE_ORDER.indexOf(b));
  const stablecoins = all.filter((c) => (c === 'USDT' || c === 'USDC') && matches(c));
  const rest = all
    .filter((c) => !favourites.includes(c) && !stablecoins.includes(c) && matches(c))
    .sort((a, b) => currencyName(a).localeCompare(currencyName(b)));

  /* The alphabetical tail is grouped by letter, per the mockup (…B, C…). */
  const letters = new Map<string, string[]>();
  for (const code of rest) {
    const letter = currencyName(code).charAt(0).toUpperCase();
    (letters.get(letter) ?? letters.set(letter, []).get(letter)!).push(code);
  }

  return (
    <Panel bare title="What currency are you sending?">
      <SearchField value={query} onChange={setQuery} placeholder="Search currency or country" />

      <CurrencyGroup heading="Favorites" codes={favourites} onPick={onPick} />
      <CurrencyGroup heading="Stablecoins" codes={stablecoins} onPick={onPick} />
      {[...letters.entries()].map(([letter, codes]) => (
        <CurrencyGroup key={letter} heading={letter} codes={codes} onPick={onPick} />
      ))}

      {favourites.length + stablecoins.length + rest.length === 0 && (
        <Text style={{ color: sfEmpty.muted, fontSize: 14, paddingVertical: 20 }}>
          No currency matches that.
        </Text>
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
  const sf = useSf();
  if (codes.length === 0) return null;
  return (
    <View style={{ marginTop: 18 }}>
      {/* Section label over a hairline, per the mockup. */}
      <Text style={{ color: sf.section, fontFamily: font.sansSemi, fontSize: 13, marginBottom: 8 }}>
        {heading}
      </Text>
      <View style={{ height: 1, backgroundColor: sf.divider, marginBottom: 6 }} />
      {codes.map((code) => (
        <Pressable
          key={code}
          onPress={() => onPick(code)}
          android_ripple={null}
          accessibilityRole="button"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 7 }}
        >
          {/* 38, not 44. At the larger size the discs dominated a list read by
              its NAMES, and four of them filled a handset screen before the
              first divider. */}
          <View style={{ width: 38, height: 38, borderRadius: 19, overflow: 'hidden' }}>
            <CurrencyMark currency={code} size={38} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: sf.text, fontFamily: font.sansSemi, fontSize: 15.5 }}>
              {currencyName(code)}
            </Text>
            <Text style={{ color: sf.muted, fontSize: 13, marginTop: 2 }}>
              {code} ({symbolFor(code)})
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------ step 2 and a half */

/**
 * WHAT THIS PLATFORM CAN ACTUALLY DELIVER, per country.
 *
 * A XETRAL ACCOUNT IS ALWAYS ONE OF THEM — it is a transfer between two
 * balances here rather than a rail at all. The other two come from
 * `countries.payout_method`, and that is why a country offers ONE of them:
 * 046 put that column there so the screen would stop offering a product the
 * customer's money cannot reach, and 067 made the SERVER read the same row —
 * the destination is normalised as a phone number where it says
 * `mobile_money` and left as typed where it says `bank`. Offering both in
 * Ghana would send a bank account number down a path that normalises it as an
 * MTN wallet, in the direction that cannot be recalled.
 */
function methodsFor(country: XetralCountry | undefined): readonly Method[] {
  if (country === undefined) return ['xetral'];

  /*
   * READ FROM `payout_methods`, WHICH IS A SET SINCE 070.
   *
   * It was `payout_method`, one value, so a country offered a wallet OR a
   * bank and never both — and in Ghana and Kenya it is both: most people are
   * paid into an MTN or M-PESA wallet, plenty into a bank account. Widening
   * the screen alone would have been worse than the gap: the SERVER
   * normalised the destination by that same single value, so a bank account
   * number typed on a country marked `mobile_money` was rewritten as a phone
   * number and sent to a wallet nobody holds. 070 made the column a set and
   * the request carry which one, so both halves now agree.
   *
   * ORDERED BY THE COUNTRY'S OWN DEFAULT, so the rail most people there use
   * is the first row rather than whichever happens to sort first.
   */
  const offered = country.payout_methods ?? [country.payout_method];
  const rails: Method[] = [];
  for (const rail of offered) {
    if (rail === 'mobile_money') rails.push('momo');
    else if (rail === 'bank') rails.push('bank');
  }
  const opensOn: Method = country.payout_method === 'mobile_money' ? 'momo' : 'bank';
  rails.sort((a, b) => Number(b === opensOn) - Number(a === opensOn));

  /* XETRAL LAST RATHER THAN FIRST, deliberately: a customer who came here to
     pay a bank or a wallet should not have to read past an option about this
     app. It is never absent, because a transfer between two balances here is
     not a rail and is always available. */
  return [...rails, 'xetral'];
}

const METHOD_COPY: Readonly<Record<Method, { title: string; sub: string }>> = {
  bank: {
    title: 'Send via bank transfer',
    sub: 'Use bank transfer to send money to a previous or new recipient',
  },
  momo: { title: 'Send via Mobile Money', sub: 'Send to a mobile money wallet instantly' },
  xetral: {
    title: 'Send to a Xetral user',
    sub: 'Instant and free, straight to their Xetral balance',
  },
};

/**
 * How the money reaches them.
 *
 * SKIPPED WHERE THERE IS ONE ANSWER. A screen offering a single option is a
 * tap that asks nothing, so a currency with one deliverable method goes
 * straight on to the details.
 */
function ChooseMethod({
  receive,
  countries,
  onPick,
}: {
  readonly receive: string;
  readonly countries: readonly XetralCountry[];
  readonly onPick: (method: Method) => void;
}) {
  const sf = useSf();
  const country = countries.find((c) => c.currency === receive);
  const methods = methodsFor(country);

  useEffect(() => {
    if (methods.length === 1 && methods[0] !== undefined) onPick(methods[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receive]);
  if (methods.length === 1) return null;

  return (
    <Panel bare title={`How do you want to send ${receive}?`}>
      <View style={{ marginTop: 4 }}>
        {methods.map((method) => (
          <Pressable
            key={method}
            onPress={() => onPick(method)}
            android_ripple={null}
            accessibilityRole="button"
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 14,
              paddingVertical: 14,
            }}
          >
            <View
              style={{
                width: 46,
                height: 46,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                /* A TINT of the accent rather than the accent: the mark
                   identifies the row, it does not compete with the primary
                   button. Written as an alpha suffix because React Native has
                   no `color-mix`. */
                backgroundColor: `${sf.accent}1F`,
              }}
            >
              <Icon
                name={method === 'bank' ? 'bank' : method === 'momo' ? 'phone' : 'send'}
                size={22}
                color={sf.accent}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <Text style={{ color: sf.text, fontFamily: font.sansSemi, fontSize: 15.5 }}>
                {METHOD_COPY[method].title}
              </Text>
              <Text style={{ color: sf.muted, fontSize: 13.5, lineHeight: 19 }}>
                {METHOD_COPY[method].sub}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
    </Panel>
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
 * number whose owner Flutterwave will name was reported as unfindable.
 *
 * AND WHERE THE RAIL *CAN* ANSWER, SILENCE IS A REFUSAL. `name_status` tells
 * the two apart: `unavailable` means no name enquiry EXISTS — Kenya's M-PESA,
 * 067's rule — and the send goes on, because demanding a claim that cannot
 * exist is an outage rather than a control. `failed` means one exists and did
 * not answer, which on a Ghanaian wallet means the number is wrong or the
 * wallet is dead, and momo is unrecoverable once sent.
 *
 * THE DIALLING CODE IS DRAWN, NOT TYPED. The currency step already fixed the
 * country, so the field shows `+233` and holds the national digits, with the
 * trunk zero taken off as it is typed.
 */
function RecipientDetails({
  receive,
  method,
  countries,
  initialDestination,
  onReady,
}: {
  readonly receive: string;
  /** Decided one step earlier. It is what this form is FOR, so nothing here
   *  re-derives it from a row in the rail picker. */
  readonly method: Method;
  readonly countries: readonly XetralCountry[];
  readonly initialDestination: string;
  readonly onReady: (resolution: RecipientResolution, saved: Recipient | undefined) => void;
}) {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const sf = useSf();
  const { busy, error, code, run } = useSubmit();

  const country = countries.find((c) => c.currency === receive);
  /* A XETRAL SEND HAS NO RAIL TO PICK. Where there is one it starts empty: a
     default network is a network somebody sends to without choosing it. */
  const [rail, setRail] = useState(method === 'xetral' ? 'xetral' : '');
  const [destination, setDestination] = useState(nationalDigits(initialDestination));
  const [found, setFound] = useState<RecipientResolution | undefined>(undefined);
  /* GHANA REFUSES A BANK TRANSFER WITHOUT A BRANCH CODE. Nowhere else asks,
     so the picker exists only when the server answers with branches. */
  const [branch, setBranch] = useState('');

  const banks = useLoad(
    /* THE CATALOGUE FOR THE RAIL THE CUSTOMER CHOSE. A country offering both
       (070) has two, and they are not interchangeable — an MTN network code is
       not a bank code. */
    async () =>
      country === undefined || method === 'xetral'
        ? []
        : client.payoutBanks(country.code, method === 'momo' ? 'mobile_money' : 'bank'),
    [country?.code, method],
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
  /*
   * THE PICKER ASKS ONE QUESTION NOW. `XETRAL` used to sit in this list above
   * MTN, Telecel and AirtelTigo, so choosing a PRODUCT and choosing a NETWORK
   * came from the same control and the Xetral account read as a fourth
   * operator. The method step asks that first; this list is only networks, or
   * only banks.
   */
  const isMomoCountry = method === 'momo';
  const rails = (banks.data ?? []).map((bank) => ({
    value: bank.code,
    label: isMomoCountry ? networkLabel(bank.code, bank.name) : bank.name,
  }));

  const railLabel = rails.find((r) => r.value === rail)?.label;
  const kind: RecipientKind = method;

  /*
   * THE BRANCHES OF THE CHOSEN BANK, and an empty list is the common answer.
   * Flutterwave refuses a Ghanaian transfer without a branch code; the SERVER
   * decides which corridors need one, so this screen draws a picker when
   * something comes back and nothing when it does not.
   */
  const branches = useLoad(
    async () =>
      country === undefined || method !== 'bank' || rail === ''
        ? []
        : client.payoutBranches(country.code, rail),
    [country?.code, method, rail],
  );
  const needsBranch = (branches.data ?? []).length > 0;
  /* Nothing to choose on a Xetral send. */
  const needsRail = method !== 'xetral';

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

  /*
   * A DIAL PREFIX NEEDS A COUNTRY, and USD, USDT and USDC belong to none. A
   * Xetral send in one of those falls back to a plain field where the number
   * is typed whole, rather than a `+` with nothing after it.
   */
  const dialCode = (country?.dial_code ?? '').replace(/[^0-9]/g, '');
  const isPhone = kind !== 'bank' && dialCode !== '';

  /*
   * WHETHER THE NAME IS A GATE, decided by whether one could ever have come.
   * `failed` is the only blocking answer, and only a rail that HAS a name
   * enquiry can give it.
   */
  const blocked = found?.name_status === 'failed';

  /**
   * Ask the server who holds this destination.
   *
   * IT ALWAYS ANSWERS — the resolve path does not throw on a rail that cannot
   * name a holder — so what comes back carries `name_status` and this screen
   * decides. A Xetral number belonging to nobody still 404s, which is the one
   * refusal here that is not about a name.
   */
  async function doResolve(): Promise<RecipientResolution> {
    return client.resolveRecipient({
      kind,
      /* THE COUNTRY GOES EVEN ON THE XETRAL BRANCH — a national number has no
         country in it, and leaving it off is what made `08031234567` resolve
         to nobody. The currency step fixed one, so the server normalises
         through THAT country's dial code, not the sender's. */
      ...(country === undefined ? {} : { country: country.code }),
      ...(kind === 'xetral' ? {} : { railCode: rail }),
      ...(branch === '' ? {} : { branchCode: branch }),
      destination,
    });
  }

  /**
   * Ask the rail as soon as the field is left, so the holder's name is on
   * screen before the button is pressed — and so a number that cannot be
   * verified says so while the customer is still looking at the digits.
   */
  function askTheRail(): void {
    if ((needsRail && rail === '') || !enough) return;
    void run(async () => {
      setFound(await doResolve());
      return undefined;
    });
  }

  async function proceed(resolution: RecipientResolution): Promise<void> {
    /* SAVING IS BEST-EFFORT AND NEVER GATES THE SEND. The recipient book fills
       from paying people; a save that fails must not strand a one-off send. */
    let saved: Recipient | undefined;
    try {
      saved = await client.saveRecipient({
        kind: resolution.kind,
        ...(resolution.country === '' ? {} : { country: resolution.country }),
        ...(resolution.rail_code === null ? {} : { railCode: resolution.rail_code }),
        ...(resolution.branch_code === null ? {} : { branchCode: resolution.branch_code }),
        destination: resolution.destination,
        ...(resolution.resolved_name === null
          ? { label: destination.replace(/[^0-9]/g, '') }
          : {}),
      });
    } catch {
      saved = undefined;
    }
    onReady(resolution, saved);
  }

  return (
    <Panel
      bare
      title="Who are you sending to?"
      subtitle={
        method === 'xetral'
          ? 'Their Xetral phone number — the money arrives instantly'
          : method === 'momo'
            ? 'Fill in the mobile money details of your recipient'
            : 'Fill in the bank details of your recipient'
      }
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

      {needsRail && (
        <Select
          label={isMomoCountry ? 'Network' : 'Bank'}
          value={rail}
          onChange={(next) => {
            setRail(next);
            setFound(undefined);
            /* A BRANCH BELONGS TO A BANK. Keeping the old one would send to a
               branch of a different bank, which the rail refuses in a sentence
               about the account. */
            setBranch('');
          }}
          options={rails}
          placeholder={isMomoCountry ? 'Network' : 'Bank'}
          searchable={rails.length > 6}
          searchPlaceholder="Search…"
        />
      )}

      {/* ONLY WHERE THE RAIL ASKS. Ghana refuses a transfer without a branch;
          every other corridor answers an empty list and this is not drawn. */}
      {needsBranch && (
        <Select
          label="Branch"
          value={branch}
          onChange={setBranch}
          options={(branches.data ?? []).map((b) => ({ value: b.code, label: b.name }))}
          placeholder="Branch"
          searchable={(branches.data ?? []).length > 6}
          searchPlaceholder="Search…"
        />
      )}

      {isPhone ? (
        <View>
          <Text style={styles.label}>{numberLabel}</Text>
          {/*
            THE COUNTRY CODE IS A LABEL AND THE BOX HOLDS THE REST. One place a
            country is stated — 040's rule that a second picker lets somebody
            select Ghana and +234 — and it comes off the country the currency
            step already fixed.
          */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: colors.field,
              borderRadius: radius.md,
              overflow: 'hidden',
              marginBottom: space.md,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingLeft: 15,
                paddingRight: 12,
                paddingVertical: 14,
                borderRightWidth: 1,
                borderRightColor: sf.dialLine,
              }}
            >
              <Text style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 14.5 }}>
                +{dialCode}
              </Text>
              <Text style={{ color: sf.label, fontSize: 14.5 }}>{country?.name ?? ''}</Text>
            </View>
            <TextInput
              value={destination}
              onChangeText={(next) => {
                setDestination(nationalDigits(next));
                setFound(undefined);
              }}
              onBlur={askTheRail}
              keyboardType="number-pad"
              placeholder={phoneHint(country?.dial_code)}
              placeholderTextColor={sf.placeholder}
              accessibilityLabel={numberLabel}
              style={{
                flex: 1,
                paddingHorizontal: 14,
                paddingVertical: 14,
                color: colors.text,
                fontFamily: font.sans,
                fontSize: 15,
              }}
            />
          </View>
        </View>
      ) : (
        <Field
          label={numberLabel}
          value={destination}
          onChangeText={(next) => {
            setDestination(next.replace(/[^0-9]/g, ''));
            setFound(undefined);
          }}
          onBlur={askTheRail}
          keyboardType="number-pad"
          placeholder={kind === 'bank' ? '0123456789' : '+234 803 123 4567'}
          autoComplete="off"
        />
      )}

      {/* THE NAME, THE MOMENT IT ARRIVES — the rail's own answer, and the only
          thing on this screen presented as confirmation. A name the SENDER
          typed shown here would be a confirmation screen that confirms nothing
          while looking exactly like one (043). */}
      {found?.resolved_name != null && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginTop: -4,
            marginBottom: 12,
          }}
        >
          <Icon name="check" size={16} color={colors.ok} />
          <Text style={{ color: colors.ok, fontFamily: font.sansSemi, fontSize: 13.5, flex: 1 }}>
            {found.resolved_name}
          </Text>
        </View>
      )}

      {/* A RAIL THAT CAN NAME A HOLDER AND DID NOT IS A STOP, not a warning.
          Kenya has no name enquiry at all, so nothing is said and nothing is
          blocked there. */}
      {blocked && (
        <Text style={{ color: colors.danger, fontSize: 12.5, marginTop: -4, marginBottom: 12 }}>
          We could not verify this {railLabel ?? 'account'} number. Check the digits with your
          recipient — we will not send to a number nobody answers for.
        </Text>
      )}

      <FormError error={error} code={code} />

      <Button
        label={
          busy
            ? 'Checking…'
            : blocked
              ? 'Number not verified'
              : found !== undefined
                ? 'Continue'
                : 'Check details'
        }
        busy={busy}
        disabled={(needsRail && rail === '') || (needsBranch && branch === '') || !enough || blocked}
        onPress={() => {
          if ((needsRail && rail === '') || (needsBranch && branch === '') || !enough || blocked)
            return;
          void run(async () => {
            /*
             * THE NAME IS SHOWN BEFORE THE MONEY MOVES, wherever one exists.
             * A rail that cannot name a holder — Kenya — proceeds in one
             * press, because there is nothing to confirm. A rail that can and
             * did not answer stops here.
             */
            const resolution = found ?? (await doResolve());
            setFound(resolution);
            if (resolution.name_status === 'failed') return undefined;
            if (found !== undefined || resolution.name_status === 'unavailable') {
              await proceed(resolution);
            }
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
  receiveCurrency,
  balances,
  home,
  onSent,
}: {
  readonly to: Recipient;
  /** What the recipient RECEIVES, as the flow decided it — not as the row
   *  records it. A Xetral account holds its own country's money and the
   *  customer may have chosen to send something else. */
  readonly receiveCurrency: string;
  readonly balances: readonly { currency: string; spendable: string }[];
  readonly home: string;
  /* WHAT LEFT AND WHO GOT IT, because the confirmation names both. */
  readonly onSent: (sent: { amount: string; currency: string; name: string }) => void;
}) {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const sf = useSf();
  const { busy, error, code, run } = useSubmit();
  const { key, next } = useIdempotencyKey();

  /*
   * A PAYOUT CARRIES ONE CURRENCY, AND THIS SCREEN USED TO SEND IT TWO.
   *
   * THE BUG, WHICH WAS WORSE THAN THE REFUSAL IT PRODUCED. `payToBank` was
   * called with `amount` — the figure the customer TYPED, in the currency
   * they were sending — and `currency: lands_in`, the currency it LANDS in.
   * Those describe different things, and `/v1/payouts` performs no
   * conversion: it debits `walletAccount(user, currency)` by that amount.
   *
   * So a Ghanaian with ₵8.32 asking to send 2 cedis to a Nigerian bank had
   * ₦2 requested from a naira wallet holding nothing, and read "Your balance
   * will not cover this" beside a balance that plainly covered it. THE
   * DANGEROUS HALF IS THE OTHER CUSTOMER: somebody who DOES hold naira would
   * have had the request succeed and ₦2 leave, where the screen had just
   * promised ₦235.01. A wrong amount actually leaving is worse than a
   * refusal, and nothing in the ledger would have been unbalanced by it.
   *
   * THE CURRENCY IS THEREFORE FIXED FOR A PAYOUT, not corrected at the call
   * site. A bank account or a wallet receives exactly one currency, so the
   * send currency IS the payout currency — there is no second one for the
   * two to disagree about. Converting first is a separate, deliberate act on
   * the Convert screen, which is where a customer can see the rate they are
   * accepting rather than having one applied inside a send.
   *
   * A XETRAL RECIPIENT IS UNCHANGED and keeps the picker: a different
   * currency there is a REMITTANCE, which converts and pays in ONE entry —
   * 008's rule — so the two currencies are the point rather than a mismatch.
   */
  const [sendCurrency, setSendCurrency] = useState(
    to.kind === 'xetral' ? home : receiveCurrency,
  );
  const currencyIsFixed = to.kind !== 'xetral';
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');

  /*
   * WHAT LANDS IS `receiveCurrency`, NOT `to.currency`, ON EVERY LINE BELOW.
   *
   * The row records what a Xetral recipient's own country uses; the flow
   * records what the customer chose on the screen headed "What currency are
   * you sending?". Reading the row is what made a naira send to a Ghanaian
   * friend quote in cedis.
   */
  const lands_in = receiveCurrency;
  const balance = balances.find((b) => b.currency === sendCurrency)?.spendable ?? '0';
  const sameCurrency = sendCurrency === lands_in;

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
      const got = await client.fxQuote(sendCurrency, lands_in, amount);
      return { forAmount: amount, ...got };
    },
    [sendCurrency, lands_in, amount, sameCurrency],
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

  /* THE GAP BETWEEN A VALID AMOUNT AND ITS RATE, which is the only moment the
     receiving box has nothing true to show. Saying "Converting…" there is the
     difference between a screen that is working and one that is refusing — a
     zero beside a typed amount reads as "this corridor pays nothing". */
  const converting = !sameCurrency && enough && lands === undefined && quote.code === undefined;
  /*
   * BELOW THE CORRIDOR'S FLOOR, and it only counts once something was typed.
   *
   * `useLoad` keeps the last error while the next request is in flight, so
   * gating on the amount being non-empty is what stops a stale refusal
   * describing a box the customer has since cleared — the same reason the
   * quote itself is stamped with `forAmount`.
   */
  const belowMinimum = amount !== '' && enough && quote.code === 'below_minimum';

  /* A text-field-sized box, not a card: 56px, flat, one line. */
  const amountBox = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    gap: 12,
    height: 56,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: colors.field,
  };

  return (
    <Panel bare>
      {/* WHO IS BEING PAID — the rail's own answer for the name where there
          is one, and the number only when there is not. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: sf.avatarBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: sf.avatarText, fontFamily: font.sansSemi, fontSize: 15 }}>
            {initialsOf(to.display_name)}
          </Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: sf.text, fontFamily: font.sansSemi, fontSize: 16 }} numberOfLines={1}>
            {to.display_name}
          </Text>
          <Text style={{ color: sf.muted, fontSize: 13, marginTop: 2 }} numberOfLines={1}>
            {railLabelOf(to)} &middot; {to.destination}
          </Text>
        </View>
      </View>

      {/* ONE STRAIGHT FIELD PER AMOUNT: the figure on the left, the currency on
          the right, and what it means in small text under it. */}
      <Text style={{ color: sf.muted, fontSize: 13, marginBottom: 6 }}>You send</Text>
      <View style={[amountBox, amount !== '' && !enough ? { borderColor: colors.danger, borderWidth: 1.5 } : null]}>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor={sf.muted}
          accessibilityLabel="Amount to send"
          style={{
            flex: 1,
            color: sf.text,
            fontFamily: font.sansSemi,
            /* SLIGHTLY SMALLER AND LIGHTER. At 20 the figure was the loudest
               thing on the screen and crowded the currency beside it. */
            fontSize: 18,
            letterSpacing: -0.2,
            fontVariant: ['tabular-nums'],
            padding: 0,
          }}
        />
        {/* STATED, NOT OFFERED, where the rail decides it. A picker whose
            only valid answer is the one already shown is a control that can
            only be got wrong — and getting it wrong here sent two different
            sums of money in one request. */}
        {currencyIsFixed ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <CurrencyMark currency={sendCurrency} size={18} />
            <Text style={{ color: sf.text, fontFamily: font.sansSemi, fontSize: 15 }}>
              {sendCurrency}
            </Text>
          </View>
        ) : (
          <Select
            /* NOT EMPTY, even though the pill draws no caption: this string is
               the sheet's own heading and the screen reader's label. */
            label="Currency you send"
            variant="pill"
            value={sendCurrency}
            onChange={setSendCurrency}
            options={balances.map((b) => ({ value: b.currency, label: b.currency }))}
            renderMark={(value) => <CurrencyMark currency={value} size={18} />}
          />
        )}
      </View>
      {/* GREEN, because it is what the customer HAS — the only figure on this
          screen that is neither leaving nor landing, and without a colour it
          reads as a third amount. */}
      {/*
        THREE THINGS CAN GO UNDER THE BOX, AND ONLY ONE AT A TIME.

        THE MINIMUM IS SHOWN ONLY ONCE A CUSTOMER HAS TYPED LESS THAN IT. A
        corridor's floor printed on an empty field is noise on every send;
        printed the moment somebody asks for 2 cedis it is the one sentence
        that gets them to a working amount. Before this the refusal reached
        the screen as nothing at all.
      */}
      <Text
        style={{
          color: (amount !== '' && !enough) || belowMinimum ? colors.danger : colors.ok,
          fontFamily: (amount !== '' && !enough) || belowMinimum ? font.sans : font.sansSemi,
          fontSize: 12.5,
          marginTop: 6,
        }}
      >
        {amount !== '' && !enough
          ? `Enter an amount in ${sendCurrency}.`
          : belowMinimum
            ? quote.error
            : `Balance: ${formatAmount(balance, sendCurrency)}`}
      </Text>

      {/* THE LABEL BELONGS TO ITS BOX — 6px to the box below it, 14px to the
          note above. The web needed a wrapper for this because its form is a
          grid with a gap; here the margins are the whole spacing, so the same
          rhythm is written out directly. */}
      <Text style={{ color: sf.muted, fontSize: 13, marginTop: 14, marginBottom: 6 }}>
        {firstNameOf(to.display_name)} receives
      </Text>
      <View style={amountBox}>
        {/*
         * A FIGURE, NEVER A DASH AND NEVER A STALE ZERO.
         *
         * The conversion is automatic: type 100 naira and the cedi figure
         * follows as soon as the quote lands. What it must not do is sit at
         * zero in the gap — that reads as a claim about what the corridor
         * pays. The currency's own SYMBOL comes from `formatAmount`, so a cedi
         * renders ₵ rather than a code beside a ₦ figure.
         */}
        <Text
          style={{
            flex: 1,
            color: converting ? sf.muted : sf.text,
            fontFamily: converting ? font.sans : font.sansSemi,
            fontSize: converting ? 14.5 : 18,
            letterSpacing: converting ? 0 : -0.2,
            fontVariant: ['tabular-nums'],
          }}
        >
          {converting
            ? 'Converting…'
            : sameCurrency
              ? formatAmount(amount === '' ? '0' : amount, lands_in)
              : formatAmount(lands?.receives ?? '0', lands_in)}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <CurrencyMark currency={lands_in} size={18} />
          <Text style={{ color: sf.text, fontFamily: font.sansSemi, fontSize: 14.5 }}>
            {lands_in}
          </Text>
        </View>
      </View>
      {/* DIRECTLY UNDER THE BOX — one line saying when it lands, which is what
          the footer used to repeat further down the screen. */}
      <Text
        style={{
          color: quote.code === 'pair_not_supported' ? colors.danger : sf.muted,
          fontSize: 12.5,
          marginTop: 6,
          marginBottom: 16,
        }}
      >
        {!sameCurrency && lands !== undefined
          ? `1 ${sendCurrency} = ${formatAmount(lands.rate, lands_in)}`
          : !sameCurrency && quote.code === 'pair_not_supported'
            ? `We cannot convert ${sendCurrency} to ${lands_in} yet`
            : to.kind === 'xetral'
              ? 'Arrives instantly'
              : 'Usually arrives within minutes'}
      </Text>

      <Field
        label="Transaction PIN"
        value={pin}
        onChangeText={setPin}
        secureTextEntry
        keyboardType="number-pad"
        maxLength={12}
      />

      <FormError error={error} code={code} />

      <Button
        label={busy ? 'Sending…' : 'Continue'}
        busy={busy}
        /* Refused while the amount is below the floor: the note above says
           what the minimum is, and letting this through would spend a PIN
           attempt to be told the same thing by the server. */
        disabled={!enough || belowMinimum || pin === ''}
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
                to: lands_in,
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
                /* WHICH RAIL, from the recipient's own kind rather than from the
                   country's default. Ghana and Kenya offer both since 070, and the
                   server normalises the destination by this — a wallet number to
                   E.164, a bank account exactly as typed. */
                  method: to.kind === 'momo' ? 'mobile_money' : 'bank',
                /* OFF THE SAVED ROW: a recipient is tapped without re-reading,
                   and the screen that picks a branch is the one that skips. */
                ...(to.branch_code === null ? {} : { branchCode: to.branch_code }),
                amount,
                /* THE CURRENCY THE AMOUNT IS IN, which for a payout is fixed
                   to the recipient's own — see `currencyIsFixed` above. It used
                   to be `lands_in` while `amount` was the send currency's
                   figure, which is a request describing two different sums. */
                currency: sendCurrency,
                pin,
                idempotencyKey: key,
              });
            }
            next();
            setAmount('');
            setPin('');
            onSent({ amount, currency: sendCurrency, name: to.display_name });
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
    branch_code: found.branch_code,
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

/**
 * The Send flow's own palette.
 *
 * The mockups are LIGHT and literal, and painting those hexes unconditionally
 * is what left a white screen sitting inside a dark app. Light resolves to the
 * mockup's own values; dark resolves to the app's ground, so the step is a
 * full page in either theme rather than a white box in one of them.
 */
type SfPalette = {
  readonly text: string; readonly muted: string; readonly section: string;
  readonly divider: string; readonly rowline: string;
  readonly accent: string; readonly onAccent: string;
  readonly chipBg: string; readonly chipBorder: string; readonly chipText: string;
  readonly avatarBg: string; readonly avatarText: string; readonly dots: string;
  readonly bg: string;
  readonly label: string; readonly placeholder: string; readonly field: string;
  readonly dialLine: string;
};
function useSf(): SfPalette {
  const c: Palette = useTheme();
  const light = useResolvedScheme() === 'light';
  return {
    text: light ? '#111111' : c.text,
    muted: light ? '#9AA5B4' : c.text3,
    section: light ? '#7B8FA1' : c.text2,
    divider: light ? '#E8EAED' : c.line,
    rowline: light ? '#F0F2F5' : c.line,
    accent: light ? '#3B6FE8' : '#5B8CFF',
    onAccent: light ? '#FFFFFF' : '#0B1020',
    chipBg: light ? '#FFFFFF' : 'transparent',
    chipBorder: light ? '#D8DCE4' : c.lineStrong,
    chipText: light ? '#2A2E3E' : c.text,
    avatarBg: light ? '#ECEEF3' : c.surface2,
    avatarText: light ? '#8E939F' : c.text2,
    dots: light ? '#B0B8C4' : c.text3,
    bg: light ? '#FFFFFF' : c.bg,
    label: light ? '#888888' : c.text2,
    placeholder: light ? '#B2BCC8' : c.text3,
    field: light ? '#E8E8E8' : c.field,
    /* THE DIAL PREFIX'S HAIRLINE. The divider grey is the same colour as the
       field, so the rule was there and invisible and the prefix read as one
       run of text with the number. */
    dialLine: light ? '#CFD3D9' : c.lineStrong,
  };
}

/** The rail as it should READ on a row: "MTN", not "MTN Mobile Money". */
function railLabelOf(to: Recipient): string {
  if (to.kind === 'xetral') return 'XETRAL';
  return networkLabel(to.rail_code, to.rail_name ?? 'XETRAL');
}

/** The New-recipient pill, fixed to the bottom-right of the screen. */
/**
 * THE WAY BACK, at the bottom right of every step but the first.
 *
 * It was a chevron at the TOP LEFT, which cost a band of empty space above the
 * heading and sat at the one corner a thumb holding the phone cannot reach.
 * QUIET rather than accent-filled: it is the way out of a step, and the
 * primary button is the one thing on the screen that may be blue.
 */
/**
 * QUIET IS NOT THE SAME AS INVISIBLE, and this was the second.
 *
 * It was `sf.field` — #E8E8E8 in light — with a 12% shadow, on a near-white
 * ground. On a SHORT step like "How do you want to send GHS?" there is no
 * content anywhere near it, so a pale pill floating in a field of white read
 * as nothing being there at all. The same fault, and the same fix, as the
 * web's `.sf-flow-back`: a control that floats has no container to belong to,
 * so it needs its own edge.
 *
 * `surfaceRaised` is the token whose documented purpose is what floats, and
 * `lineStrong` draws the edge in both themes.
 */
/**
 * THE SENT CONFIRMATION, and it is a real `Modal` for the reason every picker
 * on this platform already is: it is bounded by the screen and cannot be
 * scrolled away from, which is exactly what a confirmation of money leaving
 * has to be.
 *
 * The wording comes from `@xetral/client` so the phone and the web cannot
 * drift on what a successful send says — the rule `formatReceipt` follows,
 * because this is the sentence a customer screenshots.
 */
function SentDialog({
  amount,
  currency,
  name,
  onClose,
}: {
  readonly amount: string;
  readonly currency: string;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const c: Palette = useTheme();
  const sf = useSf();
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(6,8,15,0.52)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: 380,
            alignItems: 'center',
            paddingHorizontal: 24,
            paddingTop: 28,
            paddingBottom: 20,
            borderRadius: 20,
            backgroundColor: c.surfaceRaised,
          }}
        >
          {/* THE EMOJI IS IN THE TITLE, and only there — it was drawn twice,
              once large above the heading and once inside `SENT_TITLE`. It is
              also the whole illustration: a tick in a green circle is the same
              idea drawn worse and needs an asset per theme. */}
          <Text
            style={{
              marginTop: 0,
              color: sf.text,
              fontFamily: font.sansSemi,
              fontSize: 19,
              textAlign: 'center',
            }}
          >
            {SENT_TITLE}
          </Text>
          <Text
            style={{
              marginTop: 8,
              marginBottom: 18,
              color: sf.muted,
              fontFamily: font.sans,
              fontSize: 14.5,
              lineHeight: 21,
              textAlign: 'center',
            }}
          >
            {sentMessage(amount, currency, name)}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            android_ripple={null}
            style={{
              width: '100%',
              minHeight: 48,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 999,
              backgroundColor: sf.accent,
            }}
          >
            <Text style={{ color: sf.onAccent, fontFamily: font.sansSemi, fontSize: 15 }}>OK</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function FlowBack({ onPress }: { readonly onPress: () => void }) {
  const c: Palette = useTheme();
  const sf = useSf();
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={null}
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={{
        position: 'absolute',
        right: 20,
        bottom: 58 + 12 + insets.bottom,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: c.surfaceRaised,
        borderWidth: 1,
        borderColor: c.lineStrong,
        borderRadius: 50,
        paddingVertical: 11,
        paddingHorizontal: 18,
        shadowColor: '#000000',
        shadowOpacity: 0.16,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 6 },
        elevation: 6,
      }}
    >
      <Icon name="chevronLeft" size={16} color={sf.text} />
      <Text style={{ color: sf.text, fontFamily: font.sansSemi, fontSize: 14 }}>Back</Text>
    </Pressable>
  );
}

function NewRecipientPill({ onPress }: { readonly onPress: () => void }) {
  const sf = useSf();
  /* JUST ABOVE THE TAB BAR. The overlay is a sibling of the bar inside the
     Shell's root, so `bottom: 24` sat ON it — the bar is ~58px plus the home
     indicator. */
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={null}
      accessibilityRole="button"
      accessibilityLabel="New recipient"
      style={{
        position: 'absolute',
        right: 20,
        bottom: 58 + 12 + insets.bottom,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: sf.accent,
        borderRadius: 50,
        paddingVertical: 14,
        paddingHorizontal: 22,
        shadowColor: '#3B6FE8',
        shadowOpacity: 0.4,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 6 },
        elevation: 6,
      }}
    >
      <Icon name="plus" size={18} color={sf.onAccent} />
      <Text style={{ color: sf.onAccent, fontFamily: font.sansSemi, fontSize: 15 }}>
        New recipient
      </Text>
    </Pressable>
  );
}

/**
 * The name on the RECEIVING label — "Rabi receives", "553921133 receives".
 * The whole legal name is on the header two rows above it, and repeating it
 * wraps the label onto a second line on a 360px handset.
 */
function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}
