import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Icon } from '@/icon';
import type { IconName } from '@/icon';
import { Shell } from '@/shell';
import { useLoad, useXetral } from '@/hooks';
import { font, radius, space, useStyles, useTheme } from '@/theme';

/**
 * Everything the four tabs do not reach.
 *
 * The same groups the web's `/more` uses, in the same order. A destination
 * that exists on one platform and not the other is the drift this whole screen
 * was added to close.
 */
const GROUPS: readonly {
  title: string;
  items: readonly { href: string; label: string; hint: string; icon: IconName }[];
}[] = [
  {
    title: 'Money',
    items: [
      { href: '/transfer', label: 'Send money', hint: 'To another Xetral account', icon: 'send' },
      { href: '/add-money', label: 'Add money', hint: 'Your Nigerian account number', icon: 'plus' },
      { href: '/fx', label: 'Convert', hint: 'Between your currencies', icon: 'swap' },
    ],
  },
  {
    title: 'Products',
    items: [
      { href: '/bills', label: 'Bills and top-ups', hint: 'Airtime, data, electricity, eSIM', icon: 'receipt' },
      { href: '/crypto', label: 'Crypto', hint: 'Receive and send on-chain', icon: 'bitcoin' },
      { href: '/cards', label: 'USD cards', hint: 'Spend online in dollars', icon: 'card' },
    ],
  },
  {
    title: 'Account',
    items: [
      { href: '/kyc', label: 'Identity', hint: 'Verification and your limits', icon: 'shield' },
      { href: '/security', label: 'Security', hint: 'Biometric unlock for your PIN', icon: 'lock' },
      { href: '/settings', label: 'Settings', hint: 'PIN, appearance, email, your data', icon: 'settings' },
    ],
  },
];

export default function More() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const kyc = useLoad(() => client.kyc().catch(() => null), [client]);
  const verified = kyc.data?.status === 'approved';

  return (
    <Shell>
      <Text style={styles.h1}>More</Text>
      <Text style={styles.lead}>Everything else your account can do.</Text>

      {/* Put FIRST when it is outstanding, rather than buried under Account.
          It is what unblocks the account number and the card, and a customer
          refused by either arrives here looking for it. */}
      {!kyc.loading && !verified && (
        <Link href={'/kyc' as never} asChild>
          <Pressable
            accessibilityRole="link"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              marginTop: space.lg,
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: colors.warnBg,
            }}
          >
            <Icon name="shield" size={20} color={colors.warn} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontFamily: font.sansBold }}>
                Verify your identity
              </Text>
              <Text style={styles.hint}>
                Required before an account number or a card can be issued.
              </Text>
            </View>
            <Icon name="chevronRight" size={18} color={colors.text3} />
          </Pressable>
        </Link>
      )}

      {GROUPS.map((group) => (
        <View key={group.title} style={[styles.card, { marginTop: space.lg }]}>
          <Text style={styles.h2}>{group.title}</Text>
          {group.items.map((item) => (
            <Link key={item.href} href={item.href as never} asChild>
              <Pressable accessibilityRole="link" style={styles.row}>
                <View style={styles.rowIcon}>
                  <Icon name={item.icon} size={18} color={colors.text2} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontFamily: font.sansSemi }}>{item.label}</Text>
                  <Text style={styles.muted}>{item.hint}</Text>
                </View>
                <Icon name="chevronRight" size={18} color={colors.text3} />
              </Pressable>
            </Link>
          ))}
        </View>
      ))}
    </Shell>
  );
}
