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

  /*
   * WHAT SOMEBODY HERE CAN ACTUALLY FUND WITH — data, not a `switch`.
   *
   * This screen offered one thing: Activate account, which issues a Nigerian
   * NUBAN. So a customer in Accra opened the page they go to in order to put
   * money in and was offered a bank account they cannot pay into. 051 puts
   * the answer on the country row, and it is an ARRAY because a country can
   * have both — the day Paystack issues dedicated accounts in Ghana an
   * operator adds one entry and this screen offers it on the next load.
   *
   * Falls back to NOTHING rather than to a NUBAN. Offering nothing for a
   * moment is a blank space; offering the wrong rail is a customer sending
   * money into the void.
   */
  const session = useLoad(() => client.currentSession(), [client]);
  const countries = useLoad(() => client.session.countries(), [client]);
  const here = countries.data?.find((c) => c.code === session.data?.country);
  const funding = here?.funding_methods ?? [];
  const canIssueAccount = funding.includes('virtual_account');
  const usesMobileMoney = funding.includes('mobile_money');

  const has = account.data != null;

  return (
    <Shell back="/wallet" title="Add Money">
      <Panel title="Add Money">
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
              {/*
                THE NAME ON TOP, INSIDE THE SAME BOX AS THE NUMBER.

                It was a line of prose UNDER the box, which splits the three
                things a customer copies into their banking app across two
                containers and puts the one they are asked for FIRST last. A
                beneficiary is a name, a bank and a number, read together.
              */}
              <Text style={styles.muted} selectable>
                {account.data.account_name}
              </Text>
              <Text style={[styles.amount, { fontSize: 22 }]} selectable>
                {account.data.account_number}
              </Text>
              <Text style={styles.muted}>{account.data.bank_name}</Text>
            </View>

            <Text style={styles.hint}>Transfer money to fund your wallet</Text>

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
        {!account.loading && !has && canIssueAccount && (
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

        {/*
          MOBILE MONEY, AND WHAT IS HONEST TO SAY ABOUT IT TODAY.

          In Ghana and Kenya money moves through a mobile money wallet, so
          this screen has to say something true to a customer there rather
          than offering them a Nigerian account number.

          IT DOES NOT OFFER A BUTTON THAT DOES NOTHING. Linking a momo wallet
          as a standing funding instrument is a provider integration that does
          not exist here yet, and a Link button that opened nothing would be
          the exact failure a filled box on an operations screen is: it reads
          as something that is running. So it names the routes that DO reach a
          wallet here today, every one of which is built.
        */}
        {!account.loading && usesMobileMoney && !canIssueAccount && (
          <View style={{ gap: space.md, marginTop: space.md }}>
            <Text style={[styles.h2, { marginBottom: 0 }]}>
              In {here?.name ?? 'your country'}, money reaches your wallet
              these ways today.
            </Text>
            <Text style={styles.lead}>
              Another Xetral customer sending to your phone number — it arrives
              in {here?.currency ?? 'your currency'}. Your payment link, for
              anyone not on Xetral. And crypto: Bitcoin, USDT and USDC.
            </Text>
            <Text style={styles.hint}>
              A local mobile money top-up is not open here yet. We will say so
              on this screen the moment it is, rather than showing a button
              that does nothing.
            </Text>
          </View>
        )}

        {/* Neither rail — a real state and a temporary one. An operator can
            open a country before its funding rail is arranged, and a customer
            there should be told rather than shown an empty screen. */}
        {!account.loading && !canIssueAccount && !usesMobileMoney && !countries.loading && (
          <Text style={styles.hint}>
            Adding money is not open in {here?.name ?? 'your country'} yet. You
            can still be paid by another Xetral customer, through your payment
            link, or in crypto.
          </Text>
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
