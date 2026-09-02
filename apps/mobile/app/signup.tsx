import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { XetralCountry } from '@xetral/client';
import { Link, router } from 'expo-router';
import { deviceDescriptor } from '@/device';
import { resetXetral, xetral } from '@/session';
import { messageFor } from '@/errors';
import { radius, useStyles, useTheme } from '@/theme';
import { Select } from '@/select';

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
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('');
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
        if (list.length === 1) setCountry(list[0]?.code ?? '');
      })
      // A list that will not load leaves the picker empty rather than the
      // screen blank; the refusal arrives on submit.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const dial = countries.find((c) => c.code === country)?.dial_code;

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
        fullName: fullName.trim(),
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
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.h1}>Create your account</Text>
        <Text style={styles.h2}>A Xetral wallet takes a minute</Text>

        <Text style={styles.label}>Full name</Text>
        <TextInput
          style={styles.input}
          value={fullName}
          onChangeText={setFullName}
          autoCapitalize="words"
          textContentType="name"
        />

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

        <Text style={styles.label}>Country</Text>
        <Select
          label="Country"
          value={country}
          onChange={setCountry}
          placeholder={countries.length === 0 ? 'Loading…' : 'Where do you live?'}
          options={countries.map((c) => ({
            value: c.code,
            label: c.name,
            // What their money will be in — the consequence of this field,
            // and the only one visible from the form.
            hint: c.currency,
          }))}
        />

        {/*
          THE DIALLING CODE IS READ FROM THE COUNTRY, never picked separately.
          One place a country is stated means the two cannot disagree — a
          second picker would let somebody choose Ghana and +234.
        */}
        <Text style={styles.label}>Phone number</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View
            style={{
              paddingHorizontal: 14,
              minHeight: 50,
              justifyContent: 'center',
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: colors.lineStrong,
              backgroundColor: colors.surface2,
            }}
          >
            <Text style={[styles.amount, { color: colors.text2 }]}>
              {dial === undefined ? '+—' : `+${dial}`}
            </Text>
          </View>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={phone}
            // National digits only. A number pasted from a contact card
            // carries spaces and a plus; stripping is kinder than refusing.
            onChangeText={(text) => setPhone(text.replace(/[^0-9]/g, ''))}
            keyboardType="phone-pad"
            editable={country !== ''}
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
            fullName.trim().length < 2 ||
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
    </View>
  );
}
