import { useState } from 'react';
import { Pressable, Share, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { nationalPhone } from '@xetral/client';
import type { DataRequest } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Field, FormError, Loading, Panel } from '@/ui';
import { useLoad, useSubmit, useXetral } from '@/hooks';
import { resetXetral, xetral } from '@/session';
import { forget } from '@/biometrics';
import { font, space, useStyles, useTheme, useThemeChoice } from '@/theme';

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
    await xetral().session.signOut();
    resetXetral();
    router.replace('/signin');
  }

  return (
    <Shell back="/more" title="Account">
      <PaymentLink />
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

/**
 * The customer's own payment link, and the one action worth having for it.
 *
 * SHARE RATHER THAN COPY, on the phone. A clipboard copy is the web's answer
 * because a browser has nowhere to send the link; a handset has a share sheet
 * that puts it straight into the WhatsApp message somebody was about to type,
 * which is where these links actually go.
 *
 * Fetching it here is what MINTS it — `profile()` creates a handle on the
 * first call and returns the same one afterwards.
 */
function PaymentLink() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const profile = useLoad(() => client.profile(), [client]);
  // The phone is on the SESSION, not on the profile: it is what the Send
  // screen resolves a recipient by, so reading it from anywhere else would be
  // a second source for the one string a sender has to type.
  const session = useLoad(() => client.currentSession(), [client]);
  // Their own country, so the number can be shown without the dialling code
  // they never read back to themselves.
  const countries = useLoad(() => client.session.countries(), [client]);
  const here = countries.data?.find((c) => c.code === session.data?.country);
  const [editing, setEditing] = useState(false);
  const [handle, setHandle] = useState('');
  const [pin, setPin] = useState('');
  const { busy, error, code, run } = useSubmit();

  return (
    /*
      TWO WAYS TO BE PAID, AND THEY ARE FOR DIFFERENT PEOPLE.

      A Xetral customer paying another does not need a URL: they type a phone
      number, which is what the Send screen takes. The link is the answer to
      the other question — being paid by somebody NOT on Xetral, out of a
      message thread.

      THE HANDLE IS GONE FROM THIS SCREEN. It is still what the link resolves
      through, and 039 still never reissues one; as a thing to SHOW a customer
      it was a third identifier beside two that already work, and the one
      nobody outside this product would recognise.
    */
    <Panel title="Request payment" subtitle="Accept payment globally with your payment link">
      {profile.loading && <Loading />}

      {profile.data !== undefined && (
        <>
          {/* THE NUMBER FIRST, shown the way its owner would read it aloud —
              dialling code off, digits grouped. What is SHARED is the whole
              E.164 string: a national number has no country in it, so a
              sender abroad pasting one would be addressing nobody. */}
          <View
            style={{
              marginTop: space.sm,
              padding: space.md,
              borderRadius: 14,
              backgroundColor: colors.surface2,
              gap: 4,
            }}
          >
            <Text style={[styles.amount, { fontSize: 20 }]} selectable>
              {nationalPhone(session.data?.phone, here?.dial_code) || '—'}
            </Text>
            <Text style={styles.muted}>Xetral to Xetral user</Text>
          </View>

          <Button
            label="Share my number"
            icon="send"
            quiet
            onPress={() => {
              const number = session.data?.phone;
              if (number === null || number === undefined) return;
              // Silent on failure: a dismissed share sheet rejects on iOS,
              // which is a customer changing their mind rather than an error.
              void Share.share({ message: number }).catch(() => undefined);
            }}
          />

          <Text style={[styles.muted, { marginTop: space.md }]}>
            Or a link, for anyone not on Xetral
          </Text>
          <View
            style={{
              marginTop: space.sm,
              padding: space.md,
              borderRadius: 14,
              backgroundColor: colors.surface2,
              gap: 4,
            }}
          >
            {profile.data.link === null ? (
              <Text style={styles.muted}>
                No link yet — this deployment has no public address set.
              </Text>
            ) : (
              <Text style={[styles.amount, { fontSize: 15 }]} selectable>
                {profile.data.link}
              </Text>
            )}
          </View>

          <Button
            label="Share payment link"
            icon="send"
            disabled={profile.data.link === null}
            onPress={() => {
              const link = profile.data?.link;
              if (link === null || link === undefined) return;
              void Share.share({ message: link }).catch(() => undefined);
            }}
          />

          <Text style={styles.hint}>
            Yours permanently. It is never reissued to anybody else.
          </Text>

          {/*
            THE OLD HANDLE IS NOT FREED, and the copy says so before the
            field rather than after the mistake. 039 refuses a released
            handle to anybody else, so a link already shared goes on pointing
            at a handle only this customer has ever had, instead of quietly
            starting to pay a stranger.
          */}
          {!editing && (
            <Button
              label="Change my handle"
              quiet
              onPress={() => {
                setHandle(profile.data?.handle ?? '');
                setEditing(true);
              }}
            />
          )}

          {editing && (
            <View style={{ gap: space.sm, marginTop: space.sm }}>
              <Field
                label="New handle"
                value={handle}
                onChangeText={setHandle}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                placeholder="olawale"
                hint="3–20 characters: letters, numbers and underscores. Links using your old handle stop working, and nobody else can ever take it — you can change back to it."
              />
              <Field
                label="Transaction PIN"
                value={pin}
                onChangeText={setPin}
                secureTextEntry
                keyboardType="number-pad"
              />
              <Button
                label="Save handle"
                busy={busy}
                onPress={() => {
                  void run(async () => {
                    await client.chooseHandle(handle, pin);
                    setPin('');
                    setEditing(false);
                    profile.reload();
                    return undefined;
                  });
                }}
              />
              <Button
                label="Cancel"
                quiet
                onPress={() => {
                  setEditing(false);
                  setPin('');
                }}
              />
              <FormError error={error} code={code} />
            </View>
          )}
        </>
      )}

      <FormError error={profile.error} code={profile.code} />
    </Panel>
  );
}
