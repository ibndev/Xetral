import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Animated, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Link, router, usePathname } from 'expo-router';
import { Icon } from '@/icon';
import type { IconName } from '@/icon';
import { Logo } from '@/logo';
import { font, space, useStyles, useTheme, useThemeChoice, useResolvedScheme } from '@/theme';

/**
 * ONE NAVIGATION, THE SAME AS THE WEB'S.
 *
 * The phone had a stack of seven screens and no navigation at all: the wallet
 * carried two text links and a sign-out, and everything else was reachable
 * only by going back. The web has a four-item tab bar and a header, so the two
 * apps were not the same product — which is the report this is answering.
 *
 * The tabs and their icons are the WEB'S LIST, in the web's order. A separate
 * list here would drift the way the refusal messages did, and the failure is
 * quiet: a destination added to one app and forgotten in the other is a screen
 * half the customers cannot reach.
 */
interface Tab {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
}

export const TABS: readonly Tab[] = [
  { href: '/wallet', label: 'Home', icon: 'home' },
  { href: '/cards', label: 'Cards', icon: 'card' },
  { href: '/activity', label: 'Activity', icon: 'activity' },
  { href: '/more', label: 'More', icon: 'grid' },
];

/**
 * Light and dark, remembered — the sun/moon the web has carried since it was
 * built and the phone did not.
 *
 * It cycles through the RESOLVED scheme rather than through three states.
 * Offering "system" as a third tap is honest and nobody wants it: the control
 * a customer reaches for means "make this screen light" or "make it dark",
 * and `system` remains the default until the first tap says otherwise.
 */
export function ThemeToggle() {
  const colors = useTheme();
  const scheme = useResolvedScheme();
  const { set } = useThemeChoice();

  return (
    <Pressable
      onPress={() => set(scheme === 'dark' ? 'light' : 'dark')}
      // ANDROID DRAWS A RIPPLE ON TOUCH unless told not to, and on a
      // 44pt square around a 20pt glyph that ripple IS the circular
      // background that was reported. `null` is the documented way to
      // refuse it; omitting the prop accepts the platform default.
      android_ripple={null}
      accessibilityRole="button"
      accessibilityLabel={scheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      // 44pt, and NO BACKGROUND IN ANY STATE. The web's equivalent was
      // painting a near-white disc behind itself because a bare `button` rule
      // outranked its class; there is no cascade to lose to here, and the hit
      // area is padding rather than a filled box so it cannot come back.
      hitSlop={8}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon name={scheme === 'dark' ? 'sun' : 'moon'} size={20} color={colors.text2} />
    </Pressable>
  );
}

/**
 * Up to two initials from a display name.
 *
 * `undefined` rather than a placeholder letter when there is nothing to work
 * with — the same function and the same rule as the web's `Shell`.
 */
function initialsOf(name: string | null | undefined): string | undefined {
  if (name === undefined || name === null) return undefined;
  const parts = name.trim().split(/\s+/).filter((w) => w.length > 0);
  if (parts.length === 0) return undefined;
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  const out = `${first}${last}`.toUpperCase();
  return out === '' ? undefined : out;
}

/**
 * The frame every signed-in screen sits in.
 *
 * `back` swaps the mark for a chevron, exactly as the web's `Shell` does, so a
 * screen one level down is recognisable as one.
 */
export function Shell({
  children,
  title,
  back,
  greeting,
  scroll = true,
  overlay,
}: {
  readonly children: ReactNode;
  readonly title?: string;
  /** Show a back chevron instead of the mark — for a screen one level down. */
  readonly back?: string;
  /**
   * THE HOME SCREEN'S HEADER IS A GREETING, NOT A MARK — and it lives here
   * rather than on the screen for the reason the keyboard handling and the
   * tab bar do: the header is the shell's, and a screen drawing its own is a
   * second header that drifts from this one the first time either changes.
   *
   * A customer who has opened the app knows which app they opened. What the
   * mark was doing at the top of the one screen they see most was taking the
   * width that now says who they are signed in as, which is the thing worth
   * confirming at a glance on a screen showing money. The web's `Shell` takes
   * the same prop and renders the same two lines.
   */
  readonly greeting?: { readonly name: string | null | undefined };
  /** Off for a screen that scrolls its own list. */
  readonly scroll?: boolean;
  /**
   * DRAWN OVER THE CONTENT, not inside it — for a `Toast`.
   *
   * It has to live here rather than on the screen, because a screen's
   * children go inside a ScrollView: an absolutely positioned toast placed
   * among them anchors to the scrolled content and slides away with it, which
   * is the one thing a confirmation that money moved must not do. As a
   * sibling of the ScrollView it stays put, and it sits BELOW the tab bar in
   * the tree so a message can never cover the navigation.
   */
  readonly overlay?: ReactNode;
}) {
  const styles = useStyles();
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === '/wallet' ? pathname === href : pathname.startsWith(href);

  /*
   * EVERY SCREEN ARRIVES, rather than appearing.
   *
   * The phone had no entrance at all — reported alongside the web's, which had
   * one that ten screens forgot to apply. This is `Shell`'s, so it cannot be
   * forgotten, and it is keyed on the PATH so navigating replays it instead of
   * playing once per launch.
   *
   * `useNativeDriver`, because opacity and transform are the two things the
   * native driver can animate off the JS thread — an entrance that stutters
   * while the screen is also fetching is worse than none.
   *
   * The spring OVERSHOOTS slightly, which is what makes it read as motion
   * rather than a fade. `friction`/`tension` rather than a duration: a spring
   * that is interrupted by a fast tap settles instead of jumping, which a
   * timing curve does not.
   */
  const entrance = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    entrance.setValue(0);
    Animated.spring(entrance, {
      toValue: 1,
      friction: 9,
      tension: 70,
      useNativeDriver: true,
    }).start();
  }, [entrance, pathname]);

  const body = (
    <Animated.View
      style={{
        padding: space.lg,
        paddingBottom: space.xxl,
        opacity: entrance,
        transform: [
          {
            translateY: entrance.interpolate({
              inputRange: [0, 1],
              outputRange: [12, 0],
            }),
          },
        ],
      }}
    >
      {/*
        THE WAY BACK AND THE TITLE, in the page rather than in a bar — the
        comp's 40pt rounded square on `surface2` and a 20pt title. Rendered
        here so a screen cannot forget it or draw a second one.
      */}
      {back !== undefined && (
        <View
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 12,
            paddingTop: 8, paddingBottom: 14,
          }}
        >
          <Pressable
            // No ripple: a 40pt rounded square around a 21pt glyph lights up
            // as a disc, which is the report `.icon-btn` already carries.
            android_ripple={null}
            /*
             * BACK IF THERE IS A BACK, otherwise the href. `router.replace`
             * unconditionally was wrong on the platform this app is mostly
             * used on: replace does not push, so Android's gesture and
             * hardware back would leave the app rather than return to the
             * screen the customer came from. The href stays as the fallback
             * for a cold start straight into a deep link.
             */
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace(back as never)
            }
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={8}
            style={{
              width: 40, height: 40, borderRadius: 12,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: colors.surface2,
              borderWidth: 1, borderColor: colors.edge,
            }}
          >
            <Icon name="chevronLeft" size={21} color={colors.text} />
          </Pressable>
          {title !== undefined && (
            <Text
              numberOfLines={1}
              style={{
                flex: 1, minWidth: 0,
                color: colors.text, fontFamily: font.sansBold,
                fontSize: 20, letterSpacing: -0.4,
              }}
            >
              {title}
            </Text>
          )}
        </View>
      )}
      {children}
    </Animated.View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      {/*
        NO HEADER BAR ON A SCREEN ONE LEVEL DOWN.

        The comp opens such a screen directly on a 40px rounded-square back
        button and a 20px title INSIDE the page — no mark, no theme toggle,
        because those belong to the screen a customer opens the app on rather
        than the one they stepped into. The bar was taking 56pt of a handset
        permanently to show a chevron and a word; the comp spends that on the
        thing the screen is for and puts the way back in the content, where it
        scrolls with everything else.

        The web's `Shell` makes the same change in the same place, so the two
        apps cannot disagree about what a sub-screen looks like.
      */}
      {back === undefined && (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          height: 56,
          paddingHorizontal: space.md,
        }}
      >
        {greeting !== undefined ? (
          <>
            {/* The initials are DERIVED, never stored — `initialsOf` returns
                nothing rather than a placeholder letter, because an avatar
                reading "T" for "there" is a made-up initial on the screen
                that says who you are signed in as. */}
            <View
              style={{
                width: 40, height: 40, borderRadius: 999,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: colors.avatar,
                borderWidth: 1, borderColor: colors.irisEdge,
              }}
            >
              {initialsOf(greeting.name) === undefined ? (
                <Logo size={17} />
              ) : (
                <Text style={{ color: colors.avatarText, fontFamily: font.sansBold, fontSize: 14 }}>
                  {initialsOf(greeting.name)}
                </Text>
              )}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{ color: colors.text3, fontFamily: font.sansMedium, fontSize: 12.5 }}
              >
                Welcome back
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  color: colors.text, fontFamily: font.sansBold,
                  fontSize: 16, letterSpacing: -0.2,
                }}
              >
                {greeting.name ?? 'there'}
              </Text>
            </View>
          </>
        ) : (
          <Logo size={22} />
        )}
        <View style={{ flex: 1 }} />
        <ThemeToggle />
      </View>
      )}

      {/*
        THE KEYBOARD MUST NOT COVER THE FIELD BEING TYPED IN.
        
        Here rather than on each screen, for the reason the entrance animation
        is: a fix a screen has to remember to apply is a fix some screen will
        not have. Every signed-in screen in this app goes through `Shell`.
        
        `padding` ON iOS AND `height` ON ANDROID, and both are computed from
        the OVERLAP between this view's frame and the keyboard rather than
        from the keyboard's height. That is what makes it correct under either
        Android behaviour: where the window has already been resized by
        `adjustResize` the frame no longer overlaps and this adds nothing,
        and where it has not — which is what edge-to-edge on Android 15
        brought — the frame is shortened by exactly the amount that was
        covered. Adding the keyboard's height unconditionally would double up
        in the first case and leave a gap the size of a keyboard under the
        content.
        
        Shortening the ScrollView is also what makes the field VISIBLE rather
        than merely reachable: with a correct visible rect, both platforms
        scroll a newly focused TextInput into it themselves.
      */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {scroll ? (
          <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: space.xxl }}
          >
            {body}
          </ScrollView>
        ) : (
          <View style={{ flex: 1 }}>{body}</View>
        )}
      </KeyboardAvoidingView>

      {overlay}

      <View
        style={{
          flexDirection: 'row',
          borderTopWidth: 1,
          borderTopColor: colors.line,
          // `bg`, not `surface`: the tab bar is chrome rather than a
          // container, and a recessed strip along the bottom of a white page
          // reads as a gap in it. Matches `.tabbar` on the web.
          backgroundColor: colors.bg,
          paddingBottom: insets.bottom,
        }}
      >
        {TABS.map((tab) => {
          const active = isActive(tab.href);
          return (
            /*
             * `replace`, not push. A tab bar SWITCHES between destinations; it
             * does not descend into them. Pushing meant tapping Home, Cards,
             * Home, Cards built a four-deep stack, and Android's back gesture
             * then walked the customer backwards through every tap they had
             * ever made instead of leaving the app. The web's tab bar has
             * always behaved this way because a browser link does.
             */
            <Link key={tab.href} href={tab.href as never} replace asChild>
              {/*
                The tab bar keeps its ripple deliberately. It is a full-width
                target, so the ripple reads as the tab lighting up rather than
                as a disc appearing behind a glyph — which is what made the
                same effect wrong on a 44pt icon button.
              */}
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={{ flex: 1, alignItems: 'center', paddingVertical: 10, gap: 3 }}
              >
                <Icon
                  name={tab.icon}
                  size={22}
                  color={active ? colors.text : colors.text3}
                />
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: active ? '700' : '500',
                    color: active ? colors.text : colors.text3,
                  }}
                >
                  {tab.label}
                </Text>
              </Pressable>
            </Link>
          );
        })}
      </View>
    </View>
  );
}
