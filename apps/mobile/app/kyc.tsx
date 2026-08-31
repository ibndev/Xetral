import { useState } from 'react';
import { Text, View } from 'react-native';
import type { KycLimits, KycStatus } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Field, FormError, Loading, Panel } from '@/ui';
import { useLoad, useSubmit, useXetral } from '@/hooks';
import { space, useStyles, useTheme } from '@/theme';

/**
 * Identity verification, on the phone.
 *
 * The screen that unblocks everything else: no bank account number and no card
 * exists for a customer until this is approved, because `provider_customers`
 * is created by the approval and both refuse without it.
 *
 * The BVN is typed here and never comes back. The server seals it and returns
 * four digits — enough for support to confirm they are talking about the right
 * one, and not enough to be worth stealing from a screenshot.
 */
export default function Kyc() {
  const client = useXetral();
  const styles = useStyles();
  const status = useLoad<KycStatus | null>(() => client.kyc(), [client]);
  const { busy, error, code, done, run } = useSubmit();

  const [form, setForm] = useState({
    fullName: '',
    dateOfBirth: '',
    phone: '',
    bvn: '',
    address: '',
  });
  const set = (field: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  if (status.loading) {
    return (
      <Shell back="/more" title="Identity">
        <Loading />
      </Shell>
    );
  }

  if (status.data !== null && status.data !== undefined) {
    return (
      <Shell back="/more" title="Identity">
        <Submitted status={status.data} />
        <Limits />
      </Shell>
    );
  }

  return (
    <Shell back="/more" title="Identity">
      {/* What they can move TODAY, before the form rather than after it. A
          customer arrives here because something refused them; the useful
          first sentence is what their current ceiling is. */}
      <Limits />

      <Panel
        title="Verify your identity"
        subtitle="Required before you can be issued an account number or a card"
      >
        <Field
          label="Full name, as it appears on your BVN"
          value={form.fullName}
          onChangeText={set('fullName')}
        />
        <Field
          label="Date of birth"
          placeholder="YYYY-MM-DD"
          inputMode="numeric"
          value={form.dateOfBirth}
          onChangeText={set('dateOfBirth')}
        />
        <Field
          label="Phone number"
          inputMode="tel"
          placeholder="+2348012345678"
          value={form.phone}
          onChangeText={set('phone')}
        />
        <Field
          label="BVN"
          inputMode="numeric"
          maxLength={11}
          // Never offered back by the browser or keyboard on another form. A
          // BVN in an autofill suggestion is a BVN on the next person's screen.
          autoComplete="off"
          value={form.bvn}
          onChangeText={set('bvn')}
          hint="Eleven digits. We store this encrypted and never show it again."
        />
        <Field
          label="Residential address"
          multiline
          numberOfLines={3}
          value={form.address}
          onChangeText={set('address')}
          style={{ minHeight: 90, paddingTop: 12 }}
        />

        <Button
          label="Submit for review"
          busy={busy}
          disabled={form.fullName.length < 3 || form.bvn.length !== 11}
          onPress={() =>
            void run(async () => {
              await client.submitKyc(form);
              // Clear the BVN from this screen's state the moment it is sent.
              // It sits in a React tree until something removes it, and it has
              // no further use here.
              setForm((f) => ({ ...f, bvn: '' }));
              status.reload();
              return 'Submitted. We will review this and let you know.';
            })
          }
        />
        <FormError error={error} code={code} />
        <Done message={done} />
      </Panel>
    </Shell>
  );
}

function Submitted({ status }: { readonly status: KycStatus }) {
  const styles = useStyles();
  const colors = useTheme();
  const state =
    status.status === 'approved'
      ? { tint: colors.ok, title: 'You are verified' }
      : status.status === 'rejected'
        ? { tint: colors.danger, title: 'We could not verify this' }
        : { tint: colors.warn, title: 'Under review' };

  return (
    <Panel title={state.title}>
      <View style={[styles.rowBetween, { marginTop: space.sm }]}>
        <Text style={styles.muted}>Status</Text>
        <Text style={{ color: state.tint, fontWeight: '700' }}>{status.status}</Text>
      </View>
      <View style={styles.row}>
        <Text style={[styles.muted, { flex: 1 }]}>Name</Text>
        <Text style={{ color: colors.text }}>{status.full_name}</Text>
      </View>
      <View style={styles.row}>
        <Text style={[styles.muted, { flex: 1 }]}>BVN</Text>
        <Text style={styles.amount}>•••••••{status.bvn_last4}</Text>
      </View>
      {status.status === 'pending' && (
        <Text style={styles.hint}>
          Reviews are done by a person, not automatically. You can keep using your
          wallet meanwhile.
        </Text>
      )}
      {status.rejection_reason !== null && (
        <Text style={[styles.error, { marginTop: space.md }]}>{status.rejection_reason}</Text>
      )}
    </Panel>
  );
}

/**
 * What this customer's verification currently allows.
 *
 * A ZERO IS A REAL LIMIT and is shown as one. An unverified account may move
 * no crypto at all, because a chain transaction is the single movement nobody
 * can recall — and saying "not available yet" is more honest than hiding the
 * row and letting somebody find out at the moment they try.
 */
function Limits() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { data } = useLoad<KycLimits>(() => client.kycLimits(), [client]);
  if (data === undefined) return null;

  const TIERS = ['Registered', 'Verified', 'Enhanced'];

  return (
    <Panel title="Your daily limits" subtitle={TIERS[data.tier] ?? `Tier ${data.tier}`}>
      {data.limits.map((limit) => (
        <View key={limit.currency} style={styles.row}>
          <Text style={[styles.muted, { flex: 1 }]}>{limit.currency}</Text>
          <Text style={styles.amount}>
            {/* A regex, not `=== '0'`: the API sends major units, so a zero
                ceiling arrives as "0.00" for naira and "0.00000000" for BTC. */}
            {/^0(\.0+)?$/.test(limit.daily_limit)
              ? 'not available yet'
              : limit.daily_limit}
          </Text>
        </View>
      ))}
      <Text style={[styles.hint, { color: colors.text3 }]}>
        Verifying your identity raises every one of these.
      </Text>
    </Panel>
  );
}
