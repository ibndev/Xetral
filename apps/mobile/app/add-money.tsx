import { Text, View } from 'react-native';
import { formatAmount } from '@xetral/client';
import type { Deposit, KycLimits, VirtualAccount } from '@xetral/client';
import { Icon } from '@/icon';
import { Shell } from '@/shell';
import { Empty, FormError, Loading, Panel } from '@/ui';
import { useLoad, useXetral } from '@/hooks';
import { radius, space, useStyles, useTheme } from '@/theme';

/**
 * Adding money, and WHAT IS AND IS NOT GATED ON VERIFICATION.
 *
 * This screen used to be a wall: unverified, it returned `VerifyPrompt` and
 * NOTHING ELSE — on the screen somebody opens in order to put money in. It
 * read as "you may not deposit until you verify", which is not true and is the
 * worst thing it could have said.
 *
 * WHAT IS ACTUALLY TRUE: an unverified account may hold and move ₦50,000 a
 * day. That is tier 0 in `029_kyc_tiers.seed.sql`, it has been the policy
 * since that migration landed, and nothing showed it to anybody. It is now the
 * first thing on the page, read from `/v1/kyc/limits` so it is the customer's
 * real ceiling rather than a number typed into a screen.
 *
 * WHAT GENUINELY IS GATED: a dedicated Nigerian account number is a BANK
 * ACCOUNT ISSUED IN A PERSON'S NAME. The provider will not create one without
 * a registered customer and Nigerian regulation does not permit an
 * unidentified one — the same `provider_customers` mapping that gates cards.
 * That is a fact about the rail rather than a policy this screen chose, so it
 * names the one thing that needs verifying and why.
 *
 * The deposit history is shown either way: a customer whose transfer has not
 * arrived needs it more than a verified one does.
 *
 * Idempotent by construction on the server — one live account per customer per
 * currency, so opening this repeatedly returns the SAME number rather than
 * issuing another. That matters: a customer saves it as a bank beneficiary and
 * pays into it for years, so a second one would silently split their deposits.
 */
export default function AddMoney() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();

  const account = useLoad<VirtualAccount>(() => client.fundingAccount(), [client]);
  const limits = useLoad<KycLimits>(() => client.kycLimits(), [client]);
  const deposits = useLoad<readonly Deposit[]>(() => client.deposits(), [client]);

  const ngn = limits.data?.limits.find((l) => l.currency === 'NGN');
  // The ONE code this screen answers itself. Anything else is a real failure
  // and goes to `FormError`, which carries its own next step.
  const needsVerifying = account.code === 'kyc_required';

  return (
    <Shell back="/wallet" title="Add money">
      <Panel title="Add money" subtitle="Transfer from any Nigerian bank">
        {ngn !== undefined && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              marginTop: space.sm,
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: colors.infoBg,
            }}
          >
            <Icon name="info" size={18} color={colors.info} />
            <Text style={[styles.hint, { flex: 1, marginTop: 0 }]}>
              Your account can receive and move up to{' '}
              <Text style={{ fontWeight: '700' }}>{formatAmount(ngn.daily_limit, 'NGN')}</Text>{' '}
              a day{limits.data?.tier === 0 ? ' without verifying your identity' : ''}.
            </Text>
          </View>
        )}

        {account.loading && <Loading />}

        {account.data !== undefined && (
          <>
            <View
              style={{
                marginTop: space.sm,
                padding: space.md,
                borderRadius: radius.md,
                backgroundColor: colors.surface2,
                gap: 4,
              }}
            >
              <Text style={[styles.amount, { fontSize: 22 }]} selectable>
                {account.data.account_number}
              </Text>
              <Text style={styles.muted}>{account.data.bank_name}</Text>
            </View>

            <Text style={styles.hint}>
              Send to <Text style={{ fontWeight: '700' }}>{account.data.account_name}</Text>.
              This account is yours permanently — save it as a beneficiary and money you
              send lands in your wallet automatically.
            </Text>

            {account.data.status !== 'active' && (
              <Text style={styles.hint}>
                Your account is still being activated. It will start accepting transfers
                shortly.
              </Text>
            )}
          </>
        )}

        {needsVerifying && (
          <View style={{ marginTop: space.md, gap: space.xs }}>
            <Text style={styles.h2}>Your own account number needs your identity</Text>
            <Text style={styles.lead}>
              A dedicated Nigerian account number is a bank account opened in your name,
              so the bank has to know whose it is. That is the one part of adding money
              that needs verifying — not the deposit itself.
            </Text>
          </View>
        )}

        {!needsVerifying && <FormError error={account.error} code={account.code} />}
      </Panel>

      <Panel title="Money received">
        {deposits.loading && <Loading />}
        {!deposits.loading && (deposits.data?.length ?? 0) === 0 && (
          <Empty
            icon="download"
            title="Nothing received yet"
            hint="Transfers into the account above show up here."
          />
        )}

        {(deposits.data ?? []).map((d) => (
          <View
            key={d.id}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: space.sm,
              paddingVertical: space.sm,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '600' }}>
                {d.sender_name ?? 'Bank transfer'}
              </Text>
              <Text style={styles.muted}>{new Date(d.created_at).toLocaleString()}</Text>
            </View>
            <Text style={styles.amount}>{formatAmount(d.amount, d.currency)}</Text>
          </View>
        ))}

        <FormError error={deposits.error} code={deposits.code} />
      </Panel>
    </Shell>
  );
}
