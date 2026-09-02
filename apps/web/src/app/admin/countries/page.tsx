'use client';

import { useState } from 'react';
import type { AdminCountry } from '@xetral/client';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { Select } from '@/ui/select';
import { useAdmin, useLoad, useSubmit } from '@/lib/hooks';

/**
 * WHERE XETRAL OPERATES, without a deploy.
 *
 * Adding Rwanda used to be a code change in three places — a currency
 * constant in `wallet.service.ts`, a literal list in the activity rail, and a
 * signup form that asked for neither a country nor a phone. It is a row now.
 *
 * WHAT THIS SCREEN CANNOT DO, and the refusal is the point: it cannot invent
 * a CURRENCY. The picker offers what the money registry holds, because a
 * currency has an EXPONENT — the power of ten between what is stored and what
 * a customer reads — and one typed into a form would have none. Every amount
 * in it would be wrong by a factor of a hundred, silently, in the direction of
 * paying out too much. A country whose currency is not here needs one code
 * change; the screen says so rather than letting it be created broken.
 */
export default function Countries() {
  const admin = useAdmin();
  const state = useLoad(() => admin.countries(), [admin]);

  return (
    <>
      <div className="panel">
        <h1>Countries</h1>
        <p className="lead">Where somebody can open an account.</p>

        {state.loading && <p className="spinner">Loading…</p>}
        <FormError error={state.error} code={state.code} />

        {state.data?.countries.map((country) => (
          <Row key={country.code} country={country} onChange={state.reload} />
        ))}
      </div>

      <Add
        currencies={state.data?.currencies ?? []}
        onAdded={state.reload}
      />
    </>
  );
}

function Row({ country, onChange }: { country: AdminCountry; onChange: () => void }) {
  const admin = useAdmin();
  const { busy, error, code, run } = useSubmit();

  return (
    <div className="row">
      <span>
        <span className="mono">{country.code}</span> {country.name}{' '}
        <span className="muted">+{country.dial_code} · {country.currency}</span>
        {!country.enabled && <> <span className="badge warn">closed</span></>}
        {/*
          The refusal in full. The database names which ceiling or threshold
          is missing — "GHS has a daily limit at 0 of 3 tiers" — and that is
          the whole of what an operator needs. A generic message would send
          them to read the migration.
        */}
        <FormError error={error} code={code} />
      </span>
      <button
        type="button"
        className={country.enabled ? 'ghost small' : 'small'}
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await admin.setCountryEnabled(country.code, !country.enabled);
            onChange();
            return country.enabled ? `${country.name} closed.` : `${country.name} is open.`;
          })
        }
      >
        {busy ? 'Working…' : country.enabled ? 'Close' : 'Open'}
      </button>
    </div>
  );
}

function Add({
  currencies,
  onAdded,
}: {
  currencies: readonly { code: string; name: string }[];
  onAdded: () => void;
}) {
  const admin = useAdmin();
  const { busy, error, code: errorCode, done, run } = useSubmit();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [dialCode, setDialCode] = useState('');
  const [currency, setCurrency] = useState('');

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await admin.addCountry({ code, name, dialCode, currency });
          setCode('');
          setName('');
          setDialCode('');
          setCurrency('');
          onAdded();
          return `${name} added. Open it when its currency has limits.`;
        });
      }}
    >
      <h2>Add a country</h2>
      <p className="lead">It is added closed. Opening it is a separate decision.</p>

      <div className="field-row two">
        <label>
          ISO code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 2))}
            placeholder="RW"
            required
            minLength={2}
          />
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rwanda" required />
        </label>
      </div>

      <div className="field-row two">
        <label>
          Dialling code
          <input
            value={dialCode}
            // Digits only, and no plus — the plus is drawn by the signup form
            // in front of the field, so storing one would render "++250".
            onChange={(e) => setDialCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
            placeholder="250"
            required
          />
        </label>

        <label id="country-currency">
          Currency
          <Select
            labelledBy="country-currency"
            value={currency}
            onChange={setCurrency}
            placeholder="Pick one"
            options={currencies.map((c) => ({ value: c.code, label: c.code, hint: c.name }))}
          />
        </label>
      </div>

      <p className="hint">
        <Icon name="info" size={14} /> Only currencies Xetral already handles are
        listed. A new one is a code change: it needs an exponent, a daily limit
        at every tier and a monitoring threshold before a country can use it.
      </p>

      <button type="submit" disabled={busy || code.length !== 2 || currency === ''}>
        {busy ? 'Adding…' : 'Add country'}
      </button>

      <FormError error={error} code={errorCode} />
      {done !== undefined && <p className="ok">{done}</p>}
    </form>
  );
}
