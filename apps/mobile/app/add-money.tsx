import { Text, View } from 'react-native';
import { formatAmount } from '@xetral/client';
import type { Deposit } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, FormError, Loading, Panel } from '@/ui';
import { useLoad, useSubmit, useXetral } from '@/hooks';
import { font, radius, space, useStyles, useTheme } from '@/theme';

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
  const { busy, error: issueError, code: issueCode, run } = useSubmit();

  /*
   * READ, don't issue — the same correction as the web's. This called
   * `fundingAccount()`, which asks Bitnob and opens a bank account, merely to
   * display a number: every visit to this screen opened an account as a side
   * effect of being looked at, and it was survivable only because issuing is
   * idempotent. Opening one is a BUTTON now, which is what it is.
   */
  const account = useLoad(() => client.existingFundingAccount(), [client]);
  const deposits = useLoad<readonly Deposit[]>(() => client.deposits(), [client]);

  const has = account.data != null;

  return (
    <Shell back="/wallet" title="Add money">
      <Panel title="Add money" subtitle="Transfer from any Nigerian bank">
        {account.loading && <Loading />}

        {account.data != null && (
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
              Send to <Text style={{ fontFamily: font.sansBold }}>{account.data.account_name}</Text>.
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

        {/*
          NO ACCOUNT YET — one button, and NO VERIFICATION GATE IN FRONT OF IT.

          This sent an unverified customer to /kyc first, on the reasoning
          that "regulation does not permit an unidentified account". That is a
          statement about BITNOB, which will not issue one without a verified
          BVN. CBN's tiered KYC permits a tier 1 account on a name and a phone
          number, capped — and `029_kyc_tiers.seed.sql` has capped tier 0 at
          ₦50,000 a day since it landed, so the platform enforced the ceiling
          and refused the account it is for.

          The requirement now lives in the Bitnob adapter, where it is true.
          The default rail opens an account from what signup already holds.
        */}
        {!account.loading && !has && (
          /*
            EACH PIECE IN ITS OWN ROW, WITH ROOM AROUND IT — the web's
            `.activate`, and the same reason. These were three siblings of a
            Panel whose spacing is set for the fields of a form, so the
            primary action on the screen a customer opens in order to put
            money in sat hard against a line of text either side of it.
          */
          <View style={{ gap: space.lg, marginTop: space.md }}>
            <Text style={[styles.h2, { marginBottom: 0 }]}>
              Your naira account is ready. Get it below.
            </Text>
            <Button
              label={busy ? 'Activating…' : 'Activate Account'}
              icon="arrowRight"
              busy={busy}
              onPress={() =>
                void run(async () => {
                  await client.fundingAccount();
                  account.reload();
                  return 'Your account is open.';
                })
              }
            />
            <FormError error={issueError} code={issueCode} />
          </View>
        )}

        <FormError error={account.error} code={account.code} />
      </Panel>

      {/*
        MONEY RECEIVED, ONLY WHEN THERE IS SOME. It was a second panel with an
        empty state on a screen whose job is to get money IN, so the commonest
        view was two boxes with one of them saying nothing. The history is not
        clutter — a customer whose transfer has not arrived needs it more than
        anybody — so it is removed exactly when it has nothing to say.
      */}
      {(deposits.data?.length ?? 0) > 0 && (
        <Panel title="Money received">
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
                <Text style={{ color: colors.text, fontFamily: font.sansSemi }}>
                  {d.sender_name ?? 'Bank transfer'}
                </Text>
                <Text style={styles.muted}>{new Date(d.created_at).toLocaleString()}</Text>
              </View>
              <Text style={styles.amount}>{formatAmount(d.amount, d.currency)}</Text>
            </View>
          ))}

          <FormError error={deposits.error} code={deposits.code} />
        </Panel>
      )}
    </Shell>
  );
}
