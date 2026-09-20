import { Pressable, ScrollView, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { formatAmount, symbolFor } from '@xetral/client';
import type { Balance, Transaction } from '@xetral/client';
import { Icon } from '@/icon';
import type { IconName } from '@/icon';
import { Shell } from '@/shell';
import { Empty, FormError, Loading } from '@/ui';
import { CurrencyMark } from '@/currency-mark';
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
 * Every block on this screen is inset by it and the currency rail and the
 * promo rail BLEED by exactly it. The web learned that four pixels of
 * disagreement between an inset and its bleed is not a rounding difference —
 * it is a rail hanging past the screen edge with no gutter under it while
 * every other block keeps one. One constant is what makes them agree.
 */
const GUTTER = space.md;

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

/**
 * The day a transaction happened, as somebody would say it out loud.
 *
 * COMPARED ON THE LOCAL CALENDAR DAY, never on elapsed hours. A payment at
 * 23:50 and one at 00:10 are eleven hours apart and on two different days,
 * and a threshold in hours puts them under one heading. The web's own
 * function, to the character.
 */
function dayOf(when: Date): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(when)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

export default function Home() {
  const client = useXetral();
  const colors = useTheme();

  /*
   * REMEMBERED, and hidden is the fallback.
   *
   * A customer who hides the balance is telling us something about the room
   * they are standing in, and making them say it again on every launch means
   * the figure is shown at least once in that room every time. Same control,
   * same default, same storage rule on both apps.
   */
  const [visibility, setVisibility] = useRemembered<'hidden' | 'shown'>(
    BALANCE_VISIBILITY,
    'hidden',
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
        <Action href="/add-money" icon="download" label="Request" />
      </View>

      <View style={{ paddingHorizontal: GUTTER }}>
        <FormError error={balances.error} code={balances.code} />
      </View>

      <View style={{ paddingHorizontal: GUTTER, marginTop: space.lg }}>
        <SectionHead title="Explore" moreLabel="All services" moreHref="/more" />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {PRODUCTS.map((product) => (
            <Link key={product.label} href={product.href as never} asChild>
              <Pressable
                accessibilityRole="link"
                android_ripple={null}
                style={{
                  flex: 1,
                  alignItems: 'center', justifyContent: 'center',
                  gap: 7,
                  paddingVertical: 12, paddingHorizontal: 4,
                  minHeight: 82,
                  borderRadius: radius.lg,
                  borderWidth: 1, borderColor: colors.edge,
                  backgroundColor: colors.surface,
                }}
              >
                <View
                  style={{
                    width: 38, height: 38, borderRadius: 12,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: tone[product.tone].bg,
                  }}
                >
                  <Icon name={product.icon} size={20} color={tone[product.tone].fg} />
                </View>
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: 11.5, fontFamily: font.sansSemi,
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

      {/* The same two cards the web shows, bleeding the same GUTTER. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 12, paddingHorizontal: GUTTER, paddingTop: space.lg, paddingBottom: 6 }}
        style={{ marginHorizontal: -GUTTER }}
      >
        <Promo
          href="/fx"
          background={colors.warn}
          title="Send money home, instantly"
          body="Convert and deliver in one move — the rate you see is the rate you get."
          cta="Convert now"
        />
        <Promo
          href="/cards"
          background={colors.brand === '#FFFFFF' ? '#16295A' : colors.brand}
          title="Spend online in dollars"
          body="A virtual USD card, funded from your naira balance in seconds."
          cta="Get a card"
        />
      </ScrollView>

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
        {(() => {
          let seen: string | undefined;
          return history.data?.entries.slice(0, 6).map((t: Transaction) => {
            const outgoing = t.amount.trim().startsWith('-');
            const when = new Date(t.occurred_at);
            const day = dayOf(when);
            const heading = day === seen ? undefined : day;
            seen = day;
            return (
              <View key={t.id}>
                {heading !== undefined && (
                  <Text
                    style={{
                      color: colors.text3, fontFamily: font.sansBold,
                      fontSize: 11, letterSpacing: 1.1,
                      textTransform: 'uppercase',
                      paddingTop: 8, paddingBottom: 4,
                    }}
                  >
                    {heading}
                  </Text>
                )}
                <View
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 13,
                    paddingVertical: 12,
                    borderTopWidth: 1, borderTopColor: colors.line,
                  }}
                >
                  <View>
                    <View
                      style={{
                        width: 42, height: 42, borderRadius: 999,
                        alignItems: 'center', justifyContent: 'center',
                        backgroundColor: colors.surface2,
                      }}
                    >
                      <Icon
                        name={outgoing ? 'arrowUpRight' : 'download'}
                        size={19}
                        color={colors.text2}
                      />
                    </View>
                    {/* The currency rides ON the avatar rather than beside it,
                        so a row is two columns and not three — read at a
                        glance without a label taking a line. */}
                    <View style={{ position: 'absolute', bottom: -1, left: -2 }}>
                      <CurrencyMark currency={t.currency} size={14} />
                    </View>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      numberOfLines={1}
                      style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 14.5 }}
                    >
                      {t.description}
                    </Text>
                    {/* THE TIME, NOT THE DATE. The heading above already said
                        which day, and a row repeating it is a column of
                        identical text. */}
                    <Text
                      style={{ color: colors.text3, fontFamily: font.sansMedium, fontSize: 12.5, marginTop: 2 }}
                    >
                      {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </Text>
                  </View>
                  {/*
                    MONEY LEAVING IS RED AND MONEY ARRIVING IS GREEN. It was
                    red for neither, so the only thing separating "you were
                    paid" from "you paid" at a glance was a minus sign.

                    THE EYE HIDES THE BALANCE, NOT THE HISTORY. This line once
                    masked the history too, which the web has never done, and
                    it produced a list reading "Bank payout failed • • • • • •"
                    with nothing on screen connecting the dots to a toggle
                    tapped days earlier. The amount is the one thing you open
                    that list to find out.
                  */}
                  <Text
                    style={{
                      fontFamily: font.numSemi, fontSize: 14.5,
                      letterSpacing: -0.3,
                      color: outgoing ? colors.danger : colors.ok,
                    }}
                  >
                    {formatAmount(t.amount, t.currency)}
                  </Text>
                </View>
              </View>
            );
          });
        })()}
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
  } as const;
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

function Promo({
  href, background, title, body, cta,
}: {
  readonly href: string; readonly background: string;
  readonly title: string; readonly body: string; readonly cta: string;
}) {
  return (
    <Link href={href as never} asChild>
      <Pressable
        accessibilityRole="link"
        android_ripple={null}
        style={{
          width: 292,
          borderRadius: 22,
          padding: 18,
          backgroundColor: background,
        }}
      >
        {/* WHITE ON BOTH, and stated rather than taken from a token. Amber and
            navy are fixed colours that do not follow the theme, so text that
            followed `colors.text` would be near-black on the amber card in
            light mode and invisible on the navy one. */}
        <Text style={{ color: '#FFFFFF', fontFamily: font.sansBold, fontSize: 17, letterSpacing: -0.2 }}>
          {title}
        </Text>
        <Text
          style={{ color: 'rgba(255,255,255,.88)', fontFamily: font.sans, fontSize: 13.5, lineHeight: 19, marginTop: 6 }}
        >
          {body}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 }}>
          <Text style={{ color: '#FFFFFF', fontFamily: font.sansBold, fontSize: 14 }}>{cta}</Text>
          <Icon name="arrowRight" size={15} color="#FFFFFF" />
        </View>
      </Pressable>
    </Link>
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
            width: 56, height: 56, borderRadius: 18,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: primary === true ? colors.iris : colors.surface,
            borderWidth: 1,
            borderColor: primary === true ? colors.iris : colors.edge,
          }}
        >
          <Icon name={icon} size={22} color={primary === true ? colors.onIris : colors.text} />
        </View>
        <Text
          style={{
            fontSize: 12.5, fontFamily: font.sansSemi,
            color: primary === true ? colors.text : colors.text2,
          }}
        >
          {label}
        </Text>
      </Pressable>
    </Link>
  );
}
