import { useState } from 'react';
import { Pressable, Share, Text, TextInput, View } from 'react-native';
import {
  exponentFor,
  formatAmount,
  isValidAmount,
  nationalPhone,
  paymentLinkFor,
  REQUEST_NOTE_MAX,
  requestLinkFor,
  symbolFor,
} from '@xetral/client';
import type { VirtualAccount } from '@xetral/client';
import { Shell } from '@/shell';
import { AcctCard, Eyebrow } from '@/acct-card';
import { Button, FormError, Loading, Segmented } from '@/ui';
import { useLoad, useXetral } from '@/hooks';
import { cardShadow, font, radius, space, useStyles, useTheme } from '@/theme';
import { webOrigin } from '@/session';
import { Icon } from '@/icon';

/**
 * ASKING TO BE PAID.
 *
 * IT WAS A PANEL AT THE BOTTOM OF ADD MONEY, and the home screen's Request
 * action and its Add action went to the SAME ROUTE — so a customer who tapped
 * Request landed on a screen headed "Add Money" and had to scroll past an
 * account number to find what they came for. Two of four actions leading to
 * one screen is a product saying it has three.
 *
 * TWO IDENTIFIERS, FOR TWO DIFFERENT PEOPLE, and 058's rule about why they
 * are not one string: the NUMBER is what another Xetral customer types into
 * Send; the LINK is a checkout a stranger pays on, so its address must not be
 * the number a customer's bank, contacts and two-factor codes are attached
 * to.
 *
 * AND NOW THE COMP'S REQUEST CARD — the web's own, for the same reasons: the
 * amount and reason ride on the link as a PREFILL (`requestLinkFor`) that the
 * payer's checkout opens with. It is still the payer who pays and the server
 * credits what was paid. The comp's "pending requests" list is not drawn,
 * because nothing records a request against a person.
 */
export default function Request() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const profile = useLoad(() => client.profile(), [client]);
  // Read and never opened here: registration opens it, and Add money opens it
  // for anybody who arrived without one.
  const account = useLoad(() => client.existingFundingAccount(), [client]);
  const session = useLoad(() => client.currentSession(), [client]);
  /* The customer's own country row, for its dialling code — the code lives on
     the country, not on the session. A missing row costs the trim only. */
  const countries = useLoad(() => client.session.countries(), [client]);
  const here = countries.data?.find((c) => c.code === session.data?.country);

  const phone = profile.data?.phone ?? null;
  // Their own dialling code, so it can come OFF the number: the Send screen
  // puts a dialling-code picker in front of its phone field, so the national
  // form is exactly what a sender types and the code beside it is a prefix
  // somebody would type twice.
  const local = nationalPhone(phone, here?.dial_code);
  const slug = profile.data?.slug ?? null;
  const link =
    profile.data?.link ??
    (slug !== null && webOrigin() !== '' ? paymentLinkFor(webOrigin(), slug) : null);

  const home = session.data?.home_currency ?? 'NGN';
  const currencies = [...new Set([home, 'USD'])];
  const [picked, setPicked] = useState('');
  const currency = picked === '' ? home : picked;
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [made, setMade] = useState<string | undefined>();
  const valid =
    amount.trim() !== '' &&
    isValidAmount(amount, exponentFor(currency)) &&
    !/^0+(\.0+)?$/.test(amount.trim());

  function share(url: string): void {
    const why = note.trim() === '' ? '' : ` for ${note.trim()}`;
    // Silent on failure: a dismissed share sheet rejects on iOS, which is
    // somebody changing their mind rather than an error.
    void Share.share({
      message: `Pay me ${formatAmount(amount.trim(), currency)}${why} on Xetral: ${url}`,
    }).catch(() => undefined);
  }

  return (
    <Shell back="/wallet" title="Request money">
      {/* THE COMP'S REQUEST CARD — the figure centred in the home screen's
          own face, the reason under it, one action. The payer's checkout is
          the same card, so asking and paying read as one thing. */}
      <View
        style={{
          alignItems: 'center',
          gap: space.sm,
          padding: space.lg,
          borderRadius: radius.xl,
          backgroundColor: colors.surface,
          borderColor: colors.edge,
          borderWidth: 1,
          ...cardShadow(colors),
        }}
      >
        <Text
          style={{
            fontFamily: font.sansSemi,
            fontSize: 12,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            color: colors.text3,
          }}
        >
          You request
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center' }}>
          <Text style={{ fontFamily: font.balance, fontSize: 32, color: colors.text2 }}>
            {symbolFor(currency)}
          </Text>
          <TextInput
            value={amount}
            onChangeText={(t) => {
              setAmount(t.replace(/[^0-9.]/g, ''));
              setMade(undefined);
            }}
            placeholder="0"
            placeholderTextColor={colors.text3}
            keyboardType="decimal-pad"
            accessibilityLabel={`Amount in ${currency}`}
            style={{
              fontFamily: font.balance,
              fontSize: 46,
              color: colors.text,
              minWidth: 40,
              textAlign: 'center',
              padding: 0,
            }}
          />
        </View>
        {currencies.length > 1 && (
          <View style={{ alignSelf: 'stretch' }}>
            <Segmented
              label="Currency"
              value={currency}
              onChange={(c) => {
                setPicked(c);
                setMade(undefined);
              }}
              options={currencies.map((c) => ({ value: c, label: c }))}
            />
          </View>
        )}
        <TextInput
          value={note}
          onChangeText={(t) => {
            setNote(t);
            setMade(undefined);
          }}
          maxLength={REQUEST_NOTE_MAX}
          placeholder="What's it for? (optional)"
          placeholderTextColor={colors.text3}
          accessibilityLabel="What it is for"
          style={[styles.input, { alignSelf: 'stretch', marginTop: space.xs }]}
        />
        <View style={{ alignSelf: 'stretch' }}>
          {made === undefined ? (
            <Button
              label="Create request link"
              disabled={!valid || link === null}
              onPress={() => {
                if (link === null || !valid) return;
                setMade(
                  requestLinkFor(link, {
                    amount: amount.trim(),
                    currency,
                    ...(note.trim() === '' ? {} : { note: note.trim() }),
                  }),
                );
              }}
            />
          ) : (
            <View style={{ gap: space.sm }}>
              <Text style={{ fontFamily: font.sansSemi, fontSize: 13, color: colors.ok, textAlign: 'center' }}>
                Request for {formatAmount(amount.trim(), currency)} ready
              </Text>
              <Text style={[styles.muted, { fontSize: 12.5, textAlign: 'center' }]} selectable>
                {made}
              </Text>
              <Button label="Share request" icon="arrowUpRight" onPress={() => share(made)} />
            </View>
          )}
        </View>
        <Text style={[styles.muted, { fontSize: 12.5, textAlign: 'center' }]}>
          They pay on a secure page, by card, bank transfer or mobile money. It lands in your{' '}
          {currency} wallet.
        </Text>
      </View>

      {profile.loading && <Loading />}

      {profile.data !== undefined && (
        <>
          <Eyebrow>Or share what is always yours</Eyebrow>
          {/* THE NUMBER GETS THE COMP'S ACCOUNT CARD, because it is the
              identifier a customer reads out — and the gradient panel appears
              once per screen for the reason it appears once on Add money. */}
          <AcctCard
            eyebrow="From a Xetral account"
            value={local === '' ? 'Not set' : local}
            sub={
              local === ''
                ? 'Add your phone number in Settings so other customers can find you.'
                : 'Another Xetral customer sends to this number. It arrives instantly and free.'
            }
            {...(local === '' ? {} : { share: local })}
          />

          <Eyebrow>From any bank</Eyebrow>

          {/* THE ACCOUNT DETAILS, WHERE THE PAYMENT LINK WAS — the web's own
              change. A sender in Nigeria pays by bank transfer and asks for a
              NAME, a BANK and a NUMBER, so those three are shown in full, each
              shareable, and together. The request link above still carries a
              checkout for anybody who needs one. */}
          <AccountDetails
            account={account.data ?? null}
            loading={account.loading}
          />
        </>
      )}

      <FormError error={profile.error} code={profile.code} />
    </Shell>
  );
}

/** The bank account a stranger pays into: a name, a bank and a number. */
function AccountDetails({
  account, loading,
}: {
  readonly account: VirtualAccount | null;
  readonly loading: boolean;
}) {
  const colors = useTheme();
  const styles = useStyles();
  const card = {
    marginTop: space.sm,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.edge,
    borderRadius: 18,
    paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14,
    ...cardShadow(colors),
  } as const;

  if (account === null) {
    return (
      <View style={[card, { paddingTop: 14 }]}>
        <Text style={styles.muted}>
          {loading
            ? 'Loading your account details…'
            : 'Your account number is still being opened. It appears here, and on Add money, as soon as it is ready.'}
        </Text>
      </View>
    );
  }

  const all = `Account name: ${account.account_name}\nBank: ${account.bank_name}\nAccount number: ${account.account_number}`;
  return (
    <View style={card}>
      <DetailRow label="Account number" value={account.account_number} large />
      <DetailRow label="Bank" value={account.bank_name} />
      <DetailRow label="Account name" value={account.account_name} last />
      <Button
        label="Share all details"
        icon="copy"
        quiet
        onPress={() => void Share.share({ message: all }).catch(() => undefined)}
      />
      <Text style={[styles.hint, { marginTop: space.sm }]}>
        Transfers into this account land in your {account.currency} wallet
        {account.status === 'active' ? ', usually within seconds.' : ' once it finishes activating.'}
      </Text>
    </View>
  );
}

/** One labelled value and its own Copy — what is shown is what is shared. */
function DetailRow({
  label, value, large, last,
}: {
  readonly label: string;
  readonly value: string;
  readonly large?: boolean;
  readonly last?: boolean;
}) {
  const colors = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        paddingVertical: 12,
        borderBottomWidth: last === true ? 0 : 1, borderBottomColor: colors.line,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ color: colors.text3, fontFamily: font.sansMedium, fontSize: 12 }}>{label}</Text>
        <Text
          selectable
          style={{
            color: colors.text,
            fontFamily: large === true ? font.numBold : font.sansSemi,
            fontSize: large === true ? 19 : 15,
            letterSpacing: large === true ? 0.6 : 0,
            fontVariant: ['tabular-nums'],
          }}
        >
          {value}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Copy ${label.toLowerCase()}`}
        android_ripple={null}
        onPress={() => void Share.share({ message: value }).catch(() => undefined)}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 5,
          paddingVertical: 6, paddingHorizontal: 10,
          borderRadius: 999, borderWidth: 1, borderColor: colors.edge,
          backgroundColor: colors.surface,
        }}
      >
        <Icon name="copy" size={13} color={colors.text2} />
        <Text style={{ color: colors.text2, fontFamily: font.sansSemi, fontSize: 12 }}>Copy</Text>
      </Pressable>
    </View>
  );
}
