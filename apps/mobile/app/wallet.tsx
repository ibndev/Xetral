import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Link } from 'expo-router';
import { formatAmount, symbolFor } from '@xetral/client';
import type { Balance, Transaction } from '@xetral/client';
import { Icon } from '@/icon';
import type { IconName } from '@/icon';
import { Shell } from '@/shell';
import { Empty, FormError, Loading } from '@/ui';
import { Select } from '@/select';
import { CurrencyMark } from '@/currency-mark';
import { useLoad, useRemembered, useXetral } from '@/hooks';
import { font, radius, space, useStyles, useTheme } from '@/theme';
import { BALANCE_VISIBILITY } from '@/preferences';

/** A fixed mask. As many dots as the amount has digits would be a picture of
 *  the number, and the digit count is most of what a glance reads. */
const MASK = '• • • • • •';

const isZero = (amount: string) => /^-?0(\.0+)?$/.test(amount);
const looksLikeACurrency = (stored: string) => /^[A-Z]{3,6}$/.test(stored);

/** The same four products the web puts here, in the same order. */
const PRODUCTS: readonly {
  href: string; label: string; icon: IconName; tone: 'amber' | 'green' | 'blue' | 'navy';
}[] = [
  { href: '/bills', label: 'Bills', icon: 'receipt', tone: 'amber' },
  { href: '/crypto', label: 'Crypto', icon: 'bitcoin', tone: 'green' },
  { href: '/bills', label: 'eSIM', icon: 'sim', tone: 'blue' },
  { href: '/cards', label: 'USD Card', icon: 'card', tone: 'navy' },
];

export default function Home() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const quick = useQuickMetrics();

  /*
   * REMEMBERED, and hidden is the fallback.
   *
   * The web learned this first: hiding was component state, so a reload put
   * the number back on the display. A customer who hides it is telling us
   * something about the room they are standing in, and making them say it
   * again on every launch means the figure is shown at least once in that room
   * every time. Same control, same default, same storage rule on both apps.
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
    navy: { bg: colors.surface2, fg: colors.text2 },
  } as const;

  return (
    <Shell>
      {/*
        BY NAME, and nothing under it — the same as the web. The subtitle
        described the screen to somebody already looking at it and pushed the
        balance a line down. The name is the customer's own, from their
        identity submission, which is the only place this system holds one.
      */}
      <Text style={styles.h1}>Hello {session.data?.first_name ?? 'there'}</Text>

      <View style={[styles.card, { marginTop: space.lg }]}>
        <View style={styles.rowBetween}>
          <Text style={{ color: colors.text2, fontSize: 13.5, fontFamily: font.sansMedium }}>
            Available balance
          </Text>
          {/*
            THE SELECTOR IS HERE AND NOWHERE ELSE, exactly as on the web. There
            used to be a badge — which named the currency and could not change
            it — plus a wrap of chips below the balance that could. Two
            controls for one decision, and the chips repeated every figure the
            balance was already showing.
          */}
          <Select
            variant="pill"
            label="Currency"
            value={currency}
            onChange={setPreferred}
            options={assets.map((b: Balance) => ({
              value: b.currency,
              label: b.currency,
              ...(hidden ? {} : { hint: formatAmount(b.spendable, b.currency) }),
            }))}
            renderMark={(code) => <CurrencyMark currency={code} size={20} />}
          />
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text style={[styles.balance, { flex: 1 }]} numberOfLines={1}>
            {balances.loading
              ? ' '
              : hidden
                ? `${symbolFor(currency)} ${MASK}`
                : formatAmount(active?.spendable ?? '0.00', currency)}
          </Text>
          {/*
            One tap, and no filled box behind it in any state. Somebody checks
            their phone in a danfo with a stranger's shoulder at theirs.
          */}
          <Pressable
            onPress={() => setVisibility(hidden ? 'shown' : 'hidden')}
            // ANDROID DRAWS A RIPPLE ON TOUCH unless told not to, and on a
            // 44pt square around a 20pt glyph that ripple IS the circular
            // background that was reported. `null` is the documented way to
            // refuse it; omitting the prop accepts the platform default.
            android_ripple={null}
            accessibilityRole="button"
            accessibilityState={{ selected: hidden }}
            accessibilityLabel={hidden ? 'Show balance' : 'Hide balance'}
            hitSlop={8}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name={hidden ? 'eyeOff' : 'eye'} size={20} color={colors.text2} />
          </Pressable>
        </View>

        {active !== undefined && !isZero(active.pending) && (
          <Text style={styles.hint}>
            {hidden ? MASK : formatAmount(active.pending, currency)} pending — held, not yet
            spendable
          </Text>
        )}

        {/*
          THE ACCOUNT NUMBER IS NOT HERE ANY MORE, matching the web.

          It sat under the balance, which put a beneficiary's name, a bank and
          a ten-digit number — three things nobody reads while checking what
          they have — inside the one figure a customer opens the app to see.
          It lives on the top-up screen, which is the screen somebody opens in
          order to be paid.
        */}

        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: quick.gap,
            marginTop: space.lg,
          }}
        >
          <QuickAction href="/transfer" icon="send" label="Send" primary />
          <QuickAction href="/add-money" icon="plus" label="Add money" />
          <QuickAction href="/fx" icon="swap" label="Convert" />
        </View>

        <FormError error={balances.error} code={balances.code} />
      </View>

      <View style={[styles.rowBetween, { marginTop: space.xl, marginBottom: space.md }]}>
        <Text style={styles.h2}>Products</Text>
        <Link href={'/more' as never} asChild>
          <Pressable accessibilityRole="link">
            <Text style={styles.link}>View all</Text>
          </Pressable>
        </Link>
      </View>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        {PRODUCTS.map((product) => (
          <Link key={product.label} href={product.href as never} asChild>
            <Pressable
              accessibilityRole="link"
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                paddingVertical: 10,
                paddingHorizontal: 4,
                minHeight: 76,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.edge,
                backgroundColor: colors.surface,
              }}
            >
              <View
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 11,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: tone[product.tone].bg,
                }}
              >
                <Icon name={product.icon} size={20} color={tone[product.tone].fg} />
              </View>
              <Text
                numberOfLines={2}
                style={{
                  fontSize: 11.5,
                  fontFamily: font.sansSemi,
                  textAlign: 'center',
                  color: colors.text,
                }}
              >
                {product.label}
              </Text>
            </Pressable>
          </Link>
        ))}
      </View>

      <View style={[styles.card, { marginTop: space.xl }]}>
        <View style={[styles.rowBetween, { marginBottom: space.sm }]}>
          <Text style={styles.h2}>Recent activity</Text>
          <Link href={'/activity' as never} asChild>
            <Pressable accessibilityRole="link">
              <Text style={styles.link}>See all</Text>
            </Pressable>
          </Link>
        </View>

        {history.loading && <Loading />}
        {!history.loading && (history.data?.entries.length ?? 0) === 0 && (
          <Empty
            icon="file"
            title="No transactions yet"
            hint="Money you send or receive will show up here."
          />
        )}

        {history.data?.entries.slice(0, 6).map((t: Transaction) => {
          const outgoing = t.amount.trim().startsWith('-');
          return (
            <View key={t.id} style={styles.row}>
              <View style={styles.rowIcon}>
                <Icon
                  name={outgoing ? 'arrowUpRight' : 'download'}
                  size={18}
                  color={colors.text2}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontFamily: font.sansSemi }} numberOfLines={1}>
                  {t.description}
                </Text>
                <Text style={styles.muted}>
                  {new Date(t.occurred_at).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                  })}
                </Text>
              </View>
              {/*
                THE EYE HIDES THE BALANCE, NOT THE HISTORY — and this line
                masked the history too, which the web has never done.
                
                What that produced was a list of transactions reading
                "Bank payout failed  • • • • • •", with nothing on screen
                connecting the dots to the eye toggle at the top of a card
                somebody had tapped days earlier. It reads as broken data
                rather than as a privacy setting, and the amount is the one
                thing you open that list to find out.
                
                The balance is the figure worth hiding from somebody standing
                behind you: it is large, it is at the top, and it is what a
                glance reads. A single past transaction is not, and the web
                already made that judgement — this is the phone catching up
                rather than a new decision.
              */}
              <Text style={[styles.amount, outgoing ? undefined : { color: colors.ok }]}>
                {formatAmount(t.amount, t.currency)}
              </Text>
            </View>
          );
        })}
      </View>
    </Shell>
  );
}

/*
 * THE WEB'S OWN NUMBERS, AT THE WEB'S OWN BREAKPOINTS.
 *
 * `.quick-actions` in `globals.css` is a wrapping flex row whose buttons are
 * `flex: 1 0 auto` — they size to their LABEL and then grow to fill, and when
 * three of them do not fit they wrap onto a second line. The phone had
 * `flex: 1` instead, which is a different rule: it forces three equal thirds
 * whatever the labels need, so "Add money" was squeezed into 92pt on a 360pt
 * handset and pushed past the shape behind it. Shrinking the face was a way
 * of hiding that rather than fixing it, and `adjustsFontSizeToFit` is
 * unreliable for one line on Android anyway.
 *
 * So the geometry is the web's, read off the same three rules: the base, the
 * 400px bump and the 520px one. A label that will not fit takes a second row,
 * which is what the web has always done here and what "contained by the card"
 * actually means.
 */
function useQuickMetrics() {
  const { width } = useWindowDimensions();
  if (width >= 520) return { gap: 10, padX: 18, inner: 8, size: 15 } as const;
  if (width >= 400) return { gap: 8, padX: 12, inner: 6, size: 13.5 } as const;
  return { gap: 6, padX: 7, inner: 5, size: 13 } as const;
}

function QuickAction({
  href,
  icon,
  label,
  primary,
}: {
  readonly href: string;
  readonly icon: IconName;
  readonly label: string;
  readonly primary?: boolean;
}) {
  const colors = useTheme();
  const quick = useQuickMetrics();
  return (
    <Link href={href as never} asChild>
      <Pressable
        accessibilityRole="link"
        style={{
          /*
           * `flexGrow` WITHOUT `flexBasis: 0`, which is the whole point.
           * `flex: 1` is shorthand for a zero basis — every button gets the
           * same third of the row and the label is left to cope. The web's
           * `flex: 1 0 auto` measures the label first and only then shares
           * out what is left over, so a button is never narrower than the
           * word inside it.
           */
          flexGrow: 1,
          flexBasis: 'auto',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: quick.inner,
          paddingHorizontal: quick.padX,
          // 48 on the web, and for the same reason: a smaller target is one
          // people miss.
          minHeight: 48,
          borderRadius: radius.pill,
          backgroundColor: primary === true ? colors.brand : colors.surface2,
          /*
           * THE HAIRLINE THE BALANCE CARD HAS, on the two that are not the
           * primary action. `colors.line` is the card's own token, so it is
           * the same line rather than one that matches today. The filled
           * button gets none: an outline around a solid shape is a second
           * edge on the one control that does not need help being found.
           */
          borderWidth: 1,
          borderColor: primary === true ? 'transparent' : colors.line,
        }}
      >
        <Icon name={icon} size={16} color={primary === true ? colors.onBrand : colors.text} />
        <Text
          // ONE LINE AND NOT SHRUNK. The web sets `white-space: nowrap` and
          // lets the row wrap instead; the label keeps the size it was
          // designed at, and a button that cannot fit takes the next line.
          numberOfLines={1}
          style={{
            fontSize: quick.size,
            fontFamily: font.sansSemi,
            color: primary === true ? colors.onBrand : colors.text,
          }}
        >
          {label}
        </Text>
      </Pressable>
    </Link>
  );
}
