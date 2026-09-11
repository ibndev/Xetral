import { useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { DataRequest } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Field, FormError, Loading, Panel } from '@/ui';
import { Select } from '@/select';
import { useLoad, useSubmit, useXetral } from '@/hooks';
import { resetXetral, xetral } from '@/session';
import { forget } from '@/biometrics';
import { unregisterFromPush } from '@/push';
import { font, space, useStyles, useTheme, useThemeChoice } from '@/theme';
import { xetral as xetralSession } from '@/session';

/**
 * The account screen — the phone's copy of the web's `/settings`.
 *
 * It carries the transaction PIN, the theme, consent and the two data rights,
 * because a customer who can exercise a right on a laptop and not on a phone
 * has been given half a right.
 */
export default function Settings() {
  const styles = useStyles();
  const { choice, set } = useThemeChoice();

  async function signOut() {
    /*
     * FORGETTING THE PIN IS PART OF SIGNING OUT, and it was a comment rather
     * than a line of code.
     *
     * This function's own comment said it forgot the PIN behind the biometric
     * gate. It did not: `session.signOut()` clears the tokens and
     * `resetXetral()` resets the singleton, and neither touches SecureStore.
     * So a face on this phone still unlocked the transaction PIN of an account
     * nobody was signed in to — exactly the case a customer handing over their
     * device is guarding against, and exactly what the comment claimed was
     * covered.
     *
     * FIRST, and not awaited alongside the network call: if the request to
     * revoke the session fails, the customer must still end up signed out on
     * this device, and the secret must still be gone.
     */
    await forget();
    // AND THE HANDSET STOPS BEING AN ADDRESS FOR THIS ACCOUNT, for the reason
    // the stored PIN is forgotten: a phone somebody hands over must not go on
    // showing the previous account's notifications on its lock screen. Before
    // the tokens go, because retiring it is an authenticated request.
    await unregisterFromPush();
    await xetral().session.signOut();
    resetXetral();
    router.replace('/signin');
  }

  return (
    <Shell back="/more" title="Account">
      <YourDetails />
      <SetPin />

      <Panel title="Appearance">
        <View style={{ flexDirection: 'row', gap: 6, marginTop: space.sm }}>
          {(['light', 'dark', 'system'] as const).map((option) => (
            <Choice
              key={option}
              label={option === 'system' ? 'System' : option === 'dark' ? 'Dark' : 'Light'}
              on={choice === option}
              onPress={() => set(option)}
            />
          ))}
        </View>
        <Text style={styles.hint}>
          Follow the phone’s own setting.
        </Text>
      </Panel>

      <Consents />
      <YourData />

      <Panel>
        <Button label="Sign out" quiet icon="logout" onPress={() => void signOut()} />
      </Panel>
    </Shell>
  );
}

function Choice({
  label,
  on,
  onPress,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly onPress: () => void;
}) {
  const colors = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      style={{
        flex: 1,
        alignItems: 'center',
        paddingVertical: 11,
        borderRadius: 999,
        backgroundColor: on ? colors.brand : colors.surface2,
      }}
    >
      <Text style={{ fontFamily: font.sansSemi, fontSize: 13.5, color: on ? colors.onBrand : colors.text2 }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Setting a transaction PIN, or changing one.
 *
 * Changing one requires the current value: without that, a stolen session
 * could replace the very factor meant to stop it. Setting the first one
 * cannot, because requiring the PIN to set the PIN is circular.
 */
/**
 * The customer's own details, and the one field they may change.
 *
 * THE WEB'S `YourDetails`, on the phone. Four of the five are read-only and
 * each says what changes it in words rather than as a disabled input — a box
 * somebody taps that does nothing has given them no way forward.
 *
 * The name is editable because it is a GREETING: 040 keeps `users.full_name`
 * and `kyc_submissions.full_name` apart so this one can be personal on day
 * one, and 058 calls it "a greeting on a checkout page". Nothing that moves
 * money reads it, which is why there is no PIN on saving it.
 */
function YourDetails() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const details = useLoad(() => client.accountDetails(), [client]);
  // The open list, the same call the signup form makes — and it needs no
  // token, so it cannot trip a refresh against an empty store.
  const countries = useLoad(() => xetralSession().session.countries(), []);
  const { busy, error, code, done, run } = useSubmit();

  const [name, setName] = useState<string | undefined>(undefined);
  const [phone, setPhone] = useState<string | undefined>(undefined);
  const [country, setCountry] = useState<string | undefined>(undefined);

  const held = details.data;
  /*
   * VERIFIED MEANS READ-ONLY, read from the SERVER rather than worked out
   * here. What a reviewer read off a document is the record, and a screen that
   * derived the rule for itself would be a second copy of it — on the side an
   * attacker can edit.
   */
  const locked = held?.kyc_verified === true;
  const may = (field: 'full_name' | 'phone' | 'country') =>
    held !== undefined && held.editable.includes(field);

  const nameValue = name ?? held?.full_name ?? '';
  const countryValue = country ?? held?.country ?? '';
  const dial = (countries.data ?? []).find((c) => c.code === countryValue)?.dial_code;
  const phoneMissing = held !== undefined && held.phone === null;
  const nothingToSave =
    name === undefined && phone === undefined && country === undefined;

  return (
    <Panel
      title="Your details"
      subtitle={
        locked
          ? 'Verified — these can no longer be changed here'
          : phoneMissing
            ? 'Add your phone number so people can pay you'
            : 'What we hold about your account'
      }
    >
      {/*
        THE MISSING NUMBER IS SAID IN ITS OWN WORDS. Without one nobody can pay
        this customer at all — the Request payment panel says only "Not set",
        which reads as something that has not loaded rather than as the reason
        their money is not arriving.
      */}
      {phoneMissing && !locked && (
        <Text style={styles.error}>
          Your phone number is missing. It is how other Xetral users pay you, so
          without it money cannot reach your account.
        </Text>
      )}

      {may('full_name') ? (
        <Field
          label="Name"
          value={nameValue}
          onChangeText={setName}
          placeholder="Your full name"
          autoComplete="name"
          hint="How we greet you, and what somebody paying your link sees. Not your verified name."
        />
      ) : (
        <View style={styles.row}>
          <Text style={[styles.muted, { flex: 1 }]}>Name</Text>
          <Text style={styles.muted}>{held?.full_name ?? '—'}</Text>
        </View>
      )}

      {/*
        ONE COUNTRY CONTROL, AND IT IS THE ONE IN FRONT OF THE PHONE NUMBER —
        the construction the signup form already uses. A second full-width
        picker beside it lets somebody select Ghana and +234, and the number is
        then unreachable while looking perfectly ordinary.
      */}
      {may('phone') || may('country') ? (
        <>
          <Text style={styles.label}>Phone number</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Select
              label="Country"
              variant="dial"
              value={countryValue}
              onChange={setCountry}
              placeholder="+—"
              renderTrigger={(code) => (
                <Text style={[styles.amount, { color: colors.text }]}>
                  +{(countries.data ?? []).find((c) => c.code === code)?.dial_code ?? ''}
                </Text>
              )}
              options={(countries.data ?? []).map((c) => ({
                value: c.code,
                label: c.name,
                hint: c.currency,
              }))}
            />
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={phone ?? ''}
              // National digits only. A number pasted from a contact card
              // carries spaces and a plus; stripping is kinder than refusing.
              onChangeText={(text) => setPhone(text.replace(/[^0-9]/g, ''))}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              placeholder={held?.phone ?? '8031234567'}
              placeholderTextColor={colors.text3}
              editable={countryValue !== ''}
            />
          </View>
          <Text style={styles.hint}>
            {held?.phone === null
              ? 'Without this, other Xetral users cannot pay you.'
              : `Currently ${held?.phone ?? '—'}. Leave blank to keep it.`}
          </Text>
        </>
      ) : (
        <>
          <View style={styles.row}>
            <Text style={[styles.muted, { flex: 1 }]}>Country</Text>
            <Text style={styles.muted}>{held?.country_name ?? held?.country ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={[styles.muted, { flex: 1 }]}>Phone</Text>
            <Text style={styles.muted}>{held?.phone ?? '—'}</Text>
          </View>
        </>
      )}

      {/* The email has no endpoint at all, verified or not: it is what refuses
          a duplicate account, so moving one between accounts is a takeover. */}
      <View style={styles.row}>
        <Text style={[styles.muted, { flex: 1 }]}>Email</Text>
        <Text style={styles.muted}>{held?.email ?? '—'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={[styles.muted, { flex: 1 }]}>Member since</Text>
        <Text style={styles.muted}>
          {held === undefined ? '—' : new Date(held.created_at).toLocaleDateString()}
        </Text>
      </View>

      {!locked && (
        <Button
          label="Save"
          busy={busy}
          disabled={nothingToSave}
          onPress={() =>
            void run(async () => {
              const saved = await client.updateProfile({
                ...(name === undefined ? {} : { full_name: name.trim() }),
                ...(phone === undefined ? {} : { phone: phone.replace(/[^0-9]/g, '') }),
                ...(country === undefined ? {} : { country }),
              });
              // Off the RESPONSE, not the form: the server trims the name and
              // builds E.164 from the country's own dialling code.
              setName(saved.full_name ?? '');
              setPhone(undefined);
              setCountry(undefined);
              details.reload();
              return 'Saved.';
            })
          }
        />
      )}
      <FormError error={error} code={code} />
      <Done message={done} />

      <Text style={styles.hint}>
        {locked
          ? 'Contact support if any of this is wrong — changing verified details is a re-verification.'
          : 'Your email address identifies your account and cannot be changed here. Once your identity is verified these details are fixed.'}
      </Text>
    </Panel>
  );
}

function SetPin() {
  const client = useXetral();
  const styles = useStyles();
  const { busy, error, code, done, run } = useSubmit();
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');

  return (
    <Panel
      title="Transaction PIN"
      subtitle="Required for every action that moves money"
    >
      <Text style={styles.lead}>Separate from your password, on purpose.</Text>
      <Field
        label="Current PIN"
        secureTextEntry
        inputMode="numeric"
        autoComplete="off"
        value={current}
        onChangeText={setCurrent}
        hint="Leave empty if you have not set one before."
      />
      <Field
        label="New PIN"
        secureTextEntry
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onChangeText={setPin}
      />
      <Field
        label="Confirm new PIN"
        secureTextEntry
        inputMode="numeric"
        autoComplete="off"
        value={confirm}
        onChangeText={setConfirm}
      />
      <Button
        label="Save PIN"
        busy={busy}
        disabled={pin === '' || pin !== confirm}
        onPress={() =>
          void run(async () => {
            await client.setPin(pin, current === '' ? undefined : current);
            /*
             * THE STORED PIN IS NOW WRONG, and this is the bug that presents
             * as "it says my PIN is incorrect when I entered the correct one".
             *
             * Biometric unlock keeps the REAL PIN in the Keychain and sends it
             * as if typed. Change the PIN and that copy is stale — so every
             * biometric-authorised action afterwards sends the OLD PIN and the
             * server correctly refuses it, while the customer used Face ID and
             * has no way to know what is being sent on their behalf.
             *
             * Forgetting it is the right answer rather than re-storing the new
             * one: enrolment exists to confirm the PIN against the server
             * before it is kept, and quietly re-enrolling here would skip that
             * check. The customer re-enrols from the security screen, which is
             * one deliberate step and cannot store a PIN the server has not
             * agreed to.
             */
            await forget();
            // Cleared immediately. A PIN sitting in component state outlives
            // the request that needed it, and there is nothing further to do
            // with it here.
            setCurrent('');
            setPin('');
            setConfirm('');
            return 'Your transaction PIN is set.';
          })
        }
      />
      {pin !== '' && pin !== confirm && (
        <Text style={styles.error}>Those two do not match.</Text>
      )}
      <FormError error={error} code={code} />
      <Done message={done} />
    </Panel>
  );
}

/**
 * What this customer has agreed to, and the one thing they can withdraw.
 *
 * ONLY MARKETING CAN BE WITHDRAWN, and the asymmetry is a statement rather
 * than an omission: withdrawing the terms is closing the account, which moves
 * money and has its own path. Recording it here would leave a customer holding
 * a balance under terms they are recorded as refusing.
 */
function Consents() {
  const client = useXetral();
  const styles = useStyles();
  const state = useLoad(() => client.consents(), [client]);
  const { error, code, run } = useSubmit();

  const marketing = state.data?.consents.find((c) => c.kind === 'marketing_email');

  return (
    <Panel title="Email">
      {state.loading && <Loading />}
      <View style={styles.rowBetween}>
        <View style={{ flex: 1, paddingRight: space.md }}>
          <Text style={[styles.h2, { fontSize: 15 }]}>Product news</Text>
          <Text style={styles.hint}>
            Takes effect immediately. Security alerts and receipts are not marketing
            and keep coming.
          </Text>
        </View>
        <Switch
          value={marketing?.granted === true}
          onValueChange={(next) =>
            void run(async () => {
              await client.setConsent('marketing_email', next);
              state.reload();
              return undefined;
            })
          }
        />
      </View>

      {state.data?.documents.map((doc) => (
        <View key={doc.kind} style={styles.row}>
          <Text style={[styles.muted, { flex: 1 }]}>{doc.summary}</Text>
          <Text style={styles.muted}>{doc.agreed ? 'agreed' : 'not agreed'}</Text>
        </View>
      ))}

      <FormError error={error ?? state.error} code={code ?? state.code} />
    </Panel>
  );
}

/**
 * Take your data, or ask for it to be erased.
 *
 * THE EXPORT TAKES THE PIN and asking does not. The export is every balance,
 * every transaction and every place they have signed in from in one file — the
 * read a stolen session most wants. Asking destroys nothing, and the customer
 * most likely to ask is one who has just found somebody else in their account.
 */
function YourData() {
  const client = useXetral();
  const styles = useStyles();
  const requests = useLoad(() => client.myDataRequests(), [client]);
  const { busy, error, code, done, run } = useSubmit();
  const [pin, setPin] = useState('');

  return (
    <Panel title="Your data">
      <Field
        label="Transaction PIN"
        secureTextEntry
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onChangeText={setPin}
        hint="One file with every balance, transaction and sign-in. The PIN is asked for because a stolen session would not have it."
      />
      <Button
        label="Export my data"
        quiet
        icon="download"
        busy={busy}
        disabled={pin === ''}
        onPress={() =>
          void run(async () => {
            const data = await client.exportMyData(pin);
            setPin('');
            const rows = Object.keys(data).length;
            return `Prepared. ${rows} sections — open it on the web to download the file.`;
          })
        }
      />
      <Button
        label="Ask for erasure"
        quiet
        onPress={() =>
          void run(async () => {
            await client.requestMyData('erasure');
            requests.reload();
            return 'Asked. A person decides, within the statutory deadline.';
          })
        }
      />

      {requests.data?.map((request: DataRequest) => (
        <View key={request.uuid} style={styles.row}>
          <Text style={[styles.muted, { flex: 1 }]}>{request.kind}</Text>
          <Text style={styles.muted}>{request.status}</Text>
        </View>
      ))}

      <FormError error={error} code={code} />
      <Done message={done} />
    </Panel>
  );
}

