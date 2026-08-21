/**
 * Seeds one customer with a password, a PIN, a dedicated NGN account and some
 * money — so there is something to look at before a sign-up screen exists.
 *
 * The money is added by writing real journal entries, not by setting a balance
 * column: balances are maintained by trigger, and a row that disagreed with
 * its postings is exactly what `ledger_drift` exists to catch.
 */
import pg from 'pg';
import { scrypt as scryptCb, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const connectionString =
  process.env.DATABASE_URL ?? 'postgres://localhost/xetral';
const pool = new pg.Pool({ connectionString });

/** Matches secret-hash.ts exactly: v1:scrypt:N:r:p:salt:key, base64url. */
async function hash(secret) {
  const n = 32768, r = 8, p = 1;
  const salt = randomBytes(16);
  const key = await scrypt(secret, salt, 32, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
  return ['v1', 'scrypt', n, r, p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

async function account(kind, owner, currency, normal) {
  const found = await pool.query(
    `SELECT id FROM accounts WHERE kind=$1::account_kind AND currency=$2
       AND owner_id IS NOT DISTINCT FROM $3`,
    [kind, currency, owner],
  );
  if (found.rows[0]) return found.rows[0].id;
  const made = await pool.query(
    `INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
     VALUES ($1::account_kind, $2, $3, $4, $5) RETURNING id`,
    [kind, owner === null ? null : 'user', owner, currency, normal],
  );
  return made.rows[0].id;
}

/** One TRANSACTION per entry: the balance check is a deferred constraint
 *  trigger, so inserting legs in autocommit fires it after the first one. */
async function entry(key, kind, description, legs) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const e = await client.query(
      `INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
       VALUES ($1,$2::entry_kind,$3,now()) RETURNING id`,
      [key, kind, description],
    );
    for (const [accId, amount, currency] of legs) {
      await client.query(
        `INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
         VALUES ($1,$2,$3,$4)`,
        [e.rows[0].id, accId, amount, currency],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const stamp = Date.now();
const email = `demo-${stamp}@example.ng`;

const u = await pool.query(
  `INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`,
  [email],
);
const userId = u.rows[0].id;

await pool.query(`INSERT INTO user_credentials (user_id,password_hash) VALUES ($1,$2)`, [
  userId,
  await hash('a-long-enough-password'),
]);
await pool.query(`INSERT INTO transaction_pins (user_id,pin_hash) VALUES ($1,$2)`, [
  userId,
  await hash('374915'),
]);
await pool.query(
  `INSERT INTO provider_customers (user_id,provider,provider_customer_id) VALUES ($1,'bitnob',$2)`,
  [userId, `cus_${userId}`],
);
await pool.query(
  `INSERT INTO virtual_accounts
     (user_id, provider_account_id, account_number, bank_name, account_name, status)
   VALUES ($1,$2,$3,'Providus Bank','XETRAL/DEMO CUSTOMER','active')`,
  [userId, `bva_${stamp}`, String(9900000000 + (stamp % 99999999))],
);

const ngnWallet = await account('customer_wallet', userId, 'NGN', 'credit');
const ngnFloat = await account('provider_float', null, 'NGN', 'debit');
const usdtWallet = await account('customer_wallet', userId, 'USDT', 'credit');
const usdtPending = await account('customer_pending', userId, 'USDT', 'credit');
const usdtFloat = await account('provider_float', null, 'USDT', 'debit');

await entry(`seed:${stamp}:1`, 'wallet_funding', 'Deposit from GTBank',
  [[ngnWallet, 48500000, 'NGN'], [ngnFloat, -48500000, 'NGN']]);
await entry(`seed:${stamp}:2`, 'bill_payment', 'MTN 5GB data',
  [[ngnWallet, -250000, 'NGN'], [ngnFloat, 250000, 'NGN']]);
// A crypto deposit still maturing: visible, and deliberately not spendable.
await entry(`seed:${stamp}:3`, 'crypto_deposit', 'USDT deposit seen on Tron',
  [[usdtPending, 150000000, 'USDT'], [usdtFloat, -150000000, 'USDT']]);
await entry(`seed:${stamp}:4`, 'crypto_deposit', 'USDT deposit confirmed',
  [[usdtWallet, 320000000, 'USDT'], [usdtFloat, -320000000, 'USDT']]);

console.log(`
  email     ${email}
  password  a-long-enough-password
  PIN       374915
`);

await pool.end();
