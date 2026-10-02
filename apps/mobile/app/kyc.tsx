import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { ACCOUNT_TIERS, formatAmount, tierLabel, wholeFigure } from '@xetral/client';
import type { KycLimits, KycStatus } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Field, FormError, Loading, Panel } from '@/ui';
import { useLoad, useSubmit, useXetral } from '@/hooks';
import { Icon } from '@/icon';
import { font, space, useStyles, useTheme } from '@/theme';

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
  const status = useLoad<KycStatus | null>(() => client.kyc(), [client]);
  const { busy, error, code, done, run } = useSubmit();

  /*
   * WHAT SIGNUP ALREADY TOOK IS NOT ASKED AGAIN — the web's reasoning, and the
   * same session fields. Five empty boxes on the screen that unblocks the card
   * somebody came for is a form people abandon; two of them were already on
   * file. They arrive filled in and STILL EDITABLE, because the name on a BVN
   * is not always the name somebody typed about themselves.
   */
  const session = useLoad(() => client.currentSession(), [client]);

  const [form, setForm] = useState({
    fullName: '',
    dateOfBirth: '',
    phone: '',
    bvn: '',
    address: '',
  });
  const set = (field: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  useEffect(() => {
    const known = session.data;
    if (known === undefined) return;
    // Only ever fills a box nobody has touched. Overwriting typed input
    // because a request finished late is the worse bug.
    setForm((f) => ({
      ...f,
      fullName: f.fullName === '' ? (known.full_name ?? '') : f.fullName,
      phone: f.phone === '' ? (known.phone ?? '') : f.phone,
    }));
  }, [session.data]);

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
        <Text style={{ color: state.tint, fontFamily: font.sansBold }}>{status.status}</Text>
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
        <Text style={styles.hint}>We&apos;ll notify you when review is completed</Text>
      )}
      {status.rejection_reason !== null && (
        <Text style={[styles.error, { marginTop: space.md }]}>{status.rejection_reason}</Text>
      )}
    </Panel>
  );
}

/**
 * THE ACCOUNT'S TIER, AS A LADDER — the web screen's, rung for rung.
 *
 * Tier 1 on signing up, Tier 2 once a BVN is verified, Tier 3 once an address
 * is: the owner's three words, from `ACCOUNT_TIERS` in `@xetral/client` so the
 * two apps cannot count them differently. It replaced a row per currency
 * reading "Limited" or "Raised", which said whether verifying would help and
 * nothing about what the next step was worth. One figure per rung, in the
 * customer's own currency — the API answers every currency at every tier, and
 * drawn whole that is a price list on a screen about identity.
 */
function Limits() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { data } = useLoad<KycLimits>(() => client.kycLimits(), [client]);
  const session = useLoad(() => client.currentSession(), [client]);
  if (data === undefined) return null;

  const home = session.data?.home_currency ?? null;
  const ladder = data.ladder ?? [{ tier: data.tier, limits: data.limits }];
  const currency =
    home !== null && ladder.some((r) => r.limits.some((l) => l.currency === home)) ? home : 'NGN';

  return (
    <Panel title="Your account tier" subtitle={tierLabel(data.tier)}>
      {ACCOUNT_TIERS.map((rung, index) => {
        const state = rung.tier < data.tier ? 'done' : rung.tier === data.tier ? 'current' : 'locked';
        const limit = ladder.find((r) => r.tier === rung.tier)?.limits.find((l) => l.currency === currency);
        const dim = state === 'locked' ? colors.text2 : colors.text;
        return (
          <View
            key={rung.tier}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingVertical: 12,
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: colors.line,
            }}
          >
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor:
                  state === 'done' ? colors.okBg : state === 'current' ? colors.iris : colors.surface2,
              }}
            >
              {state === 'done' ? (
                <Icon name="check" size={14} color={colors.ok} />
              ) : (
                <Text
                  style={{
                    fontFamily: font.numSemi,
                    fontSize: 13,
                    color: state === 'current' ? colors.onIris : colors.text3,
                  }}
                >
                  {rung.tier + 1}
                </Text>
              )}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text style={{ fontFamily: font.sansSemi, fontSize: 15, color: dim }}>{rung.label}</Text>
                {state === 'current' && (
                  <Text
                    style={{
                      fontFamily: font.sansSemi,
                      fontSize: 11,
                      color: colors.irisText,
                      backgroundColor: colors.irisTint,
                      paddingHorizontal: 8,
                      paddingVertical: 2,
                      borderRadius: 999,
                      overflow: 'hidden',
                    }}
                  >
                    You are here
                  </Text>
                )}
              </View>
              <Text style={{ fontFamily: font.sans, fontSize: 13, color: colors.text3 }}>
                {rung.requirement}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ fontFamily: font.numSemi, fontSize: 15, color: dim, fontVariant: ['tabular-nums'] }}>
                {limit === undefined ? '—' : formatAmount(wholeFigure(limit.daily_limit), currency)}
              </Text>
              {limit !== undefined && (
                <Text style={{ fontFamily: font.sans, fontSize: 12, color: colors.text3 }}>a day</Text>
              )}
            </View>
          </View>
        );
      })}
      {data.tier === 0 && (
        <Text style={[styles.hint, { color: colors.text3 }]}>
          Verify your BVN to move to Tier 2 and unlock a dollar card.
        </Text>
      )}
      {data.tier === 1 && (
        <Text style={[styles.hint, { color: colors.text3 }]}>
          Tier 3 needs your address verified. Contact support to request it.
        </Text>
      )}
    </Panel>
  );
}
