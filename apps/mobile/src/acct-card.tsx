import { Pressable, Share, Text, View } from 'react-native';
import { Icon } from '@/icon';
import { font, radius, space, useTheme } from '@/theme';

/**
 * THE COMP'S ACCOUNT CARD — the only gradient panel in the product.
 *
 * `docs/mockups/app.html` draws an account number once, with that weight,
 * because it is the one string on the screen a customer is going to read out,
 * photograph or save as a beneficiary. Here it was the same muted box a
 * balance uses, with no way to copy it at all — so the number somebody has to
 * get into their banking app was the one thing they had to retype by hand.
 *
 * USED TWICE ACROSS THE PRODUCT AND NEVER TWICE ON ONE SCREEN: the funding
 * account on Add money, and the customer's own number on Request money. Two
 * gradient panels on one screen would halve what the gradient says.
 *
 * THE VALUE IS NOT GROUPED. The comp prints `9021 4477 30`, which is easier
 * to read out and is not what a bank's beneficiary field will take — and this
 * screen's own rule is that what is SHOWN is what is SHARED, because the
 * clipboard is refused often enough that the value on screen is the fallback.
 * Readability loses to a customer pasting a number with spaces in it.
 */
export function AcctCard({
  eyebrow,
  value,
  sub,
  share,
}: {
  readonly eyebrow: string;
  readonly value: string;
  readonly sub: string;
  /** What the Copy button shares. Absent means there is nothing to copy. */
  readonly share?: string;
}) {
  const colors = useTheme();
  return (
    <View
      style={{
        borderRadius: 18,
        padding: 18,
        backgroundColor: colors.cardGrad1,
        borderWidth: 1,
        borderColor: colors.iris,
        marginTop: space.md,
      }}
    >
      <Text
        style={{
          color: colors.irisText, fontFamily: font.sansSemi,
          fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase',
        }}
      >
        {eyebrow}
      </Text>
      <View
        style={{
          flexDirection: 'row', alignItems: 'center',
          justifyContent: 'space-between', gap: 12, marginTop: 12,
        }}
      >
        <Text
          numberOfLines={1}
          selectable
          style={{
            flexShrink: 1,
            color: colors.text, fontFamily: font.numBold, fontSize: 22,
            letterSpacing: 0.4,
            fontVariant: ['tabular-nums'] as ('tabular-nums')[],
          }}
        >
          {value}
        </Text>
        {share !== undefined && share !== '' && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy"
            android_ripple={null}
            // Silent on failure: a dismissed share sheet rejects on iOS,
            // which is somebody changing their mind rather than an error.
            onPress={() => void Share.share({ message: share }).catch(() => undefined)}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingVertical: 7, paddingHorizontal: 12,
              borderRadius: radius.sm,
              backgroundColor: colors.irisTint,
            }}
          >
            <Icon name="copy" size={14} color={colors.irisText} />
            <Text style={{ color: colors.irisText, fontFamily: font.sansSemi, fontSize: 12 }}>
              Copy
            </Text>
          </Pressable>
        )}
      </View>
      <Text
        style={{
          color: colors.text3, fontFamily: font.sansMedium,
          fontSize: 12.5, marginTop: 6,
        }}
      >
        {sub}
      </Text>
    </View>
  );
}

/**
 * The comp's group heading — "OTHER METHODS", "PENDING REQUESTS", "CARD
 * ACTIVITY". Same figures as the day heading on a list of transactions, which
 * is the same device applied to a different list.
 */
export function Eyebrow({ children }: { readonly children: string }) {
  const colors = useTheme();
  return (
    <Text
      style={{
        color: colors.text3, fontFamily: font.sansBold,
        fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase',
        paddingTop: 20, paddingBottom: 6,
      }}
    >
      {children}
    </Text>
  );
}
