import { useState } from 'react';
import { Share, Text, TextInput, View } from 'react-native';
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
import { Shell } from '@/shell';
import { AcctCard, Eyebrow } from '@/acct-card';
import { Button, FormError, Loading, Segmented } from '@/ui';
import { useLoad, useXetral } from '@/hooks';
import { cardShadow, font, radius, space, useStyles, useTheme } from '@/theme';
import { webOrigin } from '@/session';

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

          <Eyebrow>From anybody else</Eyebrow>

          {/* BOTH VALUES ARE ON SCREEN, ABOVE THEIR BUTTONS. A Copy button
              beside an em dash is a button that copies nothing and says
              nothing about why; what is shown is what is shared, so a customer
              can read it back over a phone call. */}
          <Text style={styles.muted}>
            A checkout page anybody can pay on, in any currency you hold.
          </Text>
          <View
            style={{
              marginTop: space.xs,
              paddingVertical: space.sm,
              paddingHorizontal: space.md,
              borderRadius: radius.md,
              backgroundColor: colors.surface2,
            }}
          >
            <Text style={[styles.amount, { fontSize: 14 }]} selectable>
              {link ?? 'Not set'}
            </Text>
          </View>
          <Button
            label="Copy payment link"
            icon="copy"
            quiet
            disabled={link === null}
            onPress={() => {
              if (link === null) return;
              // Silent on failure: a dismissed share sheet rejects on iOS,
              // which is somebody changing their mind rather than an error.
              void Share.share({ message: link }).catch(() => undefined);
            }}
          />
        </>
      )}

      <FormError error={profile.error} code={profile.code} />
    </Shell>
  );
}
