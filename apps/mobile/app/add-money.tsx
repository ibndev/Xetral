import { Text, View } from 'react-native';
import type { VirtualAccount } from '@xetral/client';
import { Shell } from '@/shell';
import { FormError, Loading, Panel, VerifyPrompt } from '@/ui';
import { useLoad, useXetral } from '@/hooks';
import { space, useStyles, useTheme } from '@/theme';

/**
 * The customer's dedicated Nigerian account number.
 *
 * Idempotent by construction on the server: one live account per customer per
 * currency, so opening this screen repeatedly returns the SAME number rather
 * than issuing another. That matters more than it looks — a customer saves it
 * as a bank beneficiary and pays into it for years, so the row is immutable
 * and a second one would silently split their deposits.
 */
export default function AddMoney() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const account = useLoad<VirtualAccount>(() => client.fundingAccount(), [client]);

  if (account.code === 'kyc_required') {
    return (
      <Shell back="/wallet" title="Add money">
        <VerifyPrompt what="a Nigerian account number" />
      </Shell>
    );
  }

  return (
    <Shell back="/wallet" title="Add money">
      <Panel title="Add money" subtitle="Transfer from any Nigerian bank">
        {account.loading && <Loading />}

        {account.data !== undefined && (
          <>
            <View
              style={{
                marginTop: space.sm,
                padding: space.md,
                borderRadius: 14,
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

        <FormError error={account.error} code={account.code} />
      </Panel>
    </Shell>
  );
}
