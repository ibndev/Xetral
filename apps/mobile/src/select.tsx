import { useState } from 'react';
import { FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/icon';
import { font, radius, space, useStyles, useTheme } from '@/theme';

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
  renderTrigger,
  searchable = false,
  searchPlaceholder = 'Search…',
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
   * `dial` is a pill sized down further, for the dialling code IN FRONT OF a
   * phone number, where every pixel it takes is a digit pushed off a handset.
   * The sheet is identical in all three; only the trigger differs.
   */
  readonly variant?: 'field' | 'pill' | 'dial';
  /** An optional badge before the label, on the trigger and in the sheet. */
  readonly renderMark?: (value: string) => React.ReactNode;
  /** What the TRIGGER shows, when that is not the option's label. The dialling
   *  picker needs the sheet to say "Nigeria" and the trigger to say "+234". */
  readonly renderTrigger?: (value: string) => React.ReactNode;
  /**
   * A FILTER AT THE TOP OF THE SHEET, for a list nobody can scan.
   *
   * Off by default: a currency picker has five rows and a keyboard opening
   * over them is worse than the list. The Nigerian bank list is the opposite
   * case — Paystack returns upwards of a hundred, alphabetical, and finding
   * one by flicking is the customer doing the computer's work.
   */
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
}) {
  const styles = useStyles();
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = options.find((o) => o.value === value);

  /*
   * Matched ANYWHERE in the label, not at the start. Somebody looking for
   * "GTBank" in a list that calls it "Guaranty Trust Bank" is exactly the
   * case a prefix match fails, and it is the commonest bank in the country.
   */
  const needle = query.trim().toLowerCase();
  const shown =
    searchable && needle !== ''
      ? options.filter((o) => o.label.toLowerCase().includes(needle))
      : options;

  /** The filter belongs to one opening of the sheet. */
  function dismiss(): void {
    setQuery('');
    setOpen(false);
  }

  const dial = variant === 'dial';
  const pill = variant === 'pill' || dial;

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
                /*
                 * THE DIAL VARIANT IS THE SAME CONTROL, NARROWER. Measured on
                 * the web, the equivalent affix was 109px wide with two
                 * pixels between it and the first digit — a third of a 320px
                 * field spent on a country code, and an `8` that looked like
                 * it was underneath the picker. These are the same reductions.
                 */
                gap: dial ? 5 : 6,
                paddingLeft: dial ? 8 : 12,
                paddingRight: dial ? 6 : 10,
                height: dial ? 42 : 40,
                borderRadius: dial ? radius.md : radius.pill,
                backgroundColor: dial ? colors.field : colors.surface2,
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
        {renderTrigger !== undefined && selected !== undefined ? (
          renderTrigger(selected.value)
        ) : (
        <Text
          style={{
            color: selected === undefined ? colors.text3 : colors.text,
            fontSize: pill ? 15 : 16,
            fontFamily: pill ? font.sansBold : font.sans,
            flex: pill ? 0 : 1,
          }}
        >
          {selected?.label ?? placeholder}
        </Text>
        )}
        <Icon name="chevronDown" size={dial ? 15 : 18} color={colors.text3} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        // Slide, because a sheet that fades in reads as an error dialog.
        animationType="slide"
        // Android's hardware back must close the sheet rather than leave the
        // screen — otherwise opening a picker and pressing back signs a
        // customer out of the flow they were halfway through.
        onRequestClose={dismiss}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={dismiss}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
        >
          {/* Its own Pressable with no handler, so a tap on the sheet does not
              fall through to the scrim behind it and close what it landed on. */}
          <Pressable
            onPress={() => undefined}
            style={{
              // `surfaceRaised`, because a sheet over a scrim is in front of
              // the page. `surface` is the recessed fill every container uses
              // and would put this visually BEHIND what it is covering.
              backgroundColor: colors.surfaceRaised,
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

            {searchable && (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  marginHorizontal: space.lg,
                  marginBottom: space.sm,
                  paddingHorizontal: space.md,
                  height: 44,
                  borderRadius: radius.md,
                  backgroundColor: colors.surface,
                }}
              >
                <Icon name="search" size={16} color={colors.text3} />
                <TextInput
                  style={{ flex: 1, color: colors.text, fontSize: 16, fontFamily: font.sans }}
                  placeholder={searchPlaceholder}
                  placeholderTextColor={colors.text3}
                  value={query}
                  onChangeText={setQuery}
                  autoCapitalize="none"
                  autoCorrect={false}
                  // A bank's name is not a word, so neither correction nor
                  // capitalisation helps, and both get in the way.
                  autoFocus
                  returnKeyType="search"
                />
              </View>
            )}

            {searchable && shown.length === 0 && (
              // SAYS SO rather than showing an empty sheet, which is
              // indistinguishable from a list that failed to load.
              <Text
                style={{
                  color: colors.text3,
                  fontSize: 14,
                  paddingHorizontal: space.lg,
                  paddingVertical: space.lg,
                }}
              >
                No match for “{query.trim()}”.
              </Text>
            )}

            <FlatList
              data={[...shown]}
              keyboardShouldPersistTaps="handled"
              keyExtractor={(o) => o.value}
              renderItem={({ item }) => {
                const on = item.value === value;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => {
                      onChange(item.value);
                      dismiss();
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
