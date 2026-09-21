import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { formatAmount, symbolFor } from '@xetral/client';
import type { Balance, Transaction } from '@xetral/client';
import { Icon } from '@/icon';
import type { IconName } from '@/icon';
import { Shell } from '@/shell';
import { Empty, FormError, Loading } from '@/ui';
import { CurrencyMark } from '@/currency-mark';
import { TxList } from '@/tx-list';
import { TransactionSheet } from '@/transaction-sheet';
import { useLoad, useRemembered, useXetral } from '@/hooks';
import { font, radius, space, useTheme } from '@/theme';
import { BALANCE_VISIBILITY } from '@/preferences';

/** A fixed mask. As many dots as the amount has digits would be a picture of
 *  the number, and the digit count is most of what a glance reads. */
const MASK = '• • • • • •';

const isZero = (amount: string) => /^-?0(\.0+)?$/.test(amount);
const looksLikeACurrency = (stored: string) => /^[A-Z]{3,6}$/.test(stored);

/**
 * THE SHELL'S GUTTER, STATED ONCE.
 *
 * 20px, READ OFF `docs/mockups/app.html` RATHER THAN CHOSEN — the header at
 * `12px 20px 4px`, the rail at `16px 20px 2px`, the Explore grid at `0 20px`.
 * Every block on this screen is inset by it and the currency rail and the
 * promo rail BLEED by exactly it. The web learned that four pixels of
 * disagreement between an inset and its bleed is not a rounding difference —
 * it is a rail hanging past the screen edge with no gutter under it while
 * every other block keeps one. One constant is what makes them agree.
 */
const GUTTER = 20;

/** The four products, in the order the design puts them — same as the web. */
const PRODUCTS: readonly {
  href: string; label: string; icon: IconName; tone: 'amber' | 'green' | 'blue' | 'navy';
}[] = [
  { href: '/bills',  label: 'Bills',    icon: 'receipt', tone: 'amber' },
  { href: '/crypto', label: 'Crypto',   icon: 'bitcoin', tone: 'green' },
  { href: '/bills',  label: 'eSIM',     icon: 'sim',     tone: 'blue' },
  { href: '/cards',  label: 'USD Card', icon: 'card',    tone: 'navy' },
];

/**
 * What a currency is called, for the line under its code on a rail card.
 *
 * NAMED, NEVER INVENTED FROM THE CODE — a card reading "NGN / NGN" says
 * nothing twice. The same table as the web's, because the two apps must not
 * be able to call one currency two things.
 */
const CURRENCY_NAMES: Readonly<Record<string, string>> = {
  NGN: 'Nigerian Naira',
  GHS: 'Ghanaian Cedi',
  KES: 'Kenyan Shilling',
  USD: 'US Dollar',
  GBP: 'Pound Sterling',
  CAD: 'Canadian Dollar',
  USDT: 'Tether',
  USDC: 'USD Coin',
  BTC: 'Bitcoin',
};
const nameOf = (code: string) => CURRENCY_NAMES[code] ?? code;

export default function Home() {
  const client = useXetral();
  const colors = useTheme();

  /*
   * REMEMBERED, and SHOWN is the fallback — the web's change, applied here
   * for the reason the two apps share a control at all.
   *
   * A customer who hides the balance is telling us something about the room
   * they are standing in, and that choice is what is stored and honoured on
   * every launch. What was wrong was reading its ABSENCE the same way:
   * nothing is written until somebody presses the eye, so a customer who
   * never had was shown six dots where the figure goes, for ever, on the
   * screen they open to check it.
   */
  /* Which transaction's receipt is open, by id — the list grows as pages
     load, so an index would point at a different one after a reload. */
  const [openTx, setOpenTx] = useState<string | undefined>(undefined);

  const [visibility, setVisibility] = useRemembered<'hidden' | 'shown'>(
    BALANCE_VISIBILITY,
    'shown',
    (stored) => stored === 'hidden' || stored === 'shown',
  );
  const hidden = visibility === 'hidden';

  const [preferred, setPreferred] = useRemembered<string>(
    'xetral.wallet-currency',
    'NGN',
    looksLikeACurrency,
  );

  const session = useLoad(() => client.currentSession(), [client]);
  const balances = useLoad(() => client.balances(), [client]);
  // Every currency the platform OFFERS, not only the ones this customer has
  // received — the API returns a zero row for each, so this list is the
  // platform's answer rather than an accident of transaction history.
  const assets = balances.data ?? [];

  const active = assets.find((b) => b.currency === preferred) ?? assets[0];
  const currency = active?.currency ?? 'NGN';

  const history = useLoad(
    () => client.transactions(currency).catch(() => ({ entries: [], nextCursor: null })),
    [client, currency],
  );

  const tone = {
    amber: { bg: colors.warnBg, fg: colors.warn },
    green: { bg: colors.okBg, fg: colors.ok },
    blue: { bg: colors.infoBg, fg: colors.info },
    navy: { bg: colors.irisTint, fg: colors.irisText },
  } as const;

  return (
    <Shell greeting={{ name: session.data?.first_name }}>
      {/*
        THE GLOW IS A LIGHT SOURCE, NOT A FILL.

        It sits behind the balance and nothing else, is never on a surface
        carrying its own text, and takes no touches. On the web it is a
        radial gradient; React Native has no radial gradient without a native
        module, so it is a soft translucent disc with the same colour token
        and the same job. `pointerEvents` none, and everything after it is a
        later sibling and therefore above it.
      */}
      <View style={{ paddingHorizontal: GUTTER }}>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: -110, left: '18%',
            width: 300, height: 300, borderRadius: 999,
            backgroundColor: colors.glow,
            opacity: 0.9,
          }}
        />

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingTop: 4 }}>
          <Text style={{ color: colors.text2, fontFamily: font.sansSemi, fontSize: 13 }}>
            Total balance
          </Text>
          {/*
            One tap, and no filled box behind it in any state. Somebody checks
            their phone in a danfo with a stranger's shoulder at theirs.
          */}
          <Pressable
            onPress={() => setVisibility(hidden ? 'shown' : 'hidden')}
            // ANDROID DRAWS A RIPPLE ON TOUCH unless told not to, and on a
            // 44pt square around an 18pt glyph that ripple IS the circular
            // background that was reported. `null` is the documented refusal;
            // omitting the prop accepts the platform default.
            android_ripple={null}
            accessibilityRole="button"
            accessibilityState={{ selected: hidden }}
            accessibilityLabel={hidden ? 'Show balance' : 'Hide balance'}
            hitSlop={8}
            style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name={hidden ? 'eyeOff' : 'eye'} size={18} color={colors.text2} />
          </Pressable>
        </View>

        {/*
          THE MINOR UNITS ARE QUIETER THAN THE MAJOR — two <Text> children of
          one line rather than two views, so they share a baseline.

          A customer reads the whole number and GLANCES at the kobo; setting
          both at full contrast makes a seven-figure figure harder to take in,
          which is the one thing this line exists to be good at. Split on the
          LAST separator, because `formatAmount` writes what the currency
          writes and the eight decimals of a BTC balance are still the minor
          part.
        */}
        <Figure
          text={
            balances.loading
              ? ' '
              : hidden
                ? `${symbolFor(currency)} ${MASK}`
                : formatAmount(active?.spendable ?? '0.00', currency)
          }
          split={!hidden && !balances.loading}
        />

        {/*
          THE CHIP SAYS WHAT IS PENDING, WHICH IS THE ONE THING HERE THAT IS
          TRUE. The design puts a "this week" figure in this slot and there is
          nothing behind it: a week's inflow would have to be summed from ONE
          PAGE of history, which is however many entries that page holds and
          not a week. A plausible number where a customer reads their money is
          the one thing this screen must not invent, so the slot carries money
          that is genuinely held and is absent when there is none.
        */}
        {active !== undefined && !isZero(active.pending) && !hidden && (
          <View style={{ marginTop: 11, flexDirection: 'row' }}>
            <View
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 5,
                paddingVertical: 4, paddingHorizontal: 10,
                borderRadius: radius.pill,
                backgroundColor: colors.irisTint,
                borderWidth: 1, borderColor: colors.irisEdge,
              }}
            >
              <Icon name="clock" size={13} color={colors.irisText} />
              <Text style={{ color: colors.irisText, fontFamily: font.sansSemi, fontSize: 12 }}>
                {formatAmount(active.pending, currency)} pending
              </Text>
            </View>
          </View>
        )}
      </View>

      {/*
        THE RAIL REPLACED A DROPDOWN, and it answers a different question.

        A picker says which currency the figure above is in; the rail shows
        what is in every one of them at once, which is what somebody holding
        four currencies opens this screen to see. Tapping a card moves the big
        figure — so the rail is the selector as well, and there is still
        exactly one control for one decision.

        IT BLEEDS TO THE SCREEN EDGE by exactly `GUTTER` and puts the same
        inset back inside, so the first card lines up with the balance above
        it and the last one is visibly cut off, which is what tells somebody
        there is more.
      */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 12, paddingHorizontal: GUTTER, paddingTop: 16, paddingBottom: 2 }}
        style={{ marginHorizontal: -GUTTER }}
      >
        {balances.loading
          ? null
          : assets.map((b: Balance) => {
              const on = b.currency === currency;
              return (
                <Pressable
                  key={b.currency}
                  onPress={() => setPreferred(b.currency)}
                  android_ripple={null}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${nameOf(b.currency)} balance`}
                  style={{
                    width: 212,
                    borderRadius: 22,
                    padding: 17,
                    backgroundColor: on ? colors.cardGrad1 : colors.surface,
                    borderWidth: 1,
                    borderColor: on ? colors.iris : colors.edge,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                    <CurrencyMark currency={b.currency} size={26} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: colors.text, fontFamily: font.sansBold, fontSize: 14 }}>
                        {b.currency}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={{ color: colors.text3, fontFamily: font.sansMedium, fontSize: 11 }}
                      >
                        {nameOf(b.currency)}
                      </Text>
                    </View>
                  </View>
                  <Text
                    numberOfLines={1}
                    style={{
                      color: colors.text, fontFamily: font.numBold,
                      fontSize: 22, letterSpacing: -0.6, marginTop: 16,
                      // WHAT MAKES A COLUMN LINE UP, and it is the variant
                      // rather than the family — see `font.num` in theme.ts.
                      fontVariant: ['tabular-nums'],
                    }}
                  >
                    {hidden ? `${symbolFor(b.currency)} ${MASK}` : formatAmount(b.spendable, b.currency)}
                  </Text>
                  <Text
                    style={{ color: colors.text3, fontFamily: font.sansMedium, fontSize: 11.5, marginTop: 3 }}
                  >
                    Spendable
                  </Text>
                </Pressable>
              );
            })}
      </ScrollView>

      {/*
        FOUR ACTIONS, ONE OF THEM FILLED. Send is what this app is for; the
        other three are beside it because they are beside it in somebody's
        head, not because they are equal to it.
      */}
      <View
        style={{
          flexDirection: 'row', justifyContent: 'space-between',
          paddingHorizontal: GUTTER + 6, paddingTop: 22, paddingBottom: 8,
        }}
      >
        <Action href="/transfer"  icon="send"     label="Send" primary />
        <Action href="/add-money" icon="plus"     label="Add" />
        <Action href="/fx"        icon="swap"     label="Convert" />
        {/* ITS OWN SCREEN. Request and Add both pointed at `/add-money`, so
            two of the four actions led to one screen — and the one headed Add
            Money, which is not what somebody asking to be paid came for. */}
        <Action href="/request" icon="download" label="Request" />
      </View>

      <View style={{ paddingHorizontal: GUTTER }}>
        <FormError error={balances.error} code={balances.code} />
      </View>

      <View style={{ paddingHorizontal: GUTTER, marginTop: space.lg }}>
        <SectionHead title="Explore" moreLabel="All services" moreHref="/more" />
        <View style={{ flexDirection: 'row', gap: 9 }}>
          {PRODUCTS.map((product) => (
            <Link key={product.label} href={product.href as never} asChild>
              <Pressable
                accessibilityRole="link"
                android_ripple={null}
                style={{
                  flex: 1,
                  alignItems: 'center', justifyContent: 'center',
                  // `gap:6; padding:11px 4px; radius:14`, off the comp.
                  gap: 6,
                  paddingVertical: 11, paddingHorizontal: 4,
                  minHeight: 72,
                  borderRadius: 14,
                  borderWidth: 1, borderColor: colors.edge,
                  backgroundColor: colors.surface,
                }}
              >
                <View
                  style={{
                    width: 32, height: 32, borderRadius: 10,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: tone[product.tone].bg,
                  }}
                >
                  <Icon name={product.icon} size={18} color={tone[product.tone].fg} />
                </View>
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: 11, fontFamily: font.sansSemi,
                    textAlign: 'center', color: colors.text,
                  }}
                >
                  {product.label}
                </Text>
              </Pressable>
            </Link>
          ))}
        </View>
      </View>

      {/*
        THERE IS NO PROMO RAIL HERE, and removing it is the correction.

        Two marketing cards sat between Explore and Recent activity. They are
        not in `docs/mockups/app.html`: that screen goes Explore tiles
        straight to Recent activity, and both cards were this app's own
        addition. A section the design does not have is a difference from the
        design, and on the home screen it pushed the customer's own
        transactions most of a handset further down for two things they did
        not ask for.
      */}

      <View style={{ paddingHorizontal: GUTTER, marginTop: space.lg }}>
        <SectionHead title="Recent activity" moreLabel="See all" moreHref="/activity" />

        {history.loading && <Loading />}
        {!history.loading && (history.data?.entries.length ?? 0) === 0 && (
          <Empty
            icon="file"
            title="No transactions yet"
            hint="Money you send or receive will show up here."
          />
        )}

        {/*
          GROUPED BY DAY, which is what lets each row drop the date it was
          repeating and show the time instead.

          A HEADING CAN LEGITIMATELY REPEAT, and re-sorting to prevent it
          would be the bug. History is keyset paginated on the POSTING ID —
          time order for ordinary traffic, and deliberately not when a sweep
          posts today a deposit that arrived on Tuesday. Sorting this screen
          by `occurred_at` would make it disagree with the cursor "See all"
          pages on, which is how a list grows duplicates and gaps.
        */}
        {/*
          THE SAME LIST THE ACTIVITY SCREEN DRAWS, from `src/tx-list.tsx`.
          Two copies of a transaction row had already drifted into two
          different products, and "See all" led from the better one to the
          worse one — the web's own split, fixed the same way.
        */}
        <TxList entries={history.data?.entries.slice(0, 6) ?? []} onOpen={setOpenTx} />

        {openTx !== undefined && (
          <TransactionSheet id={openTx} onClose={() => setOpenTx(undefined)} />
        )}
      </View>
    </Shell>
  );
}

/**
 * The balance, with the minor units set quieter than the major.
 *
 * Both halves are `<Text>` children of one `<Text>`, which is what shares the
 * baseline — two sibling views would each lay out their own box and the
 * decimals would sit a pixel off the digits beside them.
 */
function Figure({ text, split }: { readonly text: string; readonly split: boolean }) {
  const colors = useTheme();
  const at = split ? text.lastIndexOf('.') : -1;
  const base = {
    color: colors.text,
    fontFamily: font.numBold,
    fontSize: 40,
    letterSpacing: -1.6,
    // `800 40px Manrope; letter-spacing:-1.6px; tabular-nums` — the comp's
    // balance, to the character.
    // NOT `as const` on this one: React Native types `fontVariant` as a
    // MUTABLE array, so a readonly tuple is refused — and widening the whole
    // object with a cast to silence it would take the compiler off a style
    // that sets a size and a colour.
    fontVariant: ['tabular-nums'] as ('tabular-nums')[],
  };
  if (at === -1) return <Text style={base} numberOfLines={1}>{text}</Text>;
  return (
    <Text style={base} numberOfLines={1}>
      {text.slice(0, at)}
      <Text style={{ color: colors.text3 }}>{text.slice(at)}</Text>
    </Text>
  );
}

/** A heading and the link beside it. One component, so the two apps cannot
 *  space this pair differently. */
function SectionHead({
  title, moreLabel, moreHref,
}: {
  readonly title: string; readonly moreLabel: string; readonly moreHref: string;
}) {
  const colors = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingBottom: 10,
      }}
    >
      <Text style={{ color: colors.text, fontFamily: font.sansBold, fontSize: 17, letterSpacing: -0.2 }}>
        {title}
      </Text>
      <Link href={moreHref as never} asChild>
        <Pressable accessibilityRole="link" android_ripple={null}>
          <Text style={{ color: colors.iris, fontFamily: font.sansSemi, fontSize: 13 }}>
            {moreLabel}
          </Text>
        </Pressable>
      </Link>
    </View>
  );
}

function Action({
  href, icon, label, primary,
}: {
  readonly href: string; readonly icon: IconName;
  readonly label: string; readonly primary?: boolean;
}) {
  const colors = useTheme();
  return (
    <Link href={href as never} asChild>
      <Pressable
        accessibilityRole="link"
        android_ripple={null}
        style={{ alignItems: 'center', gap: 9 }}
      >
        <View
          style={{
            // 54 AND `surface2`, off the comp. It was 56 on `surface`, which
            // is the same tile two pixels larger on a fill one step
            // shallower — invisible alone and visible beside the web, which
            // had it right.
            width: 54, height: 54, borderRadius: 18,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: primary === true ? colors.iris : colors.surface2,
            borderWidth: 1,
            borderColor: primary === true ? colors.iris : colors.edge,
          }}
        >
          <Icon name={icon} size={22} color={primary === true ? colors.onIris : colors.text} />
        </View>
        <Text
          style={{
            fontSize: 12, fontFamily: font.sansSemi,
            color: primary === true ? colors.text : colors.text2,
          }}
        >
          {label}
        </Text>
      </Pressable>
    </Link>
  );
}
