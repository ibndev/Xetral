import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { XetralCountry } from '@xetral/client';
import { Link, router } from 'expo-router';
import { deviceDescriptor } from '@/device';
import { resetXetral, xetral } from '@/session';
import { messageFor } from '@/errors';
import { radius, space, useStyles, useTheme } from '@/theme';
import { Select } from '@/select';
import { CountryMark } from '@/currency-mark';

/**
 * Opening an account, on the phone.
 *
 * REGISTRATION ENDS SIGNED IN, which is why this is the same shape as
 * `signin.tsx` rather than a form that sends somebody to one. The API returns
 * a token pair from `/v1/auth/register`, exactly as it does from login, and
 * `Session.register()` writes both halves to the Keychain. Bouncing a customer
 * to a sign-in form to retype the password they chose thirty seconds ago is
 * the wrong product, and it would also mean the refresh token made a round
 * trip for no reason.
 *
 * NO IDENTITY DOCUMENTS HERE, deliberately. KYC is a separate, reviewed step
 * that a person approves; folding it into registration would make a regulatory
 * decision a side effect of choosing a password, and would put a BVN into the
 * one flow that has to work before anybody trusts the app at all.
 *
 * AND NO MARKETING CHECKBOX, also deliberately. `033_consent.sql` has a CHECK
 * that refuses a marketing consent whose source is `registration` — one "I
 * agree" covering the terms and a mailing list is not consent to the mailing
 * list, whatever the button said. So this form could not usefully grow one.
 */
export default function SignUp() {
  const styles = useStyles();
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  // Nigeria before the list arrives, so the flag and +234 are on screen from
  // the first paint rather than a moment later. Corrected below only if this
  // deployment is not open there.
  const [country, setCountry] = useState('NG');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  /*
   * THE COUNTRY LIST COMES FROM THE SERVER, the same as the web's.
   *
   * A constant in this file would make "an operator opens a country without a
   * deploy" true of the database and false of the phone — and the phone is
   * the harder half to fix, because its address is compiled in and a wrong
   * list is a rebuild, a release and a reinstall.
   */
  const [countries, setCountries] = useState<readonly XetralCountry[]>([]);
  useEffect(() => {
    let live = true;
    void xetral()
      .session.countries()
      .then((list) => {
        if (!live) return;
        setCountries(list);
        setCountry((current) =>
          list.some((c) => c.code === current) ? current : (list[0]?.code ?? ''),
        );
      })
      // A list that will not load leaves the picker empty rather than the
      // screen blank; the refusal arrives on submit.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      // Cleared first, for the reason sign-in does it: a stale session in
      // memory would have this registration's tokens written over the top of
      // somebody else's, and the singleton would keep serving the old one.
      resetXetral();
      await xetral().session.register({
        // Trimmed, because a keyboard's autocorrect adds a trailing space to
        // an address often enough to matter and the server would take it as
        // part of the address.
        email: email.trim(),
        password,
        fullName: `${firstName.trim()} ${lastName.trim()}`.trim(),
        country,
        phone,
        device: await deviceDescriptor(),
      });
      // `replace`, not `push`: there is no back to a signup form once the
      // account exists.
      router.replace('/wallet');
    } catch (cause) {
      // The API's own code, translated. A weak password and an address already
      // registered are different things and the customer has to be told which
      // — `messageFor` is where that mapping lives, shared with every other
      // screen so no two disagree.
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    /*
     * THE CONTENT WAS UNDER THE STATUS BAR.
     *
     * This screen rendered straight into `styles.screen`, which is `flex: 1`
     * and nothing else — so the card began at y=0, behind the clock and the
     * notch, and the heading was clipped. Every signed-in screen gets its
     * inset from `Shell`; the two auth screens are outside it and have to ask
     * for their own, which `signin.tsx` already did and this did not.
     *
     * It also needs to SCROLL now. Six fields and a button do not fit on a
     * short handset, and without a scroll view the button is simply
     * unreachable rather than below the fold.
     */
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: space.lg,
          paddingTop: insets.top + space.xl,
          paddingBottom: insets.bottom + space.xxl,
        }}
      >
      <View style={styles.card}>
        <Text style={styles.h1}>Create your account</Text>
        <Text style={styles.h2}>A Xetral wallet takes a minute</Text>

        <View style={{ flexDirection: 'row', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>First name</Text>
            <TextInput
              style={styles.input}
              value={firstName}
              onChangeText={setFirstName}
              placeholder="John"
              placeholderTextColor={colors.text3}
              autoCapitalize="words"
              textContentType="givenName"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Last name</Text>
            <TextInput
              style={styles.input}
              value={lastName}
              onChangeText={setLastName}
              placeholder="Doe"
              placeholderTextColor={colors.text3}
              autoCapitalize="words"
              textContentType="familyName"
            />
          </View>
        </View>

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          // Tells a password manager this is the account being created, so it
          // offers to save the pair rather than autofilling an existing one.
          textContentType="username"
        />

        {/*
          ONE COUNTRY CONTROL, AND IT IS THE ONE IN FRONT OF THE PHONE NUMBER.

          There used to be two: a full-width Country picker, and a flag-plus-code
          block that only DISPLAYED what it had chosen. So the control sitting
          exactly where a customer reaches to change their dialling code could
          not be changed at all. This one opens the same sheet — which still
          says "Nigeria", because a bare code is not something you can find a
          country by, while the trigger says "+234", because a country's name
          in front of a phone number pushes the digits off the screen.
        */}
        <Text style={styles.label}>Phone number</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View
            style={{
              justifyContent: 'center',
              minHeight: 50,
              paddingHorizontal: 4,
              borderRadius: radius.md,
              backgroundColor: colors.field,
            }}
          >
            <Select
              label="Country"
              variant="pill"
              value={country}
              onChange={setCountry}
              placeholder="+—"
              renderMark={(code) => <CountryMark country={code} size={18} />}
              renderTrigger={(code) => (
                <Text style={[styles.amount, { color: colors.text }]}>
                  +{countries.find((c) => c.code === code)?.dial_code ?? ''}
                </Text>
              )}
              options={countries.map((c) => ({
                value: c.code,
                label: c.name,
                // What their money will be in — the consequence of this
                // choice, and the only one visible from the form.
                hint: c.currency,
              }))}
            />
          </View>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={phone}
            // National digits only. A number pasted from a contact card
            // carries spaces and a plus; stripping is kinder than refusing.
            onChangeText={(text) => setPhone(text.replace(/[^0-9]/g, ''))}
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            placeholder="8031234567"
            placeholderTextColor={colors.text3}
          />
        </View>

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          // `newPassword` rather than `password`: iOS offers a strong one and
          // will not suggest an existing credential for this field.
          textContentType="newPassword"
        />
        <Text style={styles.muted}>
          The server decides what is strong enough and will say if it is not.
        </Text>

        <Pressable
          style={styles.button}
          onPress={submit}
          // Guarded on the fields as well as on `busy`: a double tap on an
          // empty form is a wasted round trip and a confusing error.
          disabled={
            busy ||
            firstName.trim() === '' ||
            lastName.trim() === '' ||
            email.trim() === '' ||
            country === '' ||
            phone === '' ||
            password === ''
          }
        >
          <Text style={styles.buttonText}>
            {busy ? 'Creating your account…' : 'Create account'}
          </Text>
        </Pressable>

        {error !== undefined && <Text style={styles.error}>{error}</Text>}

        <Link href="/signin" style={styles.link}>
          Already have an account? Sign in
        </Link>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
