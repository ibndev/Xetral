'use client';

import { useEffect, useState } from 'react';
import { formatAmount, PURCHASE_SERVICES } from '@xetral/client';
import type { CatalogueItem, Purchase, PurchaseService } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Select } from '@/ui/select';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { messageFor } from '@/lib/errors';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/lib/hooks';
import { Toast } from '@/ui/toast';

/**
 * Airtime, data, bills, eSIMs and virtual numbers.
 *
 * Five services behind one form, because from the customer's side they are the
 * same act: pick a thing, say who it is for, pay. The differences between
 * VTpass, Airalo and Twilio are absorbed by their adapters and stop there —
 * which is the whole point of the port, and it would be undone by three
 * screens that each knew which provider they were talking to.
 */
/* One list, in `@xetral/client`. It was written out here and again on the
 * phone — the same duplication that let the crypto screen's chain names drift
 * from the schema for the whole life of that feature. */
const SERVICES = PURCHASE_SERVICES;

type ServiceCode = PurchaseService['code'];

export default function Bills() {
  const client = useXetral();
  const [service, setService] = useState<ServiceCode>('airtime');
  const history = useLoad(() => client.purchases(), [client]);

  return (
    <Shell>

      <div className="tabs">
        {SERVICES.map((s) => (
          <a
            key={s.code}
            href="#"
            className={s.code === service ? 'active' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setService(s.code);
            }}
          >
            {s.label}
          </a>
        ))}
      </div>

      <Buy service={service} onBought={history.reload} />

      <div className="card">
        <h2>Recent purchases</h2>
        {history.loading && <p className="spinner">Loading…</p>}
        {history.data !== undefined && history.data.length === 0 && (
          <p className="empty">Nothing yet.</p>
        )}
        {history.data?.map((purchase) => (
          <PurchaseRow key={purchase.id} purchase={purchase} />
        ))}
      </div>
    </Shell>
  );
}

function Buy({ service, onBought }: { service: ServiceCode; onBought: () => void }) {
  const client = useXetral();
  const meta = SERVICES.find((s) => s.code === service);
  const [items, setItems] = useState<readonly CatalogueItem[]>([]);
  const [catalogueError, setCatalogueError] = useState<string | undefined>();
  const [itemCode, setItemCode] = useState('');
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');
  const [verified, setVerified] = useState<string | undefined>();
  const attempt = useIdempotencyKey();
  const { busy, error, code, done, run, clear } = useSubmit();

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    setItemCode('');
    setVerified(undefined);
    setCatalogueError(undefined);

    void (async () => {
      try {
        const loaded = await client.catalogue(service);
        if (!cancelled) {
          setItems(loaded);
          setItemCode(loaded[0]?.code ?? '');
        }
      } catch (cause) {
        // A catalogue that will not load is a configured-provider problem, and
        // saying so beats an empty dropdown the customer keeps tapping.
        if (!cancelled) setCatalogueError(messageFor(cause));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, service]);

  const selected = items.find((i) => i.code === itemCode);
  // A fixed-price item has nothing for the customer to type; a variable one
  // (airtime, electricity) does. Showing an amount box for a ₦500 data bundle
  // invites somebody to type a different number and be confused when it is
  // ignored.
  const fixedPrice = selected?.price !== null && selected?.price !== undefined;

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const purchase = await client.buy({
            service,
            itemCode,
            target,
            amount: fixedPrice ? (selected?.price ?? '') : amount,
            pin,
            idempotencyKey: attempt.key,
          });
          attempt.next();
          setPin('');
          onBought();
          return purchase.status === 'delivered'
            ? 'Done.'
            : 'Submitted. We will confirm shortly.';
        });
      }}
    >
      <h1>{meta?.label}</h1>

      {catalogueError !== undefined && (
        <div className="notice warn">
          <p>{catalogueError}</p>
        </div>
      )}

      <label id="bills-item-label">
        What to buy
        <Select
          labelledBy="bills-item-label"
          value={itemCode}
          placeholder={items.length === 0 ? 'Nothing available' : 'Choose one'}
          disabled={items.length === 0}
          onChange={setItemCode}
          options={items.map((item) => ({
            value: item.code,
            label: item.name,
            // The price on its own line rather than appended to the name. In a
            // native option it had to be one string; here it can be what it
            // is, which matters most on the longest catalogue — data bundles.
            ...(item.price === null ? {} : { hint: formatAmount(item.price, item.currency) }),
          }))}
        />
      </label>

      <label>
        {meta?.target}
        <input
          inputMode={meta?.mode === 'tel' ? 'tel' : meta?.mode === 'numeric' ? 'numeric' : 'text'}
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setVerified(undefined);
          }}
          required
        />
      </label>

      {/*
        Verification is offered, not assumed. VTpass can confirm a meter belongs
        to who the customer thinks it does; Airalo and Twilio have nothing to
        confirm, and the server says so rather than pretending — so a failure
        here is information, not a blocker.
      */}
      {(service === 'electricity' || service === 'data') && (
        <div className="actions" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="ghost small"
            disabled={target === '' || itemCode === ''}
            onClick={() =>
              void run(async () => {
                const result = await client.verifyTarget({ service, itemCode, target });
                setVerified(result.name);
                return undefined;
              })
            }
          >
            Check this number
          </button>
          {verified !== undefined && <span className="badge ok">{verified}</span>}
        </div>
      )}

      {!fixedPrice && (
        <label>
          Amount
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </label>
      )}

      <label>
        Transaction PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          required
        />
      </label>

      <button type="submit" disabled={busy || itemCode === ''}>
        {busy ? 'Working…' : 'Buy'}
      </button>

      <FormError error={error} code={code} />
      {done !== undefined && <p className="ok">{done}</p>}

        {/*
          OVER the form as well as in it. Buying a bill, some airtime or an eSIM moves money, and
          the outcome has to be unmistakable on a phone where the keyboard is
          closing over the line above. The inline copy stays, so a refusal can
          still be re-read after this has gone.
        */}
        <Toast message={done} tone="ok" onDone={clear} />
        <Toast message={error} tone="bad" onDone={clear} />
    </form>
  );
}

function PurchaseRow({ purchase }: { purchase: Purchase }) {
  const badge =
    purchase.status === 'delivered'
      ? 'ok'
      : purchase.status === 'failed' || purchase.status === 'reversed'
        ? 'danger'
        : 'warn';

  return (
    <div className="row">
      <span>
        {purchase.service} · <span className="mono">{purchase.target}</span>
        {/*
          A held purchase is not a failure and must not read as one. The money
          is reserved and a person or a sweep will resolve it — telling the
          customer it failed would have them buy it a second time.
        */}
        {purchase.status === 'reserved' && (
          <div className="hint">Waiting on the provider. Your money is held, not spent.</div>
        )}
        {purchase.failure_reason !== null && (
          <div className="hint">{purchase.failure_reason}</div>
        )}
        {purchase.delivery !== null && (
          <div className="hint mono">
            {Object.entries(purchase.delivery).map(([k, v]) => (
              <div key={k}>
                {k}: {v}
              </div>
            ))}
          </div>
        )}
      </span>
      <span className="nowrap">
        <span className="amount">{formatAmount(purchase.amount, purchase.currency)}</span>{' '}
        <span className={`badge ${badge}`}>{purchase.status}</span>
      </span>
    </div>
  );
}
