import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { formatAmount } from '@xetral/client';
import type { Card, CardSecrets } from '@xetral/client';
import { LogoMark } from '@/logo';
import { Shell } from '@/shell';
import { Button, Done, Empty, Field, FormError, Loading, Panel, VerifyPrompt } from '@/ui';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { font, radius, space, useStyles } from '@/theme';

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
  const cards = useLoad(() => client.cards(), [client]);
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

  return (
    <Shell>
      <Text style={styles.h1}>Cards</Text>
      <Text style={styles.lead}>Virtual dollar cards, funded from your wallet</Text>

      <View style={{ marginTop: space.lg, gap: space.md }}>
        {cards.loading && <Loading />}
        {!cards.loading && (cards.data?.length ?? 0) === 0 && (
          <Empty icon="card" title="No cards yet" hint="Get one below in a few seconds." />
        )}
        {cards.data?.map((card) => (
          <CardRow key={card.id} card={card} holder={holder} onChange={cards.reload} />
        ))}
      </View>

      <FormError error={cards.error} code={cards.code} />
      <Issue onIssued={cards.reload} />
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
function CardFace({
  card,
  holder,
}: {
  readonly card: Card;
  readonly holder: string | undefined;
}) {
  const expiry =
    card.expiry_month === null || card.expiry_year === null
      ? '••/••'
      : `${String(card.expiry_month).padStart(2, '0')}/${String(card.expiry_year).slice(-2)}`;

  const status = card.status;
  const pill =
    status === 'active'
      ? { bg: 'rgba(74,222,128,.20)', fg: '#4ADE80' }
      : status === 'frozen'
        ? { bg: 'rgba(251,191,36,.22)', fg: '#FBBF24' }
        : { bg: 'rgba(248,113,113,.20)', fg: '#F87171' };

  return (
    <View
      accessible
      accessibilityLabel={`Card ending ${card.last4 ?? 'unknown'}, ${status}`}
      style={{
        // The real proportion, so it reads as a card at any width rather than
        // as a panel that happens to be dark.
        aspectRatio: 1.586,
        borderRadius: radius.lg,
        padding: space.lg,
        justifyContent: 'space-between',
        // `#0D1B3E` written out, not `colors.brand`: brand INVERTS for the
        // dark theme, so a navy surface built from it turns near-white with
        // white text on it. This face is dark in both themes, like the web's.
        backgroundColor: '#0D1B3E',
        opacity: status === 'terminated' ? 0.55 : status === 'frozen' ? 0.8 : 1,
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <LogoMark size={20} tone="inverse" />
        <View
          style={{
            paddingHorizontal: 10,
            paddingVertical: 3,
            borderRadius: radius.pill,
            backgroundColor: pill.bg,
          }}
        >
          <Text style={{ color: pill.fg, fontSize: 11, fontFamily: font.sansBold }}>{status}</Text>
        </View>
      </View>

      <Text
        style={{
          color: 'rgba(255,255,255,.94)',
          fontFamily: font.mono,
          fontSize: 17,
          letterSpacing: 2,
        }}
      >
        {card.last4 === null ? '•••• •••• •••• ••••' : `•••• •••• •••• ${card.last4}`}
      </Text>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
        <FaceField label="Cardholder" value={holder ?? '—'} flex />
        <FaceField label="Expires" value={expiry} mono />
        <FaceField
          label="Balance"
          value={formatAmount(card.balance, card.currency)}
          mono
          right
        />
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
  const { busy, error, code, done, run } = useSubmit();
  const [pin, setPin] = useState('');
  const [amount, setAmount] = useState('');
  const [open, setOpen] = useState(false);
  const funding = useIdempotencyKey();

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
    <View style={[styles.card, { gap: space.md }]}>
      <CardFace card={card} holder={holder} />

      {card.status !== 'terminated' && (
        <View style={{ gap: space.sm }}>
          {/*
            Freezing asks for nothing, and the server does not require a PIN
            either. The reason is the same on both sides: a customer watching
            fraudulent charges land should not have to remember a PIN before
            they can stop them. Unfreezing re-enables spending, so it asks.
          */}
          {card.status === 'active' ? (
            <Button
              label="Freeze"
              quiet
              busy={busy}
              icon="lock"
              onPress={() =>
                void run(async () => {
                  await client.freezeCard(card.id);
                  onChange();
                  return 'Card frozen.';
                })
              }
            />
          ) : (
            <>
              <Field
                label="Transaction PIN"
                secureTextEntry
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChangeText={setPin}
              />
              <Button
                label="Unfreeze"
                quiet
                busy={busy}
                disabled={pin === ''}
                onPress={() =>
                  void run(async () => {
                    await client.unfreezeCard(card.id, pin);
                    setPin('');
                    onChange();
                    return 'Card unfrozen.';
                  })
                }
              />
            </>
          )}

          <Button
            label={open ? 'Cancel top-up' : 'Add money to card'}
            quiet
            icon="plus"
            onPress={() => setOpen((was) => !was)}
          />

          {open && (
            <>
              <Field
                label="Amount (USD)"
                inputMode="decimal"
                placeholder="25.00"
                value={amount}
                onChangeText={setAmount}
              />
              <Field
                label="Transaction PIN"
                secureTextEntry
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChangeText={setPin}
              />
              <Button
                label="Fund the card"
                busy={busy}
                disabled={amount === '' || pin === ''}
                onPress={() =>
                  void run(async () => {
                    await client.fundCard(card.id, {
                      amount,
                      pin,
                      idempotencyKey: funding.key,
                    });
                    // A NEW key after a success: this form is now available
                    // for a genuinely different top-up, and reusing the old
                    // one would have the server replay the first and report
                    // success for money that never moved.
                    funding.next();
                    setAmount('');
                    setPin('');
                    setOpen(false);
                    onChange();
                    return 'Card funded.';
                  })
                }
              />
            </>
          )}

          {/* A frozen card can still be revealed; a terminated one cannot.
              Freezing stops spending, not looking — a customer disputing
              charges still needs to read the number. */}
          <Field
            label="Transaction PIN, to show the number"
            secureTextEntry
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChangeText={setPin}
          />
          <Button
            label="Show card details"
            quiet
            icon="eye"
            busy={busy}
            disabled={pin === ''}
            onPress={() =>
              void run(async () => {
                setSecrets(await client.revealCard(card.id, pin));
                setPin('');
                return undefined;
              })
            }
          />
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

function Issue({ onIssued }: { readonly onIssued: () => void }) {
  const client = useXetral();
  const styles = useStyles();
  const { busy, error, code, done, run } = useSubmit();
  const attempt = useIdempotencyKey();
  const [name, setName] = useState('');
  const [funding, setFunding] = useState('');
  const [pin, setPin] = useState('');

  return (
    <Panel title="Get a new card">
      <Field label="Name on the card" value={name} onChangeText={setName} />
      <Field
        label="Starting balance (USD)"
        inputMode="decimal"
        placeholder="25.00"
        value={funding}
        onChangeText={setFunding}
      />
      <Field
        label="Transaction PIN"
        secureTextEntry
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onChangeText={setPin}
      />
      <Button
        label="Get a card"
        busy={busy}
        disabled={name.length < 2 || funding === '' || pin === ''}
        onPress={() =>
          void run(async () => {
            await client.issueCard({
              nameOnCard: name,
              initialFunding: funding,
              pin,
              idempotencyKey: attempt.key,
            });
            attempt.next();
            setPin('');
            onIssued();
            return 'Card requested.';
          })
        }
      />
      <FormError error={error} code={code} />
      <Done message={done} />
      <Text style={styles.hint}>
        You need a verified identity before a card can be issued.
      </Text>
    </Panel>
  );
}
