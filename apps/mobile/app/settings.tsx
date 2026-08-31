import { useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { ConsentKind, DataRequest } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Field, FormError, Loading, Panel } from '@/ui';
import { useLoad, useSubmit, useXetral } from '@/hooks';
import { resetXetral, xetral } from '@/session';
import { space, useStyles, useTheme, useThemeChoice } from '@/theme';

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
    // Cleared LOCALLY FIRST. If the network call fails the customer must still
    // end up signed out on this device — the opposite order leaves them
    // holding live tokens because a request timed out. It also forgets the
    // PIN behind the biometric gate: a face on this phone must not unlock the
    // PIN of an account nobody is signed in to.
    await xetral().session.signOut();
    resetXetral();
    router.replace('/signin');
  }

  return (
    <Shell back="/more" title="Account">
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
          The header toggle switches between light and dark. This is where you hand
          the choice back to the phone.
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
      <Text style={{ fontWeight: '600', fontSize: 13.5, color: on ? colors.onBrand : colors.text2 }}>
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
          <Text style={{ color: styles.h2.color, fontWeight: '600' }}>Product news</Text>
          <Text style={styles.hint}>
            Takes effect immediately. Security alerts and receipts are not marketing
            and keep coming.
          </Text>
        </View>
        <Switch
          value={marketing?.granted === true}
          onValueChange={(next) =>
            void run(async () => {
              await client.setConsent('marketing_email' as ConsentKind, next);
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
