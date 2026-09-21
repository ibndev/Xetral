import { Share, Text, View } from 'react-native';
import { nationalPhone, paymentLinkFor } from '@xetral/client';
import { Shell } from '@/shell';
import { AcctCard, Eyebrow } from '@/acct-card';
import { Button, FormError, Loading } from '@/ui';
import { useLoad, useXetral } from '@/hooks';
import { radius, space, useStyles, useTheme } from '@/theme';
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
 * AND NOT THE COMP'S REQUEST SCREEN, deliberately. That one asks for an
 * amount and lists pending requests against named people — a product with a
 * table behind it that this platform does not have. A screen that took an
 * amount and produced a link which ignores it would be worse than not
 * offering one: a payment link's amount is chosen by the PAYER (058).
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

  return (
    <Shell back="/wallet" title="Request money">
      <Text style={styles.lead}>Two ways to be paid. Both are yours permanently.</Text>

      {profile.loading && <Loading />}

      {profile.data !== undefined && (
        <>
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
