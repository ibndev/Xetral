import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ApiError, entryKindLabel, entryTitle, exponentFor, formatAmount, isValidAmount } from '@xetral/client';
import type { Card, CardActivity, CardFundingPlan, CardSecrets } from '@xetral/client';

/** Refusals that mean the stored plan can no longer run — start a new one. */
const REPLAN: ReadonlySet<string> = new Set(['rate_moved', 'insufficient_funds', 'below_minimum', 'pair_not_supported']);
import { Logo } from '@/logo';
import { Shell } from '@/shell';
import { Icon } from '@/icon';
import type { IconName } from '@/icon';
import { Button, Done, Field, FormError, Loading, Panel, VerifyPrompt } from '@/ui';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { Select } from '@/select';
import { CurrencyMark } from '@/currency-mark';
import { font, radius, space, useStyles, useTheme, onGround } from '@/theme';

/**
 * Virtual USD cards, on the phone.
 *
 * The balance shown is the LEDGER'S, not Bitnob's. A provider figure can lag a
 * settlement by days, and the ledger is what we owe — showing the provider's
 * number would mean a customer watching a balance that disagrees with what
 * they can actually spend. Same rule as the web, and the same source.
 */
export default function Cards() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  /* The list AND the price, on one request — see the web's Cards screen: a
     figure typed into this file would show the old price from the moment an
     operator changed the setting. */
  const cards = useLoad(() => client.cardList(), [client]);
  const list = cards.data?.cards;
  const identity = useLoad(() => client.kyc().catch(() => null), [client]);
  const holder = identity.data?.full_name;

  if (cards.code === 'kyc_required') {
    return (
      <Shell>
        <Text style={styles.h1}>Cards</Text>
        <Text style={styles.lead}>Virtual dollar cards, funded from your wallet</Text>
        <View style={{ marginTop: space.lg }}>
          <VerifyPrompt what="a USD card" />
        </View>
      </Shell>
    );
  }

  /*
   * GETTING A FIRST CARD IS AN ONBOARDING STEP, the same as on the web. A
   * customer with none saw an empty state and a three-field form; they now
   * see the card and what it does before anything is asked of them.
   */
  const none = !cards.loading && (list?.length ?? 0) === 0;
  const [adding, setAdding] = useState(false);

  /** Set by tapping Create card without a verified identity. */
  const [askingToVerify, setAskingToVerify] = useState(false);

  return (
    <Shell>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.h1}>Your cards</Text>
          {/* Short enough for one line beside the button — the web's own
              change, for the same reason: the long version wrapped and left
              "cards" alone on a second line under a heading that says it. */}
          <Text style={styles.lead}>Spend online in dollars</Text>
        </View>
        {(list?.length ?? 0) > 0 && !adding && (
          <Button label="Add a card" icon="plus" quiet onPress={() => setAdding(true)} />
        )}
      </View>

      <View style={{ marginTop: space.lg, gap: space.md }}>
        {cards.loading && <Loading />}
        {/* The specimen: the SAME component with no card, so the preview and
            the product cannot drift apart. */}
        {none && <CardFace holder={holder} />}
        {list?.map((card, index) => (
          <View key={card.id} style={{ gap: space.sm }}>
            <CardRow card={card} holder={holder} onChange={cards.reload} />
            {(list?.length ?? 0) > 1 && (
              <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center' }}>
                {list?.map((c, i) => (
                  <View
                    key={c.id}
                    style={{
                      width: 22,
                      height: 3,
                      borderRadius: 2,
                      backgroundColor: i === index ? colors.link : colors.lineStrong,
                    }}
                  />
                ))}
              </View>
            )}
          </View>
        ))}
      </View>

      <FormError error={cards.error} code={cards.code} />

      {/* Only where there is a card to have spent anything. On the onboarding
          screen it would be an empty section under a specimen, which reads as
          a feature that is broken rather than one not yet used. */}
      {(list?.length ?? 0) > 0 && <CardActivityList />}

      {/*
        SPACE UNDER THE CARD. The specimen sits in a stack with its own gap and
        the panel below is that stack's SIBLING, so nothing separated them —
        the card looked like it was resting on the box rather than above it.
        `styles.card` carries a bottom margin and no top one, which is right
        everywhere else and wrong at exactly this seam.
      */}
      {/*
        THE OFFER IS ALWAYS SHOWN; THE KYC SECTION APPEARS WHEN THEY ASK FOR A
        CARD — the web's arrangement, and the same reasoning. Hiding the offer
        from an unverified customer means they never learn what the product is
        or what it costs; showing it and then asking for a PIN before
        mentioning KYC is the opposite mistake.

        BITNOB NEEDS THE IDENTITY BEFORE IT WILL ISSUE, which is why the check
        is here and not after payment: `provider_customers` is written by KYC
        approval and `POST /v1/cards` refuses without it, before the price is
        charged. Taking the money first would be charging for a card we
        already know cannot be created.
      */}
      {(none || adding) && !askingToVerify && (
        <View style={{ marginTop: space.lg }}>
        <Issue
          price={cards.data?.issuance_fee}
          verified={identity.data?.status === 'approved'}
          onNeedsVerification={() => setAskingToVerify(true)}
          onIssued={() => {
            setAdding(false);
            cards.reload();
          }}
        />
        </View>
      )}

      {(none || adding) && askingToVerify && (
        <View style={{ marginTop: space.lg }}>
          <VerifyPrompt
            what="a USD card"
            title="As required by CBN, please complete your KYC."
            cta="Verify KYC"
          />
        </View>
      )}
    </Shell>
  );
}

/**
 * The card face — the same design as the web's, drawn with React Native.
 *
 * NOTHING NEW IS SHOWN. The number is the masked `last4` the list has always
 * carried; there is no PAN here and no state that could hold one outside
 * `secrets` below, which has a sixty-second life. The cardholder name comes
 * from the VERIFIED IDENTITY: `name_on_card` is sent to the provider at issue
 * and deliberately never stored here, and a card cannot exist without an
 * approved KYC record.
 */
/**
 * The three finishes, as FLAT bases.
 *
 * The web draws each as a gradient; React Native has no gradient primitive and
 * this app deliberately ships no gradient library, so each is the one tone the
 * web's gradient reads as from arm's length. They are written out here rather
 * than taken from the palette for the same reason the graphite base is: the
 * palette INVERTS for dark, and a card face built from it turns near-white.
 */
const CARD_FACES: Record<string, string> = {
  // PURE BLACK, matching the web's base after it stopped starting at a mid
  // grey. The gloss is the translucent white disc below, not a lighter black.
  graphite: '#000000',
  sapphire: '#070C15',
  emerald: '#04100A',
};

function CardFace({
  card,
  holder,
  colour,
}: {
  /** Absent for the SPECIMEN — the card a customer is shown before they have
   *  one. Same component, so the preview cannot drift from the product. */
  readonly card?: Card;
  readonly holder: string | undefined;
  /** What the picker has chosen, for the specimen. A real card carries its
   *  own, so this is only how the preview follows the swatches. */
  readonly colour?: string | undefined;
}) {
  const expiry =
    card === undefined || card.expiry_month === null || card.expiry_year === null
      ? '••/••'
      : `${String(card.expiry_month).padStart(2, '0')}/${String(card.expiry_year).slice(-2)}`;

  const status = card?.status;
  const pill =
    status === undefined
      ? // THE BADGE HAS TO SIT ON THE FACE, NOT OVER IT. A 14%-white fill on a
        // near-black card is lighter than anything around it, so the chip read
        // as a separate object stuck onto the card rather than printed on it.
        // A dark fill with a hairline is the same cue every other status uses.
        { bg: 'rgba(255,255,255,.07)', fg: 'rgba(255,255,255,.82)' }
      : status === 'active'
        ? { bg: 'rgba(74,222,128,.20)', fg: '#4ADE80' }
        : status === 'frozen'
          ? { bg: 'rgba(251,191,36,.22)', fg: '#FBBF24' }
          : { bg: 'rgba(248,113,113,.20)', fg: '#F87171' };

  return (
    <View
      accessible
      accessibilityLabel={
        card === undefined
          ? 'What a Xetral card looks like'
          : `Card ending ${card.last4 ?? 'unknown'}, ${status ?? ''}`
      }
      style={{
        // The real proportion, so it reads as a card at any width rather than
        // as a panel that happens to be dark.
        aspectRatio: 1.586,
        borderRadius: radius.lg,
        padding: space.lg,
        justifyContent: 'space-between',
        overflow: 'hidden',
        /*
         * BLACK, in both themes, and written out rather than taken from the
         * palette: `colors.brand` INVERTS for dark, so a face built from it
         * turns near-white with white text on it.
         *
         * It was navy, which reads as another themed panel — the card took the
         * brand's hue and became a surface. A premium card is black: the
         * material is the statement and what moves on it is light, not colour.
         * React Native has no gradient primitive and this app ships no gradient
         * library, so the near-black base is flat and the highlight below is
         * one translucent disc — the same light from the same corner as the
         * web's, at the fidelity a View can give.
         */
        backgroundColor: CARD_FACES[colour ?? card?.colour ?? 'graphite'] ?? CARD_FACES.graphite,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,.14)',
        opacity: status === 'terminated' ? 0.55 : status === 'frozen' ? 0.8 : 1,
      }}
    >
      {/* The blue wash the web draws with two radial gradients. React Native
          has no gradient primitive and this app deliberately ships no
          gradient library, so it is one translucent disc — the same light
          from the same corner, at the fidelity a View can give. */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          right: -60,
          top: -80,
          width: 220,
          height: 220,
          borderRadius: 110,
          // WHITE, not blue. On a black face a blue disc is a colour cast; a
          // white one is light falling on the material.
          backgroundColor: 'rgba(255,255,255,.13)',
        }}
      />

      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {/* THE WHOLE WORD, not the mark alone.
            This drew `LogoMark`, which is the X and nothing else — so the
            phone's card said "X" where the web's says "Xetral". `Logo` is the
            lockup: the mark AS the letter X, then "etral". */}
        <Logo size={20} tone="inverse" />
        <View
          style={{
            paddingHorizontal: 10,
            paddingVertical: 3,
            borderRadius: radius.pill,
            backgroundColor: pill.bg,
          }}
        >
          <Text style={{ color: pill.fg, fontSize: 11, fontFamily: font.sansBold }}>
            {status ?? 'Virtual'}
          </Text>
        </View>
      </View>

      <Text
        style={{
          color: 'rgba(255,255,255,.94)',
          fontFamily: font.mono,
          fontSize: 19,
          letterSpacing: 2.5,
        }}
      >
        {card?.last4 == null ? '•••• •••• •••• ••••' : `•••• •••• •••• ${card.last4}`}
      </Text>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ gap: 9, flex: 1, minWidth: 0 }}>
          <FaceField label="Valid thru" value={expiry} mono />
          <FaceField label="Card holder" value={holder ?? '—'} />
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          {/*
            The scheme every Bitnob virtual card is issued on, in the mark's
            own slanted form.

            THE SLANT IS A TRANSFORM, NOT `fontStyle`. React Native matches a
            custom `fontFamily` BY NAME, and there is no italic face
            registered — so `fontStyle: 'italic'` sent Android looking for a
            face that does not exist and it fell back to the system font at
            regular weight. That is the "VISA is too light" report: the same
            class of bug as `fontWeight` beside a custom family, which
            `fonts.test.ts` now also refuses. `skewX` is drawn by the view
            layer and never touches font matching, so the ExtraBold face
            survives.
          */}
          <Text
            style={{
              color: '#fff',
              fontFamily: font.displayBold,
              fontSize: 26,
              letterSpacing: -1,
              transform: [{ skewX: '-9deg' }],
            }}
          >
            VISA
          </Text>
          <Text style={{ color: '#fff', fontSize: 11, letterSpacing: 1, marginTop: 3 }}>
            {card?.currency ?? 'USD'}
          </Text>
        </View>
      </View>
    </View>
  );
}

function FaceField({
  label,
  value,
  mono,
  right,
  flex,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly right?: boolean;
  readonly flex?: boolean;
}) {
  return (
    <View style={[{ gap: 2 }, flex === true && { flex: 1, minWidth: 0 }]}>
      <Text
        style={{
          color: 'rgba(255,255,255,.55)',
          fontSize: 9,
          fontFamily: font.sansBold,
          letterSpacing: 1,
          textAlign: right === true ? 'right' : 'left',
        }}
      >
        {label.toUpperCase()}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          color: '#fff',
          fontSize: 13,
          fontFamily: font.sansSemi,
          textAlign: right === true ? 'right' : 'left',
          ...(mono === true ? { fontFamily: font.mono } : {}),
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function CardRow({
  card,
  holder,
  onChange,
}: {
  readonly card: Card;
  readonly holder: string | undefined;
  readonly onChange: () => void;
}) {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { busy, error, code, done, run } = useSubmit();
  const [pin, setPin] = useState('');
  const [amount, setAmount] = useState('');
  const funding = useIdempotencyKey();
  /*
   * WHICH WALLETS PAY IS THE SERVER'S DECISION — the web's rule exactly: the
   * sheet asks for dollars, shows the server's plan for that figure, and the
   * top-up follows it. The customer is never asked which balance to use.
   * Stamped with the amount it is for, and shown only on a match.
   */
  const [plan, setPlan] = useState<{ forAmount: string; plan: CardFundingPlan }>();
  useEffect(() => {
    if (!isValidAmount(amount, exponentFor(card.currency)) || /^0*(\.0*)?$/.test(amount)) return;
    const asked = amount;
    const timer = setTimeout(() => {
      client
        .cardFundingPlan(card.id, asked)
        .then((p) => setPlan({ forAmount: asked, plan: p }))
        .catch(() => setPlan(undefined));
    }, 300);
    return () => clearTimeout(timer);
  }, [client, amount, card.id, card.currency]);
  const planned = plan !== undefined && plan.forAmount === amount ? plan.plan : undefined;
  const converting = planned?.legs.some((leg) => leg.converted) ?? false;
  /* The card's base currency, set once — the web's options exactly. */
  const [choosingBase, setChoosingBase] = useState(false);
  const wallets = useLoad(() => client.balances(), [client]);
  const baseOptions = [
    { value: '', label: 'My home currency' },
    ...(wallets.data ?? [])
      .filter((b) => b.currency !== card.currency)
      .map((b) => ({ value: b.currency, label: `${b.currency} balance`, hint: `${formatAmount(b.spendable, b.currency)} now` })),
  ];
  /*
   * WHICH ACTION THE PIN IS FOR.
   *
   * THIS SCREEN RENDERED THREE PIN FIELDS AT ONCE — one for unfreeze, one
   * inside the top-up form and one under "Show card details" — all bound to
   * the same `pin` state. A frozen card showed all three stacked, so the
   * customer saw the same secret asked for three times with three different
   * labels and no way to tell which one mattered. A secret asked for
   * repeatedly with no stated purpose is the habit that makes somebody type it
   * when a stranger asks.
   *
   * One action, then the PIN for that action, named — the same order the Send
   * screen and the card purchase now follow, and the same fix as the web's.
   */
  const [pending, setPending] = useState<'fund' | 'unfreeze' | 'reveal' | undefined>(undefined);

  /** Leaves the PIN nowhere. A cancelled action must not leave the secret in
   *  state for the next one to reuse. */
  function cancel(): void {
    setPin('');
    setPending(undefined);
  }
  /*
   * NAMING THE CARD — the step that comes AFTER buying one, and the reason the
   * onboarding form no longer asks. A second card is otherwise
   * indistinguishable from the first: every face reads four digits and the
   * same verified name. No PIN, because nothing moves.
   */
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState(card.label ?? '');

  /**
   * The revealed number, held ONLY while it is on screen.
   *
   * Component state, never SecureStore, never a module variable, and cleared
   * by the timer below. A card number that outlives the moment a customer
   * asked for it is a card number sitting in a backgrounded app.
   */
  const [secrets, setSecrets] = useState<CardSecrets | undefined>();

  useEffect(() => {
    if (secrets === undefined) return undefined;
    const timer = setTimeout(() => setSecrets(undefined), 60_000);
    return () => clearTimeout(timer);
  }, [secrets]);

  return (
    /*
      NO PANEL AROUND THE CARD, matching the web.

      It was `styles.card` — a bordered surface with the card drawn inside it,
      which is a picture of a card inside a picture of a card. The face has
      its own edge, its own shadow and its own material; a container behind it
      adds a second frame and shrinks the one thing on this screen meant to be
      recognised before it is read.
    */
    <View style={{ gap: space.md }}>
      <CardFace card={card} holder={holder} />

      {/*
        THE BALANCE IS A FIGURE, NOT A TABLE ROW — the web's own change.

        It was `Balance   $12.00` in a two-column row, which is an accurate
        summary and reads as a settings list. What is on the card is the one
        number this screen exists to answer, so it is set the way the home
        screen sets a balance, with the name beside it as a label rather than
        above it as a peer.
      */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <View>
          <Text style={{ color: colors.text3, fontFamily: font.sansSemi, fontSize: 12 }}>
            On this card
          </Text>
          <Text
            style={{
              color: colors.text, fontFamily: font.numBold,
              fontSize: 26, letterSpacing: -0.8, marginTop: 3,
            }}
          >
            {formatAmount(card.balance, card.currency)}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', minWidth: 0, flexShrink: 1 }}>
          <Text style={{ color: colors.text3, fontFamily: font.sansSemi, fontSize: 12 }}>Name</Text>
          <Text
            numberOfLines={1}
            style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 14.5, marginTop: 4 }}
          >
            {card.label ?? `Card ending ${card.last4 ?? '••••'}`}
          </Text>
        </View>
      </View>

      {card.base_currency !== undefined && card.status !== 'terminated' && (
        <View style={[{ padding: 12, borderRadius: radius.md, gap: 6 }, { ...onGround(colors), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
          <View style={{ gap: 2, flexShrink: 1 }}>
            <Text style={{ color: colors.text3, fontFamily: font.sansSemi, fontSize: 12 }}>Tops up from</Text>
            <Text style={{ color: colors.text, fontFamily: font.sansBold, fontSize: 14 }}>
              {card.currency}, then {card.base_currency}
              {card.base_currency_chosen === false ? ' · your home currency' : ''}
            </Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => setChoosingBase((was) => !was)} hitSlop={8}>
            <Text style={{ color: colors.link, fontFamily: font.sansSemi, fontSize: 14 }}>
              {choosingBase ? 'Done' : 'Change'}
            </Text>
          </Pressable>
        </View>
      )}
      {choosingBase && (
        <Select
          label={`After ${card.currency}, draw on`}
          value={card.base_currency_chosen === true ? (card.base_currency ?? '') : ''}
          onChange={(next) =>
            void run(async () => {
              await client.setCardBaseCurrency(card.id, next === '' ? null : next);
              setChoosingBase(false);
              onChange();
              return 'Saved. Every top-up follows this order.';
            })
          }
          options={baseOptions}
          renderMark={(value) => (value === '' ? null : <CurrencyMark currency={value} size={20} />)}
        />
      )}

      {naming ? (
        <>
          <Field
            label="What do you call this card?"
            placeholder="Subscriptions"
            maxLength={40}
            value={label}
            onChangeText={setLabel}
          />
          <Button
            label="Save name"
            busy={busy}
            onPress={() =>
              void run(async () => {
                // An empty box CLEARS the name rather than storing a blank one
                // — the database refuses whitespace, so "" would be a 400 on
                // the obvious way to undo this.
                await client.nameCard(card.id, label.trim() === '' ? null : label.trim());
                setNaming(false);
                onChange();
                return 'Card renamed.';
              })
            }
          />
          <Button label="Cancel" quiet onPress={() => setNaming(false)} />
        </>
      ) : null}

      {/*
        FOUR TILES, WHICH IS THE HOME SCREEN'S ACTION ROW AT A SMALLER SIZE.

        They were four stacked full-width buttons — the shape this product
        uses for "Confirm" and "Cancel", applied to the four things a customer
        opens this screen to do, taking most of a handset between the card and
        anything else. A tile with its label under it is one vocabulary for an
        action, and reusing it here rather than inventing a second is most of
        what makes two screens look like one product.

        NOTHING ABOUT WHAT THEY DO CHANGED. Freezing still asks for nothing,
        and the server does not require a PIN either: a customer watching
        fraudulent charges land should not have to remember a PIN before they
        can stop them. Unfreezing re-enables spending, so it asks; and a
        frozen card can still be revealed, because freezing stops spending,
        not looking.
      */}
      {card.status !== 'terminated' && pending === undefined && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingTop: 18, paddingBottom: 6 }}>
          {card.status === 'active' ? (
            <CardAction
              icon="lock"
              label="Freeze"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  await client.freezeCard(card.id);
                  onChange();
                  return 'Card frozen.';
                })
              }
            />
          ) : (
            <CardAction icon="lock" label="Unfreeze" warm onPress={() => setPending('unfreeze')} />
          )}

          <CardAction icon="plus" label="Add money" onPress={() => setPending('fund')} />
          <CardAction icon="eye" label="Details" onPress={() => setPending('reveal')} />
          <CardAction
            icon="settings"
            label="Rename"
            onPress={() => {
              setLabel(card.label ?? '');
              setNaming(true);
            }}
          />
        </View>
      )}

      {/*
        ONE PANEL, NAMING WHAT IT IS ABOUT TO DO. The PIN never appears without
        a line saying which action it authorises, and it is the same field for
        all three — so there is no way for one of them to be reachable and
        another not, which is exactly what went wrong on the web.
      */}
      {pending !== undefined && (
        <View style={{ gap: space.sm }}>
          <Text style={styles.h2}>
            {pending === 'fund'
              ? 'Add money to this card'
              : pending === 'unfreeze'
                ? 'Unfreeze this card'
                : 'Show card details'}
          </Text>

          {pending === 'fund' && (
            <Field
              label={`Amount (${card.currency})`}
              inputMode="decimal"
              placeholder="25.00"
              value={amount}
              onChangeText={setAmount}
            />
          )}

          {pending === 'fund' && planned !== undefined && planned.covered && (
            <View style={[{ padding: 12, borderRadius: radius.md, gap: 6 }, onGround(colors)]}>
              <Text style={{ color: colors.text3, fontFamily: font.sansSemi, fontSize: 12 }}>Paid from</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {planned.legs.map((leg, index) => (
                  <View key={leg.currency} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {index > 0 && <Text style={{ color: colors.text3, fontFamily: font.sansSemi }}>+</Text>}
                    <CurrencyMark currency={leg.currency} size={16} />
                    <Text style={{ color: colors.text, fontFamily: font.sansBold, fontSize: 14 }}>
                      {formatAmount(leg.debit, leg.currency)}
                    </Text>
                  </View>
                ))}
              </View>
              {converting && (
                <Text style={styles.hint}>
                  Converted to dollars at today’s rate on the way. Your other balances are not touched.
                </Text>
              )}
            </View>
          )}
          {pending === 'fund' && planned !== undefined && !planned.covered && (
            <Text style={[styles.hint, { color: colors.danger }]}>
              Your balances together don’t cover {formatAmount(planned.amount, card.currency)}.
            </Text>
          )}

          <Field
            label="Transaction PIN"
            secureTextEntry
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChangeText={setPin}
          />

          <Button
            label={
              pending === 'fund'
                ? 'Add money to card'
                : pending === 'unfreeze'
                  ? 'Unfreeze card'
                  : 'Show details'
            }
            busy={busy}
            disabled={
              pin === '' ||
              (pending === 'fund' && (planned === undefined || !planned.covered))
            }
            onPress={() =>
              void run(async () => {
                if (pending === 'fund') {
                  // No wallet named: the server's cascade pays. A REFUSAL
                  // starts a new attempt (the next plan uses what is there
                  // now); a timeout does not — only its own key can replay it.
                  try {
                    await client.fundCard(card.id, { amount, pin, idempotencyKey: funding.key });
                  } catch (cause) {
                    if (cause instanceof ApiError && REPLAN.has(cause.code)) funding.next();
                    throw cause;
                  }
                  // A NEW key after a success: this form is now available for
                  // a genuinely different top-up, and reusing the old one
                  // would have the server replay the first and report success
                  // for money that never moved.
                  funding.next();
                  setAmount('');
                  cancel();
                  onChange();
                  return 'Card funded.';
                }
                if (pending === 'unfreeze') {
                  await client.unfreezeCard(card.id, pin);
                  cancel();
                  onChange();
                  return 'Card unfrozen.';
                }
                // The one action that returns something. `secrets` is separate
                // state with a sixty-second life; the PIN is dropped either way.
                setSecrets(await client.revealCard(card.id, pin));
                cancel();
                return undefined;
              })
            }
          />
          <Button label="Cancel" quiet onPress={cancel} />
        </View>
      )}

      {secrets !== undefined && (
        <View style={{ gap: 6, backgroundColor: 'transparent' }}>
          <Detail label="Card number" value={group(secrets.pan)} />
          <Detail
            label="Expiry"
            value={`${String(secrets.expiry_month).padStart(2, '0')}/${String(secrets.expiry_year).slice(-2)}`}
          />
          <Detail label="CVV" value={secrets.cvv} />
          <Text style={styles.hint}>
            These details disappear in a minute. Xetral will never ask you for them.
          </Text>
        </View>
      )}

      <FormError error={error} code={code} />
      <Done message={done} />
    </View>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.rowBetween}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.amount}>{value}</Text>
    </View>
  );
}

/**
 * Groups a card number in fours, without changing a digit.
 *
 * A sixteen-character run is unreadable and mistyped, and mistyping a card
 * number at a checkout is the failure a customer blames the card for.
 */
function group(pan: string): string {
  return pan.replace(/(.{4})/g, '$1 ').trim();
}

/**
 * GET YOUR XETRAL CARD — the onboarding step, matching the web.
 *
 * THERE IS NO CARD CREATION FEE and the figure here is not one. The reference
 * design puts "$5.00 · one-time payment" in this slot; nothing in this system
 * charges for issuance — `transfer_fee_basis_points` is the only fee there is
 * — so printing it would tell a customer they are being charged for something
 * that takes no money from them. The figure is the STARTING BALANCE, which is
 * what really moves here: wallet -> card, still the customer's own money.
 */
function Issue({
  price,
  verified,
  onNeedsVerification,
  onIssued,
}: {
  /** From the server, never from this file — see the web's Issue. */
  readonly price: string | undefined;
  /** Whether Bitnob will accept an issue for this customer at all. */
  readonly verified: boolean;
  readonly onNeedsVerification: () => void;
  readonly onIssued: () => void;
}) {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { busy, error, code, done, run } = useSubmit();
  const attempt = useIdempotencyKey();
  const [pin, setPin] = useState('');
  const [stage, setStage] = useState<'offer' | 'confirm'>('offer');

  const free = price === '0.00';

  /*
   * THE CONFIRM STEP, inline. It reads the same state the offer writes, so
   * there is nothing to pass and nothing that can be passed out of date — the
   * shape the Send screen uses, for the same reason.
   */
  if (stage === 'confirm') {
    return (
      <Panel title="Confirm" subtitle="Check this before you approve it">
        <View style={styles.row}>
          <Text style={styles.muted}>A virtual USD card</Text>
          <Text style={styles.amount}>{price === undefined ? '—' : `$${price}`}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.muted}>From</Text>
          <Text style={styles.amount}>Your USD wallet</Text>
        </View>

        <Field
          label="Transaction PIN"
          secureTextEntry
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={pin}
          onChangeText={setPin}
        />

        <Button
          label="Create my card"
          busy={busy}
          disabled={pin === ''}
          onPress={() =>
            void run(async () => {
              await client.issueCard({ pin, idempotencyKey: attempt.key });
              attempt.next();
              // Cleared the moment the request returns. A PIN authorises one
              // instruction; it is not a password to hold on to.
              setPin('');
              setStage('offer');
              onIssued();
              return 'Your card is on its way.';
            })
          }
        />
        <Button
          label="Back"
          quiet
          onPress={() => {
            setPin('');
            setStage('offer');
          }}
        />

        <FormError error={error} code={code} />
        <Done message={done} />
      </Panel>
    );
  }

  return (
    <Panel title="Get your Xetral card" subtitle="A virtual card for global payments">
      <View style={{ gap: space.md, marginTop: space.sm }}>
        <Benefit
          icon="globe"
          title="Spend anywhere"
          body="Use your card online and in-store where Visa is accepted."
        />
        <Benefit
          icon="zap"
          title="Instant issuance"
          body="Get your card and start spending."
        />
      </View>

      {/*
        THE PRICE AND THE BUTTON ON ONE ROW, matching the web.

        NO NAME, NO PIN AND NO STARTING BALANCE HERE. The name on a card is the
        customer's verified legal name and is not theirs to type; the starting
        balance is a second decision, made on the card once it exists; and the
        PIN authorises the purchase, so it is asked on the confirm step above.
      */}
      <View
        style={{
          marginTop: space.lg,
          paddingTop: space.lg,
          borderTopWidth: 1,
          borderTopColor: colors.line,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space.md,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.muted}>{free ? 'Your card' : 'Card price'}</Text>
          <Text style={[styles.balance, { fontSize: 34 }]}>
            {price === undefined ? '—' : free ? 'Free' : `$${price}`}
          </Text>
        </View>

        <Button
          label="Create card"
          icon="arrowRight"
          disabled={price === undefined}
          onPress={() => (verified ? setStage('confirm') : onNeedsVerification())}
        />
      </View>

      {/* UNDER THE ROW, not inside the price column. As a third line in that
          column it made the column taller than the button, so `flex-end` put
          the button level with the HINT rather than with the figure — "beside
          the price but lower". */}
      <Text style={styles.hint}>
        {free ? 'No charge to open one.' : 'One-time, from your USD wallet.'}
      </Text>

      <FormError error={error} code={code} />
      <Done message={done} />
    </Panel>
  );
}

/** One selling point: a circled icon, a heading and a line. */
function Benefit({
  icon,
  title,
  body,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
}) {
  const styles = useStyles();
  const colors = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}>
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          ...onGround(colors),
        }}
      >
        <Icon name={icon} size={20} color={colors.text2} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.h2, { fontSize: 15.5 }]}>{title}</Text>
        <Text style={[styles.lead, { marginTop: 4 }]}>{body}</Text>
      </View>
    </View>
  );
}

/**
 * One of the four things a customer can do to a card.
 *
 * A 50pt TILE AND A LABEL UNDER IT, which is the home screen's action row at
 * a smaller size. Reusing that shape rather than inventing a second is most
 * of what makes two screens look like one product — and it is why this takes
 * an icon and a word rather than the full-width `Button` the rest of this
 * file uses for "Confirm" and "Cancel".
 *
 * A FROZEN CARD'S UNFREEZE TILE IS THE WARM ONE, so the state is visible in
 * the control that changes it rather than only in a badge on the face.
 */
function CardAction({
  icon, label, onPress, warm, disabled,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
  readonly warm?: boolean;
  readonly disabled?: boolean;
}) {
  const colors = useTheme();
  /* NO FILLED TILE IN THIS ROW, which the comp is explicit about: its three
     tiles are identical wells on `surface2`. Filling one makes it the
     heaviest thing on a screen whose subject is the card above it. `warm`
     survives for a frozen card's Unfreeze, so the state is visible in the
     control that changes it. */
  const fill = warm === true ? colors.warnBg : colors.surface2;
  const ink = warm === true ? colors.warn : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled === true}
      // No ripple: on a 50pt tile around a 21pt glyph the ripple IS a
      // circular background, which is the report `.icon-btn` already carries.
      android_ripple={null}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      style={{ alignItems: 'center', gap: 8, opacity: disabled === true ? 0.5 : 1 }}
    >
      <View
        style={{
          width: 50, height: 50, borderRadius: 16,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: fill,
          borderWidth: 1,
          borderColor: warm === true ? colors.warnBg : colors.edge,
        }}
      >
        <Icon name={icon} size={21} color={ink} />
      </View>
      <Text
        numberOfLines={1}
        style={{ fontSize: 12, fontFamily: font.sansSemi, color: colors.text2 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * WHAT HAS HAPPENED ON THE CARDS.
 *
 * THE HEADING SAYS "Card activity" AND NOT "this card's", and that is the
 * ledger being honest rather than a wording choice. A card's role resolves to
 * ONE `customer_card` account per customer per currency, so nothing in
 * `postings` records which card a charge was on; a per-card list would be a
 * screen claiming a precision the books do not have.
 *
 * IT IS A SEPARATE READ FROM THE WALLET HISTORY, because a card spends its
 * OWN balance: an authorization moves card → pending with no
 * `customer_wallet` leg at all, so every card spend ever made was invisible
 * to the only history this product had.
 *
 * A FAILURE IS SILENT, DELIBERATELY. This is a decoration on a screen whose
 * job is the card and its controls; an error banner for a list that did not
 * load would put a red box between a customer and the Freeze button.
 */
function CardActivityList() {
  const client = useXetral();
  const colors = useTheme();
  const styles = useStyles();
  const activity = useLoad(
    () => client.cardActivity().catch(() => ({ entries: [] as readonly CardActivity[] })),
    [client],
  );
  const entries = activity.data?.entries ?? [];
  if (activity.loading || entries.length === 0) return null;

  let seen: string | undefined;
  return (
    <View style={{ marginTop: space.xl }}>
      {/* AN EYEBROW, NOT A HEADING, and NO DAY GROUPING — the comp draws a
          small uppercase label and then the rows. A card's activity is short
          and arrives in a burst; cutting eight rows into four one-row days is
          more structure than the content has. */}
      <Text
        style={{
          color: colors.text3, fontFamily: font.sansBold,
          fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase',
          paddingTop: 20, paddingBottom: 4,
        }}
      >
        Card activity
      </Text>
      {entries.slice(0, 8).map((t, i) => {
        const outgoing = t.amount.trim().startsWith('-');
        const when = new Date(t.occurred_at);
        const last = i === Math.min(entries.length, 8) - 1;
        return (
          <View
            key={t.id}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 13,
              paddingVertical: 12,
              borderBottomWidth: last ? 0 : 1,
              borderBottomColor: colors.line,
            }}
          >
            {/* A ROUNDED SQUARE, not the circle a wallet row uses: a card
                payment is to a MERCHANT, and a circle is this product's shape
                for a person. */}
            <View
              style={{
                width: 42, height: 42, borderRadius: 12,
                alignItems: 'center', justifyContent: 'center',
                // The card tone, as the web's rows wear it (`entryMark`).
                backgroundColor: outgoing ? colors.irisTint : colors.okBg,
              }}
            >
              <Icon name={outgoing ? 'card' : 'download'} size={19} color={outgoing ? colors.irisText : colors.ok} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 14.5 }}
              >
                {entryTitle(t.description, t.kind)}
              </Text>
              {/* The kind under the title, unless the title already IS the
                  kind — "Card top-up" twice reads as a rendering fault. */}
              {entryTitle(t.description, t.kind) !== entryKindLabel(t.kind) && (
                <Text
                  numberOfLines={1}
                  style={{ color: colors.text3, fontFamily: font.sansMedium, fontSize: 12, marginTop: 2 }}
                >
                  {entryKindLabel(t.kind)}
                </Text>
              )}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text
                style={{
                  fontFamily: font.numSemi, fontSize: 14,
                  fontVariant: ['tabular-nums'] as ('tabular-nums')[],
                  color: outgoing ? colors.danger : colors.ok,
                }}
              >
                {formatAmount(t.amount, t.currency)}
              </Text>
              <Text
                style={{ color: colors.text3, fontFamily: font.sansMedium, fontSize: 11.5, marginTop: 2 }}
              >
                {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

