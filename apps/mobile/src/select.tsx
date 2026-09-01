import { useState } from 'react';
import { FlatList, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/icon';
import { radius, space, useStyles, useTheme } from '@/theme';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  /** Second line, for an option that needs a word of explanation. */
  readonly hint?: string;
}

/**
 * The phone's dropdown, matching the one the web app draws.
 *
 * SAME REASON, DIFFERENT PLATFORM. On the web a native `<select>` hands the
 * open list to the operating system, which draws it in the system font on a
 * white sheet with no idea the app has a dark theme. React Native has no
 * `<select>` at all, so the equivalent mistake here is `Alert` or a
 * third-party picker — and this app has neither. What it had instead was a
 * wrapping cloud of chips, which is fine for four currencies and poor for a
 * data catalogue with twenty bundles in it.
 *
 * A BOTTOM SHEET, not a centred dialog. It is where a thumb already is, and
 * it is what every other app on the handset does for this — so it is the one
 * place where matching the platform and matching the web app agree.
 *
 * There is no search field. The longest list here is a bills catalogue; a
 * text input on a picker invites somebody to type something that is not in it
 * and wonder why nothing happens.
 */
export function Select({
  label,
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  variant = 'field',
  renderMark,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /**
   * `field` is a labelled input in a form. `pill` is a compact control that
   * sits INSIDE a card header — the currency selector on the balance card —
   * where a full-width field with a label above it would be a second heading.
   * The sheet is identical either way; only the trigger differs.
   */
  readonly variant?: 'field' | 'pill';
  /** An optional badge before the label, on the trigger and in the sheet. */
  readonly renderMark?: (value: string) => React.ReactNode;
}) {
  const styles = useStyles();
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  const selected = options.find((o) => o.value === value);

  const pill = variant === 'pill';

  return (
    <View style={pill ? undefined : { alignSelf: 'stretch' }}>
      {!pill && <Text style={styles.label}>{label}</Text>}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled }}
        accessibilityLabel={`${label}: ${selected?.label ?? placeholder}`}
        disabled={disabled}
        onPress={() => setOpen(true)}
        // No ripple and no pressed tint: the disc that appears behind a
        // control on touch is the thing the balance card was reported for.
        android_ripple={null}
        style={[
          pill
            ? {
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingLeft: 12,
                paddingRight: 10,
                height: 40,
                borderRadius: radius.pill,
                backgroundColor: colors.surface2,
              }
            : {
                ...styles.input,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              },
          { opacity: disabled ? 0.6 : 1 },
        ]}
      >
        {renderMark !== undefined && selected !== undefined && renderMark(selected.value)}
        <Text
          style={{
            color: selected === undefined ? colors.text3 : colors.text,
            fontSize: pill ? 15 : 16,
            fontWeight: pill ? '700' : '400',
            flex: pill ? 0 : 1,
          }}
        >
          {selected?.label ?? placeholder}
        </Text>
        <Icon name="chevronDown" size={18} color={colors.text3} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        // Slide, because a sheet that fades in reads as an error dialog.
        animationType="slide"
        // Android's hardware back must close the sheet rather than leave the
        // screen — otherwise opening a picker and pressing back signs a
        // customer out of the flow they were halfway through.
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={() => setOpen(false)}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
        >
          {/* Its own Pressable with no handler, so a tap on the sheet does not
              fall through to the scrim behind it and close what it landed on. */}
          <Pressable
            onPress={() => undefined}
            style={{
              backgroundColor: colors.surface,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              borderTopWidth: 1,
              borderColor: colors.line,
              paddingTop: space.sm,
              // The gesture bar sits under the last row otherwise, and the
              // last row is the one a thumb reaches first.
              paddingBottom: insets.bottom + space.md,
              maxHeight: '70%',
            }}
          >
            <View
              style={{
                alignSelf: 'center',
                width: 40,
                height: 4,
                borderRadius: radius.pill,
                backgroundColor: colors.lineStrong,
                marginBottom: space.sm,
              }}
            />
            <Text
              style={[styles.label, { paddingHorizontal: space.lg, marginBottom: space.xs }]}
            >
              {label}
            </Text>

            <FlatList
              data={[...options]}
              keyExtractor={(o) => o.value}
              renderItem={({ item }) => {
                const on = item.value === value;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => {
                      onChange(item.value);
                      setOpen(false);
                    }}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.sm,
                      paddingHorizontal: space.lg,
                      // 52, comfortably past the 44 minimum: this is a list a
                      // thumb scrolls and taps in one motion.
                      minHeight: 52,
                      paddingVertical: space.sm,
                    }}
                  >
                    {renderMark !== undefined && renderMark(item.value)}
                    <View style={{ flex: 1 }}>
                      <Text
                        style={{
                          color: colors.text,
                          fontSize: 16,
                          fontWeight: on ? '600' : '400',
                        }}
                      >
                        {item.label}
                      </Text>
                      {item.hint !== undefined && (
                        <Text style={{ color: colors.text3, fontSize: 13, marginTop: 2 }}>
                          {item.hint}
                        </Text>
                      )}
                    </View>
                    {on && <Icon name="check" size={18} color={colors.link} />}
                  </Pressable>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
