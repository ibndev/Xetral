import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TextInputProps } from 'react-native';
import { Link } from 'expo-router';
import type { ApiErrorCode } from '@xetral/client';
import { Icon } from '@/icon';
import type { IconName } from '@/icon';
import { apiUrl } from '@/session';
import { font, radius, space, useStyles, useTheme } from '@/theme';

/**
 * The small pieces every screen repeats, so they repeat identically.
 *
 * These mirror `apps/web/src/ui/` one for one — `FormError` and `VerifyPrompt`
 * in particular, because a refusal with no way out is the same dead end on
 * either platform and the web fixed it first.
 */

/**
 * A refusal, with the way out of it where there is one.
 *
 * "Set a transaction PIN before moving money" was a line of red text under a
 * button, and that is where the customer stopped: told the name of a thing
 * they do not have, on a screen that cannot give it to them. The web's
 * `FormError` carries the same table.
 *
 * `pin_locked` deliberately has no action — the only thing that resolves it is
 * fifteen minutes, and a button leading somewhere would imply otherwise.
 */
const NEXT_STEP: Partial<Record<ApiErrorCode, { href: string; label: string }>> = {
  pin_not_set: { href: '/security', label: 'Set a transaction PIN' },
  kyc_required: { href: '/kyc', label: 'Verify my identity' },
};

export function FormError({
  error,
  code,
}: {
  readonly error: string | undefined;
  readonly code: ApiErrorCode | undefined;
}) {
  const styles = useStyles();
  const colors = useTheme();
  if (error === undefined) return null;
  const next = code === undefined ? undefined : NEXT_STEP[code];

  return (
    <View style={{ gap: space.sm, marginTop: space.sm }}>
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
        <View style={{ paddingTop: 2 }}>
          <Icon name="alert" size={15} color={colors.danger} />
        </View>
        <Text style={[styles.error, { marginTop: 0, flex: 1 }]}>{error}</Text>
      </View>
      {/*
        WHICH HOST IT TRIED, and only when nothing answered.

        An installed APK has its API address compiled into the bundle, so a
        build pointed at the wrong host is an app where every screen fails and
        nothing on it says why — indistinguishable from a broken app, or from
        the phone having no signal. Naming the address turns that into a
        five-second diagnosis.

        It discloses nothing: the address is already in the bundle in plain
        text, readable by anyone who unzips the APK. It is shown ONLY for
        `network`, so an ordinary refusal — a wrong PIN, a declined card —
        never carries infrastructure detail a customer has no use for.
      */}
      {code === 'network' && <Text style={styles.hint}>Tried {safeHost()}</Text>}
      {next !== undefined && (
        <Link href={next.href as never} asChild>
          <Pressable
            accessibilityRole="button"
            style={{
              alignSelf: 'flex-start',
              paddingHorizontal: 16,
              paddingVertical: 9,
              borderRadius: radius.pill,
              backgroundColor: colors.brand,
            }}
          >
            <Text style={{ color: colors.onBrand, fontFamily: font.sansSemi, fontSize: 13.5 }}>
              {next.label}
            </Text>
          </Pressable>
        </Link>
      )}
    </View>
  );
}

/** The host the bundle was built against, or a note that it was never set. */
function safeHost(): string {
  try {
    return apiUrl();
  } catch {
    // `apiUrl` throws when neither EXPO_PUBLIC_API_URL nor `extra.apiUrl` is
    // set, which is its own diagnosis and a worse one to swallow.
    return 'no API address was configured in this build';
  }
}

/** A success line, so `done` never has to be styled at a call site. */
export function Done({ message }: { readonly message: string | undefined }) {
  const styles = useStyles();
  if (message === undefined) return null;
  return <Text style={styles.ok}>{message}</Text>;
}

/**
 * What a customer sees when they reach a product that needs a verified
 * identity — the phone's copy of the web's `VerifyPrompt`.
 *
 * It names what still works, which is the part that stops "verify your
 * identity" on a card screen reading as "the whole app is locked".
 */
/**
 * ONE LINE AND ONE BUTTON — the web's VerifyPrompt, and the same reasoning.
 * This carried three paragraphs; a person who has just tapped "Create card"
 * wants to know what to do next, and reading four sentences to find a button
 * is slower than the verification itself.
 */
export function VerifyPrompt({
  what,
  /**
   * The line, when the reason is REGULATORY rather than about a partner's
   * policy. A card is refused because the CBN requires an identified customer,
   * and telling somebody the rule that binds us is the difference between
   * "they want more forms" and "this is the law".
   */
  title,
  cta,
}: {
  readonly what: string;
  readonly title?: string | undefined;
  readonly cta?: string | undefined;
}) {
  const styles = useStyles();
  const colors = useTheme();
  return (
    <View style={styles.card}>
      <View
        style={{
          width: 42,
          height: 42,
          borderRadius: 12,
          backgroundColor: colors.infoBg,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: space.sm,
        }}
      >
        <Icon name="shield" size={20} color={colors.info} />
      </View>
      <Text style={[styles.h2, { marginBottom: space.lg }]}>
        {title ?? `Verify your identity for ${what}`}
      </Text>
      <Link href={'/kyc' as never} asChild>
        <Pressable accessibilityRole="button" style={styles.button}>
          <Text style={styles.buttonText}>{cta ?? 'Verify my identity'}</Text>
        </Pressable>
      </Link>
    </View>
  );
}

/** A labelled field, so a label and its control cannot be spaced differently
 *  on one screen from another. */
export function Field({
  label,
  hint,
  ...input
}: TextInputProps & { readonly label: string; readonly hint?: string }) {
  const styles = useStyles();
  const colors = useTheme();
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.text3}
        {...input}
        style={[styles.input, input.style]}
      />
      {hint !== undefined && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

export function Button({
  label,
  onPress,
  busy,
  disabled,
  quiet,
  accent,
  icon,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly quiet?: boolean;
  /** Filled and obvious, but not the primary. For a control that has to be
   *  pressed before the primary one exists — "Get a quote" ahead of
   *  "Convert". `quiet` there made the only live control the faintest thing
   *  on the screen. */
  readonly accent?: boolean;
  readonly icon?: IconName;
}) {
  const styles = useStyles();
  const colors = useTheme();
  const off = disabled === true || busy === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={onPress}
      style={[
        styles.button,
        quiet === true && styles.buttonQuiet,
        accent === true && styles.buttonAccent,
        off && { opacity: 0.5 },
        { gap: 8 },
      ]}
    >
      {busy === true ? (
        <ActivityIndicator
          color={
            accent === true ? colors.accentButtonText : quiet === true ? colors.text : colors.onBrand
          }
        />
      ) : (
        <>
          {icon !== undefined && (
            <Icon
              name={icon}
              size={17}
              color={
                accent === true
                  ? colors.accentButtonText
                  : quiet === true
                    ? colors.text
                    : colors.onBrand
              }
            />
          )}
          <Text
            style={[
              styles.buttonText,
              quiet === true && styles.buttonQuietText,
              accent === true && styles.buttonAccentText,
            ]}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** A card with a heading and a quiet subtitle — the web's `.card > h1 + h2`. */
export function Panel({
  title,
  subtitle,
  children,
}: {
  readonly title?: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.card}>
      {title !== undefined && <Text style={styles.h1}>{title}</Text>}
      {subtitle !== undefined && <Text style={styles.lead}>{subtitle}</Text>}
      {children}
    </View>
  );
}

export function Loading() {
  const colors = useTheme();
  return (
    <View style={{ paddingVertical: space.lg, alignItems: 'center' }}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

/** Nothing here yet, said in a way that distinguishes it from a failure. */
export function Empty({ icon, title, hint }: {
  readonly icon: IconName;
  readonly title: string;
  readonly hint?: string;
}) {
  const styles = useStyles();
  const colors = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: 8, paddingVertical: space.xl }}>
      <View
        style={{
          width: 46,
          height: 46,
          borderRadius: 14,
          backgroundColor: colors.surface2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={22} color={colors.text3} />
      </View>
      <Text style={[styles.muted, { fontSize: 14 }]}>{title}</Text>
      {hint !== undefined && (
        <Text style={[styles.hint, { textAlign: 'center', marginTop: 0 }]}>{hint}</Text>
      )}
    </View>
  );
}


/**
 * A short-lived message about something that just happened, over the screen.
 *
 * The web's `Toast`, in the shape a phone needs. Money moving is the one
 * action where the outcome has to be unmistakable, and the inline line was
 * under a form that resets itself while the keyboard is closing — so a
 * customer could tap Send, look up, and have no idea whether ₦50,000 had
 * gone.
 *
 * IT DOES NOT REPLACE THE INLINE MESSAGE, it sits over it. A toast carrying
 * the only copy of a refusal is a refusal that vanishes after a few seconds
 * and cannot be re-read — the worst possible property for the sentence
 * explaining why somebody's money did not move.
 *
 * `pointerEvents="none"` so it can never swallow a tap meant for the button
 * underneath it, which on this screen is the button that retries.
 */
export function Toast({
  message,
  tone,
  onDone,
}: {
  readonly message: string | undefined;
  readonly tone: 'ok' | 'bad';
  /** Called when it retires itself, so the caller can clear the state behind
   *  it — otherwise the same message can never be shown twice. */
  readonly onDone?: () => void;
}) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (message === undefined) return;
    // A refusal is left longer than a success: a success confirms what the
    // customer already believes happened, a refusal has to be read and acted
    // on.
    const life = tone === 'ok' ? 4500 : 7000;
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    const timer = setTimeout(() => {
      Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }).start(
        () => onDone?.(),
      );
    }, life);
    return () => clearTimeout(timer);
  }, [message, tone, fade, onDone]);

  if (message === undefined) return null;

  const accent = tone === 'ok' ? colors.ok : colors.danger;

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={{
        position: 'absolute',
        left: space.md,
        right: space.md,
        bottom: insets.bottom + 88,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        padding: 13,
        borderRadius: 14,
        backgroundColor: colors.surface,
        // The tone is a leading rule and the icon's colour, not a filled
        // panel: a block of colour behind 14px text is a contrast problem in
        // one theme or the other, and this has to be legible in both.
        borderLeftWidth: 3,
        borderLeftColor: accent,
        opacity: fade,
        transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
        elevation: 8,
        shadowColor: '#000',
        shadowOpacity: 0.18,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 8 },
      }}
    >
      <Icon name={tone === 'ok' ? 'check' : 'alert'} size={18} color={accent} />
      {/* Not `styles.label`: that is a form label — secondary colour, and a
          top margin that would push this off centre inside the row. A toast
          is the primary sentence on the screen while it is up. */}
      <Text
        style={{
          flex: 1,
          color: colors.text,
          fontFamily: font.sansSemi,
          fontSize: 14,
          lineHeight: 19,
        }}
      >
        {message}
      </Text>
    </Animated.View>
  );
}
